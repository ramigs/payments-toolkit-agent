import { describe, it, expect, vi } from 'vitest';
import type { Event } from '@google/adk';
import {
  createChatApp,
  type ChatRunner,
  type ChatMcpUi,
} from '../../src/app.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal ADK content event — enough for `toStructuredEvents` to emit one
 *  CONTENT structured event, which the route turns into text deltas. */
const contentEvent = (text: string): Event =>
  ({ actions: {}, content: { parts: [{ text }] } }) as unknown as Event;

/** Records session lifecycle calls so tests can assert cleanup. */
function makeSessionService(): ChatRunner['sessionService'] & {
  created: number;
  deleted: number;
} {
  const svc = {
    created: 0,
    deleted: 0,
    async createSession() {
      svc.created += 1;
      return { id: `sess-${svc.created}` };
    },
    async deleteSession() {
      svc.deleted += 1;
    },
  };
  return svc;
}

const noUi: ChatMcpUi = { forTool: async () => undefined };

/** RunAgentInput body the route accepts. */
const body = (runId: string, content = 'hi'): string =>
  JSON.stringify({
    threadId: `thread-${runId}`,
    runId,
    messages: [{ id: 'm1', role: 'user', content }],
    tools: [],
    context: [],
    state: {},
  });

const post = (path: string, init: RequestInit = {}): Request =>
  new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

interface SseEvent {
  type: string;
  message?: string;
  [k: string]: unknown;
}

/**
 * Drains an SSE `Response` body into the list of parsed AG-UI events. If
 * `onEvent` is supplied it runs after each event is appended — the hook a
 * test uses to fire a cancel mid-stream.
 */
async function readSse(
  res: Response,
  onEvent?: (ev: SseEvent, all: SseEvent[]) => void | Promise<void>,
): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const ev = JSON.parse(
        dataLine.slice(dataLine.indexOf(':') + 1),
      ) as SseEvent;
      events.push(ev);
      if (onEvent) await onEvent(ev, events);
    }
  }
  return events;
}

describe('POST /chat/:runId/cancel', () => {
  it('404s when no run with that id is in flight', async () => {
    const app = createChatApp({
      runner: {
        sessionService: makeSessionService(),
        // eslint-disable-next-line require-yield
        async *runAsync() {
          return;
        },
      },
      mcpUi: noUi,
    });

    const res = await app.request(post('/chat/never-started/cancel'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'No in-flight run with that runId.',
    });
  });
});

describe('POST /chat — normal completion', () => {
  it('streams RUN_STARTED..RUN_FINISHED and cleans up the registry', async () => {
    const sessionService = makeSessionService();
    const app = createChatApp({
      runner: {
        sessionService,
        async *runAsync() {
          yield contentEvent('Hello');
          yield contentEvent(' world');
        },
      },
      mcpUi: noUi,
    });

    const events = await readSse(
      await app.request(post('/chat', { body: body('r-ok') })),
    );
    const types = events.map((e) => e.type);

    expect(types[0]).toBe('RUN_STARTED');
    expect(types).toContain('RUN_FINISHED');
    expect(types).not.toContain('RUN_ERROR');
    expect(
      events
        .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
        .map((e) => e.delta)
        .join(''),
    ).toBe('Hello world');

    // Registry entry was removed in the stream's finally.
    const late = await app.request(post('/chat/r-ok/cancel'));
    expect(late.status).toBe(404);
    expect(sessionService.created).toBe(1);
    expect(sessionService.deleted).toBe(1);
  });
});

describe('POST /chat — explicit cancel mid-run', () => {
  it('aborts the turn, ends with RUN_ERROR "cancelled", and no RUN_FINISHED', async () => {
    const sessionService = makeSessionService();
    let yields = 0;
    let generatorReturned = false;

    const runner: ChatRunner = {
      sessionService,
      async *runAsync({ abortSignal }) {
        try {
          while (!abortSignal?.aborted) {
            yields += 1;
            yield contentEvent(`tick ${yields}`);
            await sleep(10);
          }
        } finally {
          generatorReturned = true;
        }
      },
    };

    const app = createChatApp({ runner, mcpUi: noUi });

    let cancelStatus = 0;
    const events = await readSse(
      await app.request(post('/chat', { body: body('r-cancel') })),
      async (ev) => {
        if (ev.type === 'TEXT_MESSAGE_CONTENT' && cancelStatus === 0) {
          const res = await app.request(post('/chat/r-cancel/cancel'));
          cancelStatus = res.status;
        }
      },
    );

    const types = events.map((e) => e.type);
    expect(cancelStatus).toBe(202);
    expect(types).not.toContain('RUN_FINISHED');
    expect(events.at(-1)).toEqual({ type: 'RUN_ERROR', message: 'cancelled' });
    expect(generatorReturned).toBe(true);

    // A second cancel finds nothing — the entry is gone.
    const again = await app.request(post('/chat/r-cancel/cancel'));
    expect(again.status).toBe(404);
    expect(sessionService.deleted).toBe(1);
  });
});

describe('POST /chat — client disconnect', () => {
  it('aborts the turn via c.req.raw.signal and cleans up', async () => {
    const sessionService = makeSessionService();
    let generatorReturned = false;

    const runner: ChatRunner = {
      sessionService,
      async *runAsync({ abortSignal }) {
        try {
          while (!abortSignal?.aborted) {
            yield contentEvent('tick');
            await sleep(10);
          }
        } finally {
          generatorReturned = true;
        }
      },
    };

    const app = createChatApp({ runner, mcpUi: noUi });
    const ac = new AbortController();

    const events = await readSse(
      await app.request(
        post('/chat', { body: body('r-disc'), signal: ac.signal }),
      ),
      (ev) => {
        if (ev.type === 'TEXT_MESSAGE_CONTENT') ac.abort();
      },
    );

    expect(events.map((e) => e.type)).not.toContain('RUN_FINISHED');
    expect(generatorReturned).toBe(true);
    expect(sessionService.deleted).toBe(1);

    // Nothing left registered under that runId.
    const late = await app.request(post('/chat/r-disc/cancel'));
    expect(late.status).toBe(404);
  });
});

describe('POST /chat — request validation', () => {
  it('400s on a non-JSON body', async () => {
    const app = createChatApp({
      runner: { sessionService: makeSessionService(), async *runAsync() {} },
      mcpUi: noUi,
    });
    const res = await app.request(post('/chat', { body: 'not json{' }));
    expect(res.status).toBe(400);
  });

  it('400s when no user message has text', async () => {
    const runAsync = vi.fn();
    const app = createChatApp({
      runner: {
        sessionService: makeSessionService(),
        runAsync: runAsync as unknown as ChatRunner['runAsync'],
      },
      mcpUi: noUi,
    });
    const res = await app.request(
      post('/chat', {
        body: JSON.stringify({
          threadId: 't',
          runId: 'r',
          messages: [{ id: 'm1', role: 'user', content: '   ' }],
          tools: [],
          context: [],
          state: {},
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(runAsync).not.toHaveBeenCalled();
  });
});
