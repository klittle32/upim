import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { UsageError } from "../src/errors.ts"
import { fillPath, mergeFilters, parseFilter, parsePair, parsePairs, resolveUrl } from "../src/query.ts"

const fails = <A>(effect: Effect.Effect<A, UsageError>, pattern: RegExp) => {
  const error = Effect.runSync(Effect.flip(effect))
  assert.ok(error instanceof UsageError, String(error))
  assert.match(error.message, pattern)
}

test("parseFilter splits operator and coerces values", () => {
  assert.deepEqual(Effect.runSync(parseFilter("sku:IN:305312,584577")), {
    key: "sku",
    clause: { operator: "IN", value: ["305312", "584577"] }
  })
  assert.deepEqual(Effect.runSync(parseFilter("status:=:true")), {
    key: "status",
    clause: { operator: "=", value: true }
  })
  assert.deepEqual(Effect.runSync(parseFilter("updated_at:>=:2026-08-01 00:00:00")), {
    key: "updated_at",
    clause: { operator: ">=", value: "2026-08-01 00:00:00" }
  })
  assert.deepEqual(Effect.runSync(parseFilter("tags:IN:[\"a\",\"b\"]")), {
    key: "tags",
    clause: { operator: "IN", value: ["a", "b"] }
  })
})

test("malformed filters are typed usage errors, not thrown", () => {
  fails(parseFilter("bad"), /Expected key:operator:value/)
  fails(parseFilter("sku:IN:[oops"), /Invalid JSON in filter value/)
  fails(mergeFilters("{bad", []), /Invalid --filters/)
  fails(mergeFilters(JSON.stringify({ sku: [{ value: "a" }] }), []), /Invalid --filters/)
  fails(mergeFilters("[]", []), /Invalid --filters/)
})

test("mergeFilters combines JSON and repeated clauses", () => {
  const merged = Effect.runSync(mergeFilters('{"sku":[{"operator":"IN","value":["a"]}]}', ["status:=:true", "sku:=:b"]))
  assert.deepEqual(merged.sku, [{ operator: "IN", value: ["a"] }, { operator: "=", value: "b" }])
  assert.deepEqual(merged.status, [{ operator: "=", value: true }])
  assert.deepEqual(Effect.runSync(mergeFilters(undefined, [])), {})
})

test("fillPath encodes path parameters and reports missing ones", () => {
  assert.equal(Effect.runSync(fillPath("/api/v1/rest/products/{sku}", { sku: "a/b" })), "/api/v1/rest/products/a%2Fb")
  assert.equal(Effect.runSync(fillPath("/a/{x}/b/{y}", { x: "1", y: "2" })), "/a/1/b/2")
  assert.equal(Effect.runSync(fillPath("/plain", {})), "/plain")
  fails(fillPath("/api/v1/rest/products/{sku}", {}), /Missing path parameter \{sku\}/)
  fails(fillPath("/api/v1/rest/products/{sku}", { sku: "" }), /Missing path parameter \{sku\}/)
})

test("resolveUrl joins the base URL and query", () => {
  const url = resolveUrl("https://pim.example.com/", "/api/v1/rest/products", { limit: "10" })
  assert.equal(url.toString(), "https://pim.example.com/api/v1/rest/products?limit=10")
})

test("parsePair keeps equals signs in the value and rejects pairs without one", () => {
  assert.deepEqual(Effect.runSync(parsePair("q=a=b", "--query")), ["q", "a=b"])
  assert.deepEqual(Effect.runSync(parsePairs(["a=1", "b=2", "a=3"], "--query")), { a: "3", b: "2" })
  fails(parsePair("novalue", "--query"), /Invalid --query "novalue"\. Expected key=value/)
  fails(parsePairs(["a=1", "=x"], "--header"), /Invalid --header "=x"/)
})
