import assert from "node:assert/strict"
import test from "node:test"
import { flatten } from "../src/catalog.ts"

const paths = new Set(flatten().map((entry) => `${entry.action.method} ${entry.action.path}`))

test("covers the UnoPim 3.1 REST actions", () => {
  const required = [
    "GET /api/v1/rest/attributes",
    "PATCH /api/v1/rest/attributes/{code}",
    "DELETE /api/v1/rest/attributes/{code}/options/{option}",
    "GET /api/v1/rest/attribute-groups",
    "PATCH /api/v1/rest/families/{code}",
    "GET /api/v1/rest/families/{code}/variant-structures",
    "PATCH /api/v1/rest/families/{code}/variant-structures/{structure}",
    "PATCH /api/v1/rest/categories/{code}",
    "DELETE /api/v1/rest/category-fields/{code}/options/{option}",
    "GET /api/v1/rest/products",
    "PATCH /api/v1/rest/products/{sku}",
    "POST /api/v1/rest/configurable-products",
    "POST /api/v1/rest/channels",
    "DELETE /api/v1/rest/locales/{code}",
    "PUT /api/v1/rest/currencies/{code}",
    "POST /api/v1/rest/association-types/{code}/fields",
    "POST /api/v1/rest/media-files/product",
    "GET /api/v1/rest/media-files/category",
    "DELETE /api/v1/rest/media-files/swatch",
    "POST /api/v1/rest/passports/publish/{sku}",
    "POST /api/v1/rest/passports/redact/{id}",
    "GET /api/v1/rest/measurement",
    "DELETE /api/v1/rest/units/{family}/{code}",
    "POST /api/v1/rest/attribute-measurement/{attribute}",
    "GET /api/v1/rest/attribute-measurement/config/{attribute}"
  ]
  for (const path of required) assert.ok(paths.has(path), `missing ${path}`)
})
