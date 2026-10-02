import assert from "node:assert/strict"
import test from "node:test"
import { fillPath, mergeFilters, parseFilter, parsePair, resolveUrl } from "../src/query.ts"

test("parseFilter splits operator and coerces values", () => {
  assert.deepEqual(parseFilter("sku:IN:305312,584577"), {
    key: "sku",
    clause: { operator: "IN", value: ["305312", "584577"] }
  })
  assert.deepEqual(parseFilter("status:=:true"), {
    key: "status",
    clause: { operator: "=", value: true }
  })
  assert.deepEqual(parseFilter("updated_at:>=:2026-08-01 00:00:00"), {
    key: "updated_at",
    clause: { operator: ">=", value: "2026-08-01 00:00:00" }
  })
})

test("mergeFilters combines JSON and repeated clauses", () => {
  const merged = mergeFilters('{"sku":[{"operator":"IN","value":["a"]}]}', ["status:=:true"])
  assert.equal(merged.sku?.[0]?.operator, "IN")
  assert.deepEqual(merged.status, [{ operator: "=", value: true }])
})

test("fillPath encodes path parameters", () => {
  assert.equal(fillPath("/api/v1/rest/products/{sku}", { sku: "a/b" }), "/api/v1/rest/products/a%2Fb")
})

test("resolveUrl joins the base URL and query", () => {
  const url = resolveUrl("https://pim.example.com/", "/api/v1/rest/products", { limit: "10" })
  assert.equal(url.toString(), "https://pim.example.com/api/v1/rest/products?limit=10")
})

test("parsePair keeps equals signs in the value", () => {
  assert.deepEqual(parsePair("q=a=b", "--query"), ["q", "a=b"])
})
