import { Context, type Deferred, type Fiber, Layer, Semaphore } from "effect"
import type { ApiError, AuthError, TransportError, UsageError } from "./errors.ts"
import type { TokenSet } from "./tokens.ts"

export type TokenError = AuthError | TransportError | ApiError | UsageError

/** One in-flight token request that overlapping callers in this process share. */
export type TokenFlight = {
  readonly deferred: Deferred.Deferred<TokenSet, TokenError>
  waiters: number
  fiber?: Fiber.Fiber<boolean, never>
}

/**
 * Process-wide coordination for token refreshes: one permit per token file so
 * fibers do not race each other for the file lock, and one shared flight per
 * session so overlapping calls wait on a single grant.
 */
export class TokenLocks extends Context.Service<TokenLocks, {
  readonly permit: (path: string) => Semaphore.Semaphore
  readonly flights: Map<object, TokenFlight>
}>()("upim/TokenLocks") {
  static readonly layer = Layer.sync(TokenLocks, () => {
    const permits = new Map<string, Semaphore.Semaphore>()
    return TokenLocks.of({
      permit: (path) => {
        const existing = permits.get(path)
        if (existing) return existing
        const created = Semaphore.makeUnsafe(1)
        permits.set(path, created)
        return created
      },
      flights: new Map()
    })
  })
}

/** Lock tunables. Tests shorten them; the CLI uses the defaults. */
export const LockSettings = Context.Reference<{
  /** A lock whose stamp is older than this was left by a dead or stalled process and may be taken over. */
  readonly staleMs: number
  /** Give up waiting for the lock after this long. */
  readonly waitMs: number
  /** Base interval between lock attempts. Jitter is added. */
  readonly pollMs: number
}>("upim/LockSettings", {
  defaultValue: () => ({ staleMs: 30_000, waitMs: 45_000, pollMs: 50 })
})
