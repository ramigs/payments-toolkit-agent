import { createRemoteJWKSet, jwtVerify } from 'jose';

/** The caller behind a verified bearer token. */
export interface AuthenticatedUser {
  /** Supabase user id (`sub` claim) — stable per user, safe to key quotas on. */
  userId: string;
}

/**
 * Verifies the value of a request's `Authorization` header. Resolves with the
 * caller's identity, or throws if the header is missing/malformed or the token
 * fails verification. The `/chat` middleware turns any throw into a 401, so the
 * failure reason is deliberately not surfaced to the client.
 *
 * Injected into `createChatApp` (like `runner` and `mcpUi`) so tests can pass a
 * stub instead of minting real JWTs.
 */
export type TokenVerifier = (
  authorization: string | undefined,
) => Promise<AuthenticatedUser>;

/**
 * A `TokenVerifier` backed by a Supabase project's JWKS.
 *
 * `jose` fetches the project's public signing keys from
 * `<supabaseUrl>/auth/v1/.well-known/jwks.json`, caches them, and refetches on
 * rotation — so each call is a local signature + claims check with no
 * per-request round-trip to Supabase. The trade-off is that a session revoked
 * in Supabase stays accepted here until the token's own `exp` (Supabase default
 * one hour); lower the project's JWT expiry if that window matters.
 */
export function createSupabaseTokenVerifier(
  supabaseUrl: string,
): TokenVerifier {
  const issuer = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async (authorization) => {
    const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new Error('no bearer token');

    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: 'authenticated',
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new Error('token has no subject');
    }
    return { userId: payload.sub };
  };
}
