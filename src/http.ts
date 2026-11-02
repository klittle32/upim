import { Duration, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { readEnv, RequestTimeoutEnv } from "./env.ts"
import { ConfigError } from "./errors.ts"

/** How long a request may wait for response headers before it fails, unless UPIM_TIMEOUT says otherwise. */
export const DEFAULT_TIMEOUT_SECONDS = 60

/**
 * Wrap the HttpClient so a request with no response headers after `timeout`
 * fails as a transport error instead of hanging the CLI on a stalled server.
 * The budget ends when headers arrive; reading the body is not covered.
 */
export const withRequestTimeout = (timeout: Duration.Input) =>
  Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, HttpClient.timeout(timeout)))

const requestTimeout = Effect.gen(function*() {
  const raw = yield* readEnv(RequestTimeoutEnv)
  if (Option.isNone(raw)) return Duration.seconds(DEFAULT_TIMEOUT_SECONDS)
  const seconds = Number(raw.value)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return yield* new ConfigError({
      message: `UPIM_TIMEOUT must be a positive number of seconds, not ${JSON.stringify(raw.value)}`
    })
  }
  return Duration.seconds(seconds)
})

/** The fetch-backed HttpClient with the configured request timeout. */
export const layer = Layer.unwrap(Effect.map(requestTimeout, withRequestTimeout)).pipe(
  Layer.provide(FetchHttpClient.layer)
)
