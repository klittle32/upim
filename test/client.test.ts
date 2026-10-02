import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Fiber, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { call, login, resetAuthFlight, tokenFlightWaiters, type Session } from "../src/client.ts"
import { ApiError, AuthError, UsageError } from "../src/errors.ts"
import { basicAuthorization } from "../src/oauth.ts"
import type { TokenSet } from "../src/tokens.ts"

const execute = <A>(fetchImpl: typeof fetch, effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImpl))
  ))) as Effect.Effect<A>)

const profile = {
  baseUrl: "https://pim.example.com",
  clientId: "client",
  clientSecret: "secret",
  username: "robot",
  password: "pw"
}

const tokenBody = (access: string, refresh = "refresh-2") => JSON.stringify({
  token_type: "Bearer",
  expires_in: 3600,
  access_token: access,
  refresh_token: refresh
})

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  })

test("refreshes once after 401 and retries the original request", async () => {
  resetAuthFlight()
  const seen: string[] = []
  let saved: TokenSet | undefined = {
    accessToken: "expired",
    refreshToken: "refresh-1",
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000
  }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    seen.push(`${init?.method ?? "GET"} ${url}`)
    if (url.endsWith("/oauth/token")) {
      assert.equal(init?.method, "POST")
      const header = new Headers(init?.headers).get("authorization") ?? ""
      assert.match(header, /^Basic /)
      const body = JSON.parse(String(init?.body))
      assert.equal(body.grant_type, "refresh_token")
      assert.equal(body.refresh_token, "refresh-1")
      return new Response(tokenBody("fresh"), { status: 200, headers: { "content-type": "application/json" } })
    }
    const authorization = new Headers(init?.headers).get("authorization")
    if (authorization === "Bearer expired") return jsonResponse(401, { success: false, message: "expired" })
    assert.equal(authorization, "Bearer fresh")
    return jsonResponse(200, { data: [{ sku: "shirt" }] })
  }
  const session: Session = {
    profile,
    profileName: "default",
    tokens: saved,
    save: (tokens) => Effect.sync(() => {
      saved = tokens
    })
  }
  const result = await execute(fetchImpl, call(session, { method: "GET", path: "/api/v1/rest/products" }))
  assert.deepEqual(result.body, { data: [{ sku: "shirt" }] })
  assert.equal(saved?.accessToken, "fresh")
  assert.equal(seen.filter((line) => line.includes("/oauth/token")).length, 1)
})

test("backs off on 429 and then returns the success body", async () => {
  resetAuthFlight()
  let hits = 0
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/oauth/token")) {
      return new Response(tokenBody("fresh"), { status: 200, headers: { "content-type": "application/json" } })
    }
    hits++
    if (hits === 1) return jsonResponse(429, { message: "slow down" }, { "retry-after": "0" })
    return jsonResponse(200, { ok: true })
  }
  const session: Session = {
    profile,
    profileName: "default",
    tokens: {
      accessToken: "fresh",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000
    },
    save: () => Effect.void
  }
  const result = await execute(fetchImpl, call(session, { method: "GET", path: "/api/v1/rest/locales" }))
  assert.equal(result.status, 200)
  assert.equal(hits, 2)
})

const freshSession = (): Session => ({
  profile,
  profileName: "default",
  tokens: {
    accessToken: "fresh",
    refreshToken: "refresh-1",
    tokenType: "Bearer",
    expiresAt: Date.now() + 3_600_000
  },
  save: () => Effect.void
})

const collection = (data: readonly unknown[], next: string | null) =>
  jsonResponse(200, { data, links: { next } })

test("aggregates every page when links.next is exhausted", async () => {
  resetAuthFlight()
  const second = "https://pim.example.com/api/v1/rest/products?page=2"
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url === "https://pim.example.com/api/v1/rest/products") return collection([{ sku: "a" }], second)
    if (url === second) return collection([{ sku: "b" }], null)
    throw new Error(url)
  }
  const result = await execute(fetchImpl, call(freshSession(), {
    method: "GET",
    path: "/api/v1/rest/products",
    followPages: true,
    maxPages: 2
  }))
  assert.deepEqual(result.body, {
    data: [{ sku: "a" }, { sku: "b" }],
    pages: 2,
    links: { next: null }
  })
})

test("fails when maxPages leaves another page", async () => {
  resetAuthFlight()
  const second = "https://pim.example.com/api/v1/rest/products?page=2"
  let hits = 0
  const fetchImpl: typeof fetch = async (input) => {
    hits++
    const url = String(input)
    if (url === "https://pim.example.com/api/v1/rest/products") return collection([{ sku: "a" }], second)
    throw new Error(url)
  }
  await assert.rejects(
    () => execute(fetchImpl, call(freshSession(), {
      method: "GET",
      path: "/api/v1/rest/products",
      followPages: true,
      maxPages: 1
    })),
    (error: unknown) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /safety cap of 1 page/)
      assert.match(error.message, /incomplete/)
      assert.match(error.message, new RegExp(second.replace(/[?]/g, "\\?")))
      return true
    }
  )
  assert.equal(hits, 1)
})

test("fails when links.next repeats instead of reporting completion", async () => {
  resetAuthFlight()
  const second = "https://pim.example.com/api/v1/rest/products?page=2"
  let hits = 0
  const fetchImpl: typeof fetch = async (input) => {
    hits++
    const url = String(input)
    if (url === "https://pim.example.com/api/v1/rest/products") return collection([{ sku: "a" }], second)
    if (url === second) return collection([{ sku: "b" }], second)
    throw new Error(url)
  }
  await assert.rejects(
    () => execute(fetchImpl, call(freshSession(), {
      method: "GET",
      path: "/api/v1/rest/products",
      followPages: true
    })),
    (error: unknown) => {
      assert.ok(error instanceof UsageError)
      assert.match(error.message, /links\.next repeated after 2 page/)
      assert.match(error.message, /incomplete/)
      assert.match(error.message, new RegExp(second.replace(/[?]/g, "\\?")))
      return true
    }
  )
  assert.equal(hits, 2)
})

const staleTokens = (refreshToken: string): TokenSet => ({
  accessToken: "expired",
  refreshToken,
  tokenType: "Bearer",
  expiresAt: 0
})

const hold = () => {
  let release: () => void = () => {}
  let mark: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    mark = resolve
  })
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  return { started, open, mark, release }
}

test("shares one token request across overlapping calls for the same session", async () => {
  resetAuthFlight()
  const gate = hold()
  let oauthCalls = 0
  let saved: TokenSet | undefined
  const fetchImpl: typeof fetch = async (input) => {
    if (!String(input).endsWith("/oauth/token")) throw new Error(String(input))
    oauthCalls++
    gate.mark()
    await gate.open
    return new Response(tokenBody("shared"), { status: 200, headers: { "content-type": "application/json" } })
  }
  const session: Session = {
    profile,
    profileName: "default",
    tokens: staleTokens("refresh-1"),
    save: (tokens) => Effect.sync(() => {
      saved = tokens
    })
  }
  const tokens = await execute(fetchImpl, Effect.gen(function*() {
    const first = yield* Effect.forkChild(login(session))
    yield* Effect.promise(() => gate.started)
    const second = yield* Effect.forkChild(login(session))
    let waiters = 0
    for (let attempt = 0; attempt < 20 && waiters < 2; attempt++) {
      yield* Effect.yieldNow
      waiters = tokenFlightWaiters(session)
    }
    gate.release()
    const tokens = yield* Effect.all([
      Fiber.join(first),
      Fiber.join(second)
    ])
    return { tokens, waiters }
  }))
  assert.equal(tokens.waiters, 2)
  assert.equal(oauthCalls, 1)
  assert.equal(tokens.tokens[0].accessToken, "shared")
  assert.equal(tokens.tokens[1].accessToken, "shared")
  assert.equal(saved?.accessToken, "shared")
})

test("does not share token acquisition across sessions", async () => {
  resetAuthFlight()
  let pending = 0
  let release: () => void = () => {}
  let fail: (error: Error) => void = () => {}
  const timer = setTimeout(() => fail(new Error("timed out waiting for both sessions")), 1000)
  const bothStarted = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const seen: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!String(input).endsWith("/oauth/token")) throw new Error(String(input))
    const authorization = new Headers(init?.headers).get("authorization") ?? ""
    seen.push(authorization)
    pending++
    if (pending === 2) release()
    await bothStarted
    const access = authorization === basicAuthorization("client-a", "secret-a") ? "token-a" : "token-b"
    return new Response(tokenBody(access), { status: 200, headers: { "content-type": "application/json" } })
  }
  const saved = new Map<string, TokenSet | undefined>()
  const sessionFor = (name: string, clientId: string, clientSecret: string): Session => ({
    profile: { ...profile, clientId, clientSecret, password: undefined, username: undefined },
    profileName: name,
    tokens: staleTokens(`refresh-${name}`),
    save: (tokens) => Effect.sync(() => {
      saved.set(name, tokens)
    })
  })
  const left = sessionFor("left", "client-a", "secret-a")
  const right = sessionFor("right", "client-b", "secret-b")
  try {
    const tokens = await execute(fetchImpl, Effect.all([
      login(left),
      login(right)
    ], { concurrency: 2 }))
    assert.equal(pending, 2)
    assert.deepEqual(tokens.map((token) => token.accessToken).sort(), ["token-a", "token-b"])
    assert.equal(saved.get("left")?.accessToken, "token-a")
    assert.equal(saved.get("right")?.accessToken, "token-b")
    assert.equal(new Set(seen).size, 2)
  } finally {
    clearTimeout(timer)
  }
})

test("a failed token acquisition can be retried", async () => {
  resetAuthFlight()
  let oauthCalls = 0
  let saved: TokenSet | undefined
  const fetchImpl: typeof fetch = async (input) => {
    if (!String(input).endsWith("/oauth/token")) throw new Error(String(input))
    oauthCalls++
    if (oauthCalls === 1) return jsonResponse(401, { message: "nope" })
    return new Response(tokenBody("fresh"), { status: 200, headers: { "content-type": "application/json" } })
  }
  const session: Session = {
    profile: { ...profile, password: undefined, username: undefined },
    profileName: "default",
    tokens: staleTokens("refresh-1"),
    save: (tokens) => Effect.sync(() => {
      saved = tokens
    })
  }
  await assert.rejects(
    () => execute(fetchImpl, login(session)),
    (error: unknown) => error instanceof AuthError
  )
  const tokens = await execute(fetchImpl, login(session))
  assert.equal(oauthCalls, 2)
  assert.equal(tokens.accessToken, "fresh")
  assert.equal(saved?.accessToken, "fresh")
})

test("cancelling one overlapping caller leaves the other with the shared token", async () => {
  resetAuthFlight()
  const gate = hold()
  let oauthCalls = 0
  let saved: TokenSet | undefined
  const fetchImpl: typeof fetch = async (input) => {
    if (!String(input).endsWith("/oauth/token")) throw new Error(String(input))
    oauthCalls++
    gate.mark()
    await gate.open
    return new Response(tokenBody("shared"), { status: 200, headers: { "content-type": "application/json" } })
  }
  const session: Session = {
    profile: { ...profile, password: undefined, username: undefined },
    profileName: "default",
    tokens: staleTokens("refresh-1"),
    save: (tokens) => Effect.sync(() => {
      saved = tokens
    })
  }
  const tokens = await execute(fetchImpl, Effect.gen(function*() {
    const first = yield* Effect.forkChild(login(session))
    yield* Effect.promise(() => gate.started)
    const second = yield* Effect.forkChild(login(session))
    let waiters = 0
    for (let attempt = 0; attempt < 20 && waiters < 2; attempt++) {
      yield* Effect.yieldNow
      waiters = tokenFlightWaiters(session)
    }
    if (waiters < 2) gate.release()
    assert.equal(waiters, 2)
    yield* Fiber.interrupt(first)
    gate.release()
    return yield* Fiber.join(second)
  }))
  assert.equal(oauthCalls, 1)
  assert.equal(tokens.accessToken, "shared")
  assert.equal(saved?.accessToken, "shared")
})

const locales = { method: "GET", path: "/api/v1/rest/locales" } as const

const onClock = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(TestClock.layer()))

test("waits for a numeric Retry-After on the test clock", { timeout: 3000 }, async () => {
  resetAuthFlight()
  let hits = 0
  let mark: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    mark = resolve
  })
  const fetchImpl: typeof fetch = async () => {
    hits++
    if (hits === 1) {
      mark()
      return jsonResponse(429, { message: "slow" }, { "retry-after": "2" })
    }
    return jsonResponse(200, { ok: true })
  }
  const result = await execute(fetchImpl, onClock(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(call(freshSession(), locales))
    yield* Effect.promise(() => started)
    yield* TestClock.adjust("2 seconds")
    return yield* Fiber.join(fiber)
  })))
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true })
  assert.equal(hits, 2)
})

test("uses fallback backoff when Retry-After is absent", { timeout: 3000 }, async () => {
  resetAuthFlight()
  let hits = 0
  let mark: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    mark = resolve
  })
  const fetchImpl: typeof fetch = async () => {
    hits++
    if (hits === 1) {
      mark()
      return jsonResponse(429, { message: "slow" })
    }
    return jsonResponse(200, { ok: true })
  }
  const result = await execute(fetchImpl, onClock(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(call(freshSession(), locales))
    yield* Effect.promise(() => started)
    yield* TestClock.adjust("1 seconds")
    return yield* Fiber.join(fiber)
  })))
  assert.equal(result.status, 200)
  assert.equal(hits, 2)
})

test("waits until an HTTP-date Retry-After on the test clock", { timeout: 3000 }, async () => {
  resetAuthFlight()
  let hits = 0
  let mark: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    mark = resolve
  })
  const fetchImpl: typeof fetch = async () => {
    hits++
    if (hits === 1) {
      mark()
      return jsonResponse(429, { message: "slow" }, { "retry-after": new Date(5_000).toUTCString() })
    }
    return jsonResponse(200, { ok: true })
  }
  const result = await execute(fetchImpl, onClock(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(call(freshSession(), locales))
    yield* Effect.promise(() => started)
    yield* TestClock.adjust("5 seconds")
    return yield* Fiber.join(fiber)
  })))
  assert.equal(result.status, 200)
  assert.equal(hits, 2)
})

test("stops after the bounded number of 429 responses", async () => {
  resetAuthFlight()
  let hits = 0
  const fetchImpl: typeof fetch = async () => {
    hits++
    return jsonResponse(429, { message: "slow" }, { "retry-after": "0" })
  }
  await assert.rejects(
    () => execute(fetchImpl, call(freshSession(), locales)),
    (error: unknown) => error instanceof ApiError && error.status === 429
  )
  assert.equal(hits, 5)
})

test("interrupting a backoff delay does not send the retry", { timeout: 3000 }, async () => {
  resetAuthFlight()
  let hits = 0
  let mark: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    mark = resolve
  })
  const fetchImpl: typeof fetch = async () => {
    hits++
    mark()
    return jsonResponse(429, { message: "slow" }, { "retry-after": "30" })
  }
  await execute(fetchImpl, onClock(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(call(freshSession(), locales))
    yield* Effect.promise(() => started)
    yield* TestClock.adjust("1 millis")
    yield* Fiber.interrupt(fiber)
    yield* TestClock.adjust("30 seconds")
  })))
  assert.equal(hits, 1)
})
