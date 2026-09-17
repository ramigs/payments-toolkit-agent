# Eval journal

Running log of what the eval suite (`eval/scenarios.ts` +
`eval/run-eval.ts`) has actually found, kept as raw material for a
write-up later. Newest entries at the bottom. Each entry: what we saw,
why, what we changed, how we checked it.

## 2026-08-24 — first full run: flakiness vs. real findings

First run of all 12 scenarios: 7/12 passed. Before trusting the 5
failures, re-ran `pnpm start "What's the weather today?"` by hand three
times to see how stable a single scenario's outcome actually is:

- Run 1: "I can't help with that. I am scoped to payment-detail
  validation only..."
- Run 2: "I cannot answer questions about the weather. I am a
  payments-validation assistant scoped strictly to..."
- Run 3: "I can only help with validating payment details such as..."
- (During the original eval run, this same prompt produced a
  **completely empty** final response — confirmed via raw ADK event
  dump that the model can, on occasion, return an event with no text
  part at all for a no-tool-call turn.)

All three manual runs were individually correct but textually
different, and the original run got unlucky with an empty one. This is
exactly the run-to-run variance a single-sample-per-scenario eval is
exposed to (we deliberately chose not to build repeated-trial/pass-rate
scoring for the first version — see the "Eval hardening" TODO in the
README). Re-ran the full suite once more to separate real findings from
noise: 8/12 passed.

Real findings from the second run:

1. **`card-luhn-only` / `card-invalid-fidelity` failed on the tools
   axis.** Prompt asked only "Is X a valid card number?" (validity
   only), but the agent called `detect_card_type` in addition to
   `validate_card_number` every time — volunteering the network when it
   wasn't asked for. Consistent across scenarios, not a one-off.
2. **`ambiguous-clarify` failed as intended.** Prompt "Is 123456 valid?"
   — no domain specified, too short to be a real card number. Agent
   guessed it was a card number and called `validate_card_number`
   instead of asking what "123456" was supposed to be. This is the
   exact behavior the scenario was designed to catch.
3. **`multi-entity` failed on the tools axis** for the same reason as
   (1) — `detect_card_type` called unasked alongside the two tools that
   were actually relevant.

### Fix: tighten the system prompt (scope-creep on tool calls)

Decision: tighten the agent, not the scenarios. The extra
`detect_card_type` call is harmless with these three read-only tools,
but the underlying instinct ("call more than what was asked because it
seems related") is the failure mode that gets expensive/dangerous the
moment a tool has side effects. Added one explicit rule to
`SYSTEM_PROMPT` in `src/agent.ts`:

> Call only the tool(s) needed to answer what was actually asked... —
> don't also call detect_card_type unless the network was asked for too
> (or the request is genuinely unqualified, e.g. "check this card").

Added a scenario-ID filter to `run-eval.ts` (`pnpm run eval <id>
<id>...`) to verify targeted fixes without re-running (and re-paying
for) the whole suite. Verified against just `card-luhn-only` and
`card-invalid-fidelity`:

- `card-luhn-only`: tools axis now passes.
- `card-invalid-fidelity`: tools axis now passes, but the **response**
  axis newly failed.

### Bug found: in the eval harness itself, not the agent

`card-invalid-fidelity`'s response regex was `/invalid|not valid|fails/i`.
Actual agent response: _"No, 4111111111111112 is not a valid card
number."_ — contains "not **a** valid", not the literal substring "not
valid", so the regex missed a correct response. A concrete instance of
the heuristic-grading brittleness flagged as a known tradeoff when we
chose regex checks over an LLM-judge for the response axis.

Fix: `not valid` → `not\s+(a\s+)?valid` in both invalid-fidelity
scenarios (card and IBAN) in `eval/scenarios.ts`. Re-ran
`card-invalid-fidelity` alone: all three axes pass.

### Still open

- `multi-entity` — needs a re-check now that the system-prompt fix is
  in place; same over-calling pattern applied here too but wasn't
  re-verified yet.

## 2026-08-24 — fixing `ambiguous-clarify`: vague rule vs. concrete rule

The system prompt already had a rule telling the agent to ask a
clarifying question on ambiguous input ("If the input is ambiguous or
clearly malformed in a way the tools can't resolve... ask a clarifying
question instead of guessing"). The rule existed; the model didn't apply
it to "Is 123456 valid?" — it guessed card number and called
`validate_card_number` anyway. The rule was true but vague: it never
said _what_ counts as ambiguous for this domain, so the model had to
infer a threshold on its own, and its inferred threshold was looser than
intended.

Fix: replaced the vague rule with a concrete, checkable one — spelling
out that a value is ambiguous when the user doesn't say which type it
is _and_ the value itself doesn't clearly indicate one, with explicit
shape rules (card: 8-19 digits; IBAN: starts with 2 letters, ~15+
chars). Same lesson as the tool-scoping fix earlier: a concrete,
falsifiable rule outperforms a general instruction to "use good
judgment."

Verified against just `ambiguous-clarify` (`pnpm run eval
ambiguous-clarify`): all three axes pass. Actual response:

> The value `123456` is too short to be either a card number (which is
> typically 8–19 digits) or an IBAN (which starts with two letters and
> is at least 15 characters long).
>
> Could you please clarify whether you are trying to validate a card
> number or an IBAN?

`multi-entity` re-verified in isolation (`pnpm run eval multi-entity`):
all three axes pass — the tool-scoping fix covers this case too.

## 2026-08-24 — a full re-run surfaces a scenario-design smell, not a new bug

Ran the full 12-scenario suite once more to confirm everything held
together after both prompt fixes: 7/12 passed. Before treating any of
the 5 failures as new findings, checked which were consistent with the
already-documented single-run flakiness:

- `multi-entity` flipped to fail (no tool calls at all) despite passing
  cleanly moments earlier on the identical prompt in isolation.
- `out-of-scope-adjacent` and `ambiguous-clarify` failed on
  response-phrasing variance only (still declined / still asked a
  clarifying question, just didn't hit the exact regex this time).

All three: noise, consistent with the variance already logged above —
not re-litigated.

One failure was a real problem, but in the scenario, not the agent:
**`card-args-normalized`** failed its tools axis — expected
`[detect_card_type, validate_card_number]`, got only
`[validate_card_number]`. The scenario's actual purpose is checking
argument normalization (dashes stripped before the tool call), and its
`args` axis passed fine — the tools-axis assertion was testing something
unrelated (whether an unqualified "check this card" phrasing calls one
tool or two, the same ambiguity `card-check-both-tools` already covers)
and bolted onto a scenario that shouldn't have cared. Two unrelated
assertions coupled into one scenario meant the scenario's pass/fail was
at the mercy of the flakier of the two.

Fix: reworded the prompt from `"Check 4111-1111-1111-1111"` to `"Is
4111-1111-1111-1111 a valid card number?"` (same unambiguous
validity-only phrasing as `card-luhn-only`, which the tool-scoping fix
already made reliable) and narrowed `expectedTools` to
`['validate_card_number']` alone. The scenario now only asserts what it
was actually built to test.

### Still open

- Re-run `card-args-normalized` to confirm the reworded scenario is
  stable (not yet done — pausing further eval runs for now).

## 2026-08-29 — product change: report the card brand on a valid card

Not an eval finding — a deliberate behavior change. When the user asks
whether a card number is valid, the agent should now also name the card
network. Kept the "don't call what you weren't asked for" discipline
from the 2026-08-24 fixes by making it **conditional and sequential**
rather than reverting it: call `validate_card_number` first, and only
call `detect_card_type` if the number came back valid. An invalid
number stops at one tool and gets no brand mention — on an invalid PAN
the prefix may itself be a typo, so naming a network there is
misleading, not helpful.

`SYSTEM_PROMPT` in `src/agent.ts`: replaced the "call validate_card_number
alone for a validity question" rule with the validate-first-then-detect-
if-valid rule above, plus "name the card network in your answer".

Scenario updates (`eval/scenarios.ts`), to be verified on the next run:

- `card-luhn-only` → renamed `card-valid-reports-brand`; `expectedTools`
  now `[validate_card_number, detect_card_type]`, response must match
  `/visa/i` and exclude invalid.
- `card-check-both-tools` → response tightened from `/valid/i` to
  `/visa/i` + excludes invalid (brand must actually appear).
- `card-args-normalized` → `detect_card_type` added to `expectedTools`
  (4111…1111 is a valid Visa); arg-normalization assertion unchanged.
  Reworked the code comment — the one-tool-or-two decoupling rationale
  no longer applies.
- `card-invalid-fidelity` → `expectedTools` stays `[validate_card_number]`
  (now also a guard that an invalid number does *not* trigger a network
  lookup); `excludes` extended with the six network names.
- `multi-entity` → `detect_card_type` added; 5500…5559 is a valid
  Mastercard, response now expected to match `/mastercard/i`.
- `card-network-only`, `card-malformed-tool-error`, both IBAN scenarios,
  both out-of-scope scenarios, `ambiguous-clarify` — unaffected.

### Verified — full run, 12/12 passed

Ran the whole suite (`pnpm run eval`) right after the change. All 12
scenarios passed on all axes. The sequential validate-then-detect order
held everywhere it mattered:

- `card-invalid-fidelity`: on the invalid PAN the agent called
  `validate_card_number` only — no `detect_card_type`, no brand in the
  response.
- `multi-entity`: `validate_card_number` + `validate_iban` fired
  together first, then `detect_card_type` fired **after** the card came
  back valid — the conditional survived even with an IBAN check in the
  same turn.
- `card-network-only`: still `detect_card_type` alone.

Single-sample run, so the usual caveat about run-to-run variance
applies — but the invalid-number path calling only one tool is the
behavior the prompt now asks for, and it showed up cleanly.

## 2026-08-29 — extend the invalid-card gate to network-only questions

Follow-up to the change above. That change gated `detect_card_type` on a
passing Luhn check only for *validity* questions; a network-only prompt
("What card network is X from?") still called `detect_card_type` alone,
with no validation — so asking for the brand of an invalid card got a
confident "Visa" and no hint the number was bad.

Decision: `detect_card_type` should never run without a passing Luhn
check, whatever the user asked for. Merged the two card rules in
`SYSTEM_PROMPT` into one: for *any* card-number question — valid?,
network?, or both — call `validate_card_number` first; only if valid,
then `detect_card_type` + name the brand; if invalid, say so and stop,
"even when the network is all the user asked for".

Trade-off noted and accepted: a pure BIN-lookup question ("what bank
issues this range") is no longer answerable for a number that fails
Luhn. Fine for a validation-first assistant — an invalid PAN's prefix
may itself be a typo.

Scenario updates (`eval/scenarios.ts`):

- `card-network-only` → split into `card-network-valid` (valid PAN, now
  expects `[validate_card_number, detect_card_type]`) and
  `card-network-invalid` (invalid PAN, expects `[validate_card_number]`
  only, response matches invalid and excludes all six brand names).

### Verified

Ran the five card scenarios (`pnpm run eval card-network-valid
card-network-invalid card-valid-reports-brand card-check-both-tools
card-invalid-fidelity`): 5/5 passed.

- `card-network-invalid`: the agent called `validate_card_number` only,
  reported the number as invalid, and named no brand — the new guard
  holds.
- `card-network-valid`: still validates first, then `detect_card_type`,
  then names Visa — no regression to a single tool.

## 2026-08-29 — IBAN country in natural language, not a bare code

Reported behavior: "Is DE89370400440532013000 valid?" answered "The IBAN
is valid (Country: DE)." The `validate_iban` result carries the country
as an ISO code; the agent was relaying it verbatim as a "Country: DE"
field.

Fix (`SYSTEM_PROMPT` in `src/agent.ts`): added a response rule — refer
to the country by name with the code in parentheses, e.g. "Germany
(DE)", written into a sentence, not a bare field. No lookup table
needed; the model knows the ISO-3166 names.

Scenario update (`eval/scenarios.ts`): `iban-valid` response axis
tightened — `matches` changed from `/valid/i` (which also matched
"invalid" as a substring — the `excludes` was doing all the real work)
to `/germany/i`, and `excludes` grew a `country:\s*DE\b` clause to catch
a regression to the bare-code phrasing.

### Verified

Live run of "Is DE89 3704 0044 0532 0130 00 valid?" now answers "The
IBAN is valid and belongs to Germany (DE)." `iban-valid`,
`iban-invalid-fidelity`, and `multi-entity` all pass.
