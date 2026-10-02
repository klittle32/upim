import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { Effect, Schema } from "effect"
import { flatten } from "../src/catalog.ts"
import { describe, openApiDocument } from "../src/contract/document.ts"
import { applyLiveDictionary } from "../src/contract/live.ts"
import { contractKey, contracts } from "../src/contract/operations.ts"
import { ProductWrite } from "../src/contract/schemas.ts"
import { checkBody, checkFilters } from "../src/contract/validate.ts"

const runCli = (args: string[]) =>
  spawnSync(process.execPath, ["src/main.ts", ...args], { encoding: "utf8", env: process.env })

test("every catalog action has a contract", () => {
  for (const entry of flatten()) {
    assert.ok(contracts[contractKey(entry.action.method, entry.action.path)], `${entry.action.method} ${entry.action.path}`)
  }
})

test("product envelope accepts unknown attribute codes and rejects a missing sku", async () => {
  const action = flatten().find((entry) => entry.command.join(" ") === "products create")!.action
  const accepted = await Effect.runPromise(checkBody(action, {
    sku: "shirt-1",
    family: "default",
    type: "simple",
    extra: true,
    values: { common: { custom_erp_code: { amount: 1 } } }
  }))
  assert.equal(accepted, undefined)
  await assert.rejects(() => Effect.runPromise(checkBody(action, { family: "default", type: "simple" })))
})

test("decoded product schema does not drop unknown keys from the caller's body", () => {
  const body = { sku: "shirt-1", family: "default", type: "simple", extra: { keep: true } }
  Schema.decodeUnknownSync(ProductWrite)(body)
  assert.equal(body.extra.keep, true)
})

test("filters require an operator and a value", async () => {
  await Effect.runPromise(checkFilters(JSON.stringify({ sku: [{ operator: "IN", value: ["a"] }] })))
  await assert.rejects(() => Effect.runPromise(checkFilters(JSON.stringify({ sku: [{ value: "a" }] }))))
})

test("describe and schema commands expose the product contract", () => {
  const described = runCli(["describe", "products", "create", "--json"])
  assert.equal(described.status, 0, described.stderr)
  const body = JSON.parse(described.stdout) as {
    method: string
    errors: string
    example: { command: string }
    body: { schema: { required?: string[]; properties: { values: { properties: { common: unknown } } } }; example: { sku: string } }
    live: string[]
  }
  assert.equal(body.method, "POST")
  assert.equal(body.errors, "stderr")
  assert.match(body.example.command, /^upim products create --data '/)
  assert.ok(body.body.schema.required?.includes("sku"))
  assert.ok(body.body.schema.properties.values.properties.common)
  assert.equal(body.body.example.sku, "shirt-1")
  assert.ok(body.live.some((item) => item.includes("attributes list")))

  const schema = runCli(["schema", "--json"])
  assert.equal(schema.status, 0, schema.stderr)
  const openapi = JSON.parse(schema.stdout) as { openapi: string; paths: Record<string, { post?: { operationId: string } }> }
  assert.equal(openapi.openapi, "3.1.0")
  assert.equal(openapi.paths["/api/v1/rest/products"]?.post?.operationId, "products_create")
})

test("openapi covers every catalog path", () => {
  const document = openApiDocument()
  for (const entry of flatten()) {
    const method = entry.action.method.toLowerCase()
    const item = document.paths[entry.action.path] as Record<string, unknown> | undefined
    assert.ok(item?.[method], `missing ${method} ${entry.action.path}`)
  }
})

test("describe text stays a short field page", () => {
  const result = runCli(["describe", "products", "create"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /channel_locale_specific/)
  assert.match(result.stdout, /upim products create --data/)
  assert.match(result.stdout, /shirt-1/)
  const list = runCli(["describe", "products", "list"])
  assert.match(list.stdout, /--pagination-type search_after/)
})

test("a missing product field fails on stderr with a JSON pointer", () => {
  const result = runCli(["products", "create", "--data", JSON.stringify({ family: "default", type: "simple" })])
  assert.equal(result.status, 1)
  const failure = JSON.parse(result.stderr) as { error: string; message: string; path: string | null }
  assert.equal(failure.error, "UsageError")
  assert.equal(failure.path, "/sku")
  assert.match(failure.message, /sku/)
})

test("live dictionary places scoped attributes in the documented buckets", async () => {
  const operation = await Effect.runPromise(describe(["products", "create"]))
  assert.equal(operation.kind, "operation")
  if (operation.kind !== "operation") return
  const enriched = applyLiveDictionary(operation, {
    family: "default",
    familyAttributes: ["sku", "name", "cost"],
    attributes: [
      { code: "sku", type: "text", value_per_locale: 0, value_per_channel: 0 },
      { code: "name", type: "text", value_per_locale: 1, value_per_channel: 1, is_required: 1, labels: { en_US: "Name" } },
      { code: "cost", type: "price", value_per_locale: 0, value_per_channel: 1 },
      { code: "ignored", type: "text" }
    ]
  })
  const properties = (value: unknown, key: string) => {
    const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
    const child = record[key]
    return typeof child === "object" && child !== null ? child as Record<string, unknown> : {}
  }
  const values = properties(properties(enriched.body?.schema, "properties"), "values")
  const buckets = properties(values, "properties")
  const common = properties(properties(buckets, "common"), "properties")
  const channel = properties(properties(properties(buckets, "channel_specific"), "additionalProperties"), "properties")
  const locale = properties(properties(properties(properties(buckets, "channel_locale_specific"), "additionalProperties"), "additionalProperties"), "properties")
  assert.ok(common.sku)
  assert.equal(common.ignored, undefined)
  assert.ok(channel.cost)
  assert.ok(locale.name)
  assert.equal(enriched.liveDictionary?.family, "default")
})

test("describe resolves from the library", async () => {
  const index = await Effect.runPromise(describe([]))
  assert.equal(index.kind, "index")
  const group = await Effect.runPromise(describe(["media", "product"]))
  assert.equal(group.kind, "group")
})
