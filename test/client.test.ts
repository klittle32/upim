import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { call, resetAuthFlight, type Session } from "../src/client.ts"
import { UsageError } from "../src/errors.ts"
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
