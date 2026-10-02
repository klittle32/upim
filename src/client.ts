import { Clock, Deferred, Effect, Fiber, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ApiError, AuthError, TransportError, UsageError, type AppError } from "./errors.ts"
import { basicAuthorization, expiresAtFrom, passwordGrantBody, refreshGrantBody, TokenResponseSchema } from "./oauth.ts"
import { resolveUrl } from "./query.ts"
import type { Profile } from "./config.ts"
import { tokenIsFresh, type TokenSet } from "./tokens.ts"

export type Session = {
  profile: Profile
  readonly profileName: string
  tokens: TokenSet | undefined
  readonly save: (tokens: TokenSet | undefined) => Effect.Effect<void, AuthError>
}

export type CallInput = {
  readonly method: string
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  readonly body?: unknown
  readonly form?: Readonly<Record<string, string | File | undefined>>
  readonly headers?: Readonly<Record<string, string>>
  readonly auth?: boolean
  readonly followPages?: boolean
  readonly maxPages?: number
}

export type CallResult = {
  readonly status: number
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly notModified: boolean
}

const SKEW_MS = 60_000
const MAX_429 = 5

export type HttpClientEnv = HttpClient.HttpClient

type TokenError = AuthError | TransportError | ApiError | UsageError

type TokenFlight = {
  readonly deferred: Deferred.Deferred<TokenSet, TokenError>
  waiters: number
  fiber?: Fiber.Fiber<boolean, never>
}

const flights = new Map<Session, TokenFlight>()

const headerValue = (headers: { readonly [key: string]: string }, name: string) => headers[name.toLowerCase()]

const retryDelay = (headers: { readonly [key: string]: string }, attempt: number, now: number) => {
  const header = headerValue(headers, "retry-after")
  if (header !== undefined) {
    const seconds = Number(header)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const when = Date.parse(header)
    if (!Number.isNaN(when)) return Math.max(0, when - now)
  }
  return Math.min(30_000, 2 ** attempt * 1000)
}

const parseBody = (status: number, text: string, contentType: string | undefined): unknown => {
  if (status === 304 || text.trim() === "") return status === 304 ? { notModified: true } : null
  const looksJson = (contentType ?? "").includes("json") || text.startsWith("{") || text.startsWith("[")
  if (!looksJson) return text
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const toTokenSet = (body: unknown, previous: TokenSet | undefined, now = Date.now()): TokenSet => {
  const decoded = Schema.decodeUnknownSync(TokenResponseSchema)(body)
  return {
    accessToken: decoded.access_token,
    refreshToken: decoded.refresh_token ?? previous?.refreshToken ?? "",
    tokenType: decoded.token_type ?? "Bearer",
    expiresAt: expiresAtFrom(decoded.expires_in, now)
  }
}

const sendRaw = (input: {
  readonly method: string
  readonly url: URL
  readonly headers: Record<string, string>
  readonly body?: unknown
  readonly form?: CallInput["form"]
}) =>
  Effect.gen(function*() {
    let request = HttpClientRequest.make(input.method.toUpperCase() as "GET")(input.url, {
      acceptJson: true,
      headers: input.headers
    })
    if (input.form !== undefined) {
      const entries: Record<string, string | File> = {}
      for (const [key, value] of Object.entries(input.form)) {
        if (value !== undefined) entries[key] = value
      }
      request = HttpClientRequest.bodyFormDataRecord(request, entries)
    } else if (input.body !== undefined) {
      request = yield* HttpClientRequest.bodyJson(request, input.body).pipe(
        Effect.mapError((error) => new UsageError({ message: `Could not encode JSON body: ${String(error)}` }))
      )
    }
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError((error) => new TransportError({ message: `Request failed: ${String(error)}` }))
    )
    const text = yield* response.text.pipe(
      Effect.mapError((error) => new TransportError({ message: `Could not read response body: ${String(error)}` }))
    )
    const headers: Record<string, string> = { ...response.headers }
    return {
      status: response.status,
      url: response.url || input.url.toString(),
      headers,
      body: parseBody(response.status, text, headerValue(headers, "content-type")),
      notModified: response.status === 304
    } satisfies CallResult
  })

const tokenRequest = (session: Session, body: unknown) =>
  with429(sendRaw({
    method: "POST",
    url: resolveUrl(session.profile.baseUrl, "/oauth/token", {}),
    headers: {
      authorization: basicAuthorization(session.profile.clientId, session.profile.clientSecret),
      "content-type": "application/json"
    },
    body
  })).pipe(
    Effect.flatMap((result): Effect.Effect<TokenSet, AuthError | ApiError, never> => {
      if (result.status === 429) {
        return Effect.fail(new ApiError({
          message: "OAuth token endpoint rate limit exceeded",
          status: result.status,
          method: "POST",
          url: result.url,
          body: result.body
        }))
      }
      if (result.status < 200 || result.status >= 300) {
        return Effect.fail(new AuthError({
          message: `OAuth token request failed with HTTP ${result.status}`,
          details: result.body
        }))
      }
      return Effect.try({
        try: () => toTokenSet(result.body, session.tokens),
        catch: (error) => new AuthError({ message: `Unexpected token response: ${String(error)}`, details: result.body })
      })
    })
  )

const passwordGrant = (session: Session) => {
  const username = session.profile.username
  const password = session.profile.password
  if (!username || password === undefined || password === "") {
    return Effect.fail(new AuthError({
      message: "No usable token and no username/password. Run `upim auth login` or set UPIM_USERNAME and UPIM_PASSWORD."
    }))
  }
  return tokenRequest(session, passwordGrantBody(username, password))
}

const refreshGrant = (session: Session, refreshToken: string) =>
  tokenRequest(session, refreshGrantBody(refreshToken)).pipe(
    Effect.catch((error: AuthError | ApiError | TransportError | UsageError) => {
      if (error._tag === "AuthError" && session.profile.password && session.profile.username) {
        return passwordGrant(session)
      }
      return Effect.fail(error)
    })
  )

const acquireTokens = (session: Session, force: boolean) => {
  const current = session.tokens
  const effect = current?.refreshToken && (!force || current.refreshToken !== "")
    ? refreshGrant(session, current.refreshToken)
    : passwordGrant(session)
  return effect.pipe(Effect.tap((tokens) => {
    session.tokens = tokens
    return session.save(tokens)
  }))
}

const releaseFlight = (session: Session, flight: TokenFlight) =>
  Effect.uninterruptible(Effect.gen(function*() {
    const stop = yield* Effect.sync(() => {
      flight.waiters--
      if (flight.waiters > 0) return false
      if (flights.get(session) === flight) flights.delete(session)
      return !Deferred.isDoneUnsafe(flight.deferred)
    })
    if (!stop) return
    if (flight.fiber) yield* Fiber.interrupt(flight.fiber)
    yield* Deferred.interrupt(flight.deferred)
  }))

const obtainTokens = (session: Session, force: boolean) =>
  Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const current = session.tokens
    if (!force && current && tokenIsFresh(current, Date.now(), SKEW_MS)) {
      return current
    }
    const slot = yield* Effect.sync(() => {
      const existing = flights.get(session)
      if (existing) {
        existing.waiters++
        return { flight: existing, owner: false }
      }
      const flight: TokenFlight = {
        deferred: Deferred.makeUnsafe<TokenSet, TokenError>(),
        waiters: 1
      }
      flights.set(session, flight)
      return { flight, owner: true }
    })
    if (slot.owner) {
      const work = Deferred.complete(slot.flight.deferred, acquireTokens(session, force)).pipe(
        Effect.ensuring(Effect.sync(() => {
          if (flights.get(session) === slot.flight) flights.delete(session)
        }))
      )
      slot.flight.fiber = yield* Effect.forkDetach(work)
    }
    return yield* restore(Deferred.await(slot.flight.deferred)).pipe(
      Effect.onInterrupt(() => releaseFlight(session, slot.flight))
    )
  }))

const with429 = <E, R>(attempt: Effect.Effect<CallResult, E, R>, seen = 0): Effect.Effect<CallResult, E, R> =>
  Effect.flatMap(attempt, (result) => {
    if (result.status !== 429 || seen + 1 >= MAX_429) return Effect.succeed(result)
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Effect.sleep(retryDelay(result.headers, seen, now))),
      Effect.flatMap(() => with429(attempt, seen + 1))
    )
  })

const oneCall = (session: Session, input: CallInput, tokens: TokenSet | undefined) => {
  const headers: Record<string, string> = { ...(input.headers ?? {}) }
  if (input.auth !== false && tokens) headers.authorization = `Bearer ${tokens.accessToken}`
  return with429(sendRaw({
    method: input.method,
    url: resolveUrl(session.profile.baseUrl, input.path, input.query ?? {}),
    headers,
    body: input.body,
    form: input.form
  }))
}

const pointerFromErrors = (value: unknown, prefix: string[] = []): string | null => {
  if (typeof value !== "object" || value === null) return prefix.length > 0 ? `/${prefix.join("/")}` : null
  if (Array.isArray(value)) return prefix.length > 0 ? `/${prefix.join("/")}` : null
  const key = Object.keys(value)[0]
  if (key === undefined) return prefix.length > 0 ? `/${prefix.join("/")}` : null
  return pointerFromErrors((value as Record<string, unknown>)[key], [...prefix, key])
}

const asApiError = (input: CallInput, result: CallResult) => {
  const errors = typeof result.body === "object" && result.body !== null && "errors" in result.body
    ? (result.body as { errors?: unknown }).errors
    : undefined
  return new ApiError({
    message: typeof result.body === "object" && result.body !== null && "message" in result.body
      ? String((result.body as { message?: unknown }).message)
      : `HTTP ${result.status}`,
    status: result.status,
    method: input.method.toUpperCase(),
    url: result.url,
    body: result.body,
    ...(errors !== undefined ? { path: pointerFromErrors(errors) ?? undefined } : {})
  })
}

const interpret = (input: CallInput, result: CallResult) => {
  if (result.notModified || (result.status >= 200 && result.status < 300)) return Effect.succeed(result)
  return Effect.fail(asApiError(input, result))
}

const linkNext = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null || !("links" in body)) return undefined
  const next = (body as { links?: { next?: unknown } }).links?.next
  return typeof next === "string" && next !== "" ? next : undefined
}

const pageAll = (session: Session, input: CallInput, tokens: TokenSet, first: CallResult) =>
  Effect.gen(function*() {
    const maxPages = input.maxPages ?? 1000
    const items: unknown[] = []
    let page = first
    let count = 0
    const seen = new Set<string>()
    while (true) {
      count++
      if (page.notModified) break
      const data = typeof page.body === "object" && page.body !== null && "data" in page.body
        ? (page.body as { data?: unknown }).data
        : undefined
      if (!Array.isArray(data)) return first
      items.push(...data)
      const next = linkNext(page.body)
      if (next === undefined) break
      if (seen.has(next)) {
        return yield* new UsageError({
          message: `Pagination stopped because links.next repeated after ${count} page(s): ${next}. The catalog is incomplete.`
        })
      }
      if (count >= maxPages) {
        return yield* new UsageError({
          message: `Pagination stopped at the safety cap of ${maxPages} page(s) while links.next was still ${next}. The catalog is incomplete. Raise --max-pages, or resume with the page or search_after from that URL.`
        })
      }
      seen.add(next)
      page = yield* oneCall(session, { ...input, path: next, query: {}, body: undefined, form: undefined }, tokens)
      if (page.status === 401 || page.status === 429 || page.status < 200 || page.status >= 300) {
        return yield* interpret(input, page)
      }
    }
    return {
      ...page,
      body: { data: items, pages: count, links: { next: null } },
      notModified: false
    } satisfies CallResult
  })

export const call = (session: Session, input: CallInput): Effect.Effect<CallResult, AppError, HttpClientEnv> =>
  Effect.gen(function*() {
    if (input.body !== undefined && input.form !== undefined) {
      return yield* Effect.fail(new UsageError({ message: "Pass either a JSON body or form fields, not both" }))
    }
    const tokens = input.auth === false ? undefined : yield* obtainTokens(session, false)
    let result = yield* oneCall(session, input, tokens)
    if (result.status === 401 && input.auth !== false) {
      const refreshed = yield* obtainTokens(session, true)
      result = yield* oneCall(session, input, refreshed)
    }
    const interpreted = yield* interpret(input, result)
    if (!input.followPages || input.method.toUpperCase() !== "GET") return interpreted
    return yield* pageAll(session, input, session.tokens ?? tokens!, interpreted)
  })

export const login = (session: Session): Effect.Effect<TokenSet, AppError, HttpClientEnv> => obtainTokens(session, true)

export const logout = (session: Session) => {
  session.tokens = undefined
  return session.save(undefined)
}

export const resetAuthFlight = () => {
  flights.clear()
}

export const tokenFlightWaiters = (session: Session) => flights.get(session)?.waiters ?? 0
