import type { Schema } from "effect"
import type { HttpMethod } from "../catalog.ts"
import {
  AssociationFieldWrite,
  AssociationTypePatch,
  AssociationTypeWrite,
  AttributeGroupPatch,
  AttributeGroupWrite,
  AttributePatch,
  AttributeWrite,
  CategoryFieldPatch,
  CategoryFieldWrite,
  CategoryPatch,
  CategoryWrite,
  ChannelWrite,
  CurrencyWrite,
  FamilyPatch,
  FamilyWrite,
  Filters,
  LocaleWrite,
  OptionListWrite,
  PassportPublish,
  PassportRedact,
  ProductPatch,
  ProductWrite,
  VariantStructurePatch,
  VariantStructureWrite
} from "./schemas.ts"

export const validationNote =
  "Local checks cover the static envelope only. Unknown keys are sent to UnoPim. A 422 response from the server is the authority."

export const productLive = [
  "upim attributes list --json",
  "upim families get <code> --json",
  "upim channels list --json",
  "upim locales list --json"
] as const

const productValuesNote =
  "Keys inside values.common, values.channel_specific, and values.channel_locale_specific are attribute codes configured on this installation. Price values are objects keyed by currency code."

export type JsonBody = {
  readonly schema: Schema.ConstraintDecoder<unknown>
  readonly example: unknown
}

export type Contract = {
  readonly docs: string
  readonly notes: readonly string[]
  readonly live?: readonly string[]
  readonly success: readonly { readonly status: number; readonly description: string }[]
  readonly body?: JsonBody
}

const ok = (description: string, status = 200) => [{ status, description }] as const

const created = (description: string) => ok(description)

const docs = {
  attribute: "https://devdocs.unopim.com/3.1/api/attribute.html",
  group: "https://devdocs.unopim.com/3.1/api/attribute_groups.html",
  family: "https://devdocs.unopim.com/3.1/api/attribute_families.html",
  option: "https://devdocs.unopim.com/3.1/api/attribute_options.html",
  variant: "https://devdocs.unopim.com/3.1/api/variant_structures.html",
  category: "https://devdocs.unopim.com/3.1/api/category.html",
  field: "https://devdocs.unopim.com/3.1/api/category_fields.html",
  fieldOption: "https://devdocs.unopim.com/3.1/api/category_field_options.html",
  product: "https://devdocs.unopim.com/3.1/api/product.html",
  configurable: "https://devdocs.unopim.com/3.1/api/configurable_products.html",
  channel: "https://devdocs.unopim.com/3.1/api/channel.html",
  locale: "https://devdocs.unopim.com/3.1/api/locales.html",
  currency: "https://devdocs.unopim.com/3.1/api/currency.html",
  association: "https://devdocs.unopim.com/3.1/api/association_types.html",
  media: "https://devdocs.unopim.com/3.1/api/media.html",
  passport: "https://devdocs.unopim.com/3.1/api/passports.html",
  measurement: "https://devdocs.unopim.com/3.1/packages/measurements.html",
  auth: "https://devdocs.unopim.com/3.1/api/authenticate.html",
  guide: "https://devdocs.unopim.com/3.1/api/"
}

const attributeExample = {
  code: "erpname",
  type: "text",
  validation: null,
  regex_pattern: null,
  position: 25,
  is_required: 1,
  is_unique: 0,
  value_per_locale: 0,
  value_per_channel: 0,
  enable_wysiwyg: 0,
  labels: { en_US: "ERP Name" }
}

const productExample = {
  sku: "shirt-1",
  status: true,
  parent: null,
  family: "default",
  type: "simple",
  values: {
    common: { sku: "shirt-1" },
    categories: ["root"],
    channel_locale_specific: { default: { en_US: { name: "Shirt" } } }
  }
}

const configurableExample = {
  ...productExample,
  sku: "shirt",
  type: "configurable",
  super_attributes: ["size"],
  variants: [{ sku: "shirt-s", attributes: { size: "s" } }]
}

const read = (page: string, what: string): Contract => ({
  docs: page,
  notes: [],
  success: ok(what)
})

const write = (page: string, body: JsonBody, notes: readonly string[] = [], live?: readonly string[]): Contract => ({
  docs: page,
  notes,
  ...(live ? { live } : {}),
  success: created("Write accepted."),
  body
})

const removed = (page: string): Contract => ({
  docs: page,
  notes: [],
  success: ok("Deleted.")
})

export const contracts: Readonly<Record<string, Contract>> = {
  "GET /api/v1/rest/attributes": read(docs.attribute, "A page of attributes."),
  "GET /api/v1/rest/attributes/{code}": read(docs.attribute, "One attribute."),
  "POST /api/v1/rest/attributes": write(docs.attribute, { schema: AttributeWrite, example: attributeExample }),
  "PUT /api/v1/rest/attributes/{code}": write(docs.attribute, { schema: AttributeWrite, example: attributeExample }, ["PUT replaces the submitted fields."]),
  "PATCH /api/v1/rest/attributes/{code}": write(docs.attribute, { schema: AttributePatch, example: { labels: { en_US: "Updated label" } } }, ["PATCH changes only the keys you send."]),
  "DELETE /api/v1/rest/attributes/{code}": removed(docs.attribute),

  "GET /api/v1/rest/attributes/{code}/options": read(docs.option, "Options for one select or multiselect attribute."),
  "POST /api/v1/rest/attributes/{code}/options": write(docs.option, {
    schema: OptionListWrite,
    example: [{ code: "xl", sort_order: 4, labels: { en_US: "Extra Large" } }]
  }),
  "PUT /api/v1/rest/attributes/{code}/options": write(docs.option, {
    schema: OptionListWrite,
    example: [{ code: "xl", sort_order: 1, labels: { en_US: "Extra Large" } }]
  }, ["PUT replaces the option set."]),
  "DELETE /api/v1/rest/attributes/{code}/options/{option}": removed(docs.option),

  "GET /api/v1/rest/attribute-groups": read(docs.group, "A page of attribute groups."),
  "GET /api/v1/rest/attribute-groups/{code}": read(docs.group, "One attribute group."),
  "POST /api/v1/rest/attribute-groups": write(docs.group, { schema: AttributeGroupWrite, example: { code: "marketing", labels: { en_US: "Marketing" } } }),
  "PUT /api/v1/rest/attribute-groups/{code}": write(docs.group, { schema: AttributeGroupWrite, example: { code: "marketing", labels: { en_US: "Marketing" } } }),
  "PATCH /api/v1/rest/attribute-groups/{code}": write(docs.group, { schema: AttributeGroupPatch, example: { labels: { en_US: "Updated group label" } } }),
  "DELETE /api/v1/rest/attribute-groups/{code}": removed(docs.group),

  "GET /api/v1/rest/families": read(docs.family, "A page of attribute families."),
  "GET /api/v1/rest/families/{code}": read(docs.family, "One attribute family, including its groups."),
  "POST /api/v1/rest/families": write(docs.family, {
    schema: FamilyWrite,
    example: { code: "garment", labels: { en_US: "Garment" }, attribute_groups: [{ code: "product", position: 1, custom_attributes: [{ code: "sku", position: 1 }] }] }
  }),
  "PUT /api/v1/rest/families/{code}": write(docs.family, {
    schema: FamilyWrite,
    example: { code: "garment", labels: { en_US: "Garment" } }
  }),
  "PATCH /api/v1/rest/families/{code}": write(docs.family, { schema: FamilyPatch, example: { labels: { en_US: "Updated family label" } } }),
  "DELETE /api/v1/rest/families/{code}": removed(docs.family),

  "GET /api/v1/rest/families/{code}/variant-structures": read(docs.variant, "Variant structures for one family."),
  "GET /api/v1/rest/families/{code}/variant-structures/{structure}": read(docs.variant, "One variant structure. The result round-trips as a PUT body."),
  "POST /api/v1/rest/families/{code}/variant-structures": write(docs.variant, {
    schema: VariantStructureWrite,
    example: { code: "colour_size", name: "Colour then Size", levels: 2, axes: { level_1: ["colour"], level_2: ["size"] }, placements: { common: ["brand"], variant: ["sku", "size"] } }
  }),
  "PUT /api/v1/rest/families/{code}/variant-structures/{structure}": write(docs.variant, {
    schema: VariantStructureWrite,
    example: { code: "colour_size", name: "Colour then Size", levels: 2, axes: { level_1: ["colour"], level_2: ["size"] } }
  }),
  "PATCH /api/v1/rest/families/{code}/variant-structures/{structure}": write(docs.variant, { schema: VariantStructurePatch, example: { name: "Colour then Size" } }),
  "DELETE /api/v1/rest/families/{code}/variant-structures/{structure}": removed(docs.variant),

  "GET /api/v1/rest/categories": read(docs.category, "A page of categories."),
  "GET /api/v1/rest/categories/{code}": read(docs.category, "One category."),
  "POST /api/v1/rest/categories": write(docs.category, {
    schema: CategoryWrite,
    example: { code: "electronic", parent: "root", additional_data: { locale_specific: { en_US: { name: "Electronic" } } } }
  }, ["additional_data keys are category fields configured on the server."], ["upim category-fields list --json"]),
  "PUT /api/v1/rest/categories/{code}": write(docs.category, {
    schema: CategoryWrite,
    example: { code: "electronic", parent: "root" }
  }),
  "PATCH /api/v1/rest/categories/{code}": write(docs.category, {
    schema: CategoryPatch,
    example: { additional_data: { locale_specific: { en_US: { name: "Updated Electronic Name" } } } }
  }),
  "DELETE /api/v1/rest/categories/{code}": removed(docs.category),

  "GET /api/v1/rest/category-fields": read(docs.field, "A page of category fields."),
  "GET /api/v1/rest/category-fields/{code}": read(docs.field, "One category field."),
  "POST /api/v1/rest/category-fields": write(docs.field, {
    schema: CategoryFieldWrite,
    example: { code: "erpname", type: "text", status: 1, position: 1, is_required: 0, section: "left", labels: { en_US: "Erp Name" } }
  }),
  "PUT /api/v1/rest/category-fields/{code}": write(docs.field, {
    schema: CategoryFieldWrite,
    example: { code: "erpname", type: "text", status: 1, labels: { en_US: "Erp Name" } }
  }),
  "PATCH /api/v1/rest/category-fields/{code}": write(docs.field, { schema: CategoryFieldPatch, example: { labels: { en_US: "Updated field label" } } }),
  "DELETE /api/v1/rest/category-fields/{code}": removed(docs.field),

  "GET /api/v1/rest/category-fields/{code}/options": read(docs.fieldOption, "Options for one category field."),
  "POST /api/v1/rest/category-fields/{code}/options": write(docs.fieldOption, {
    schema: OptionListWrite,
    example: [{ code: "black", sort_order: 1, labels: { en_US: "Black" } }]
  }),
  "PUT /api/v1/rest/category-fields/{code}/options": write(docs.fieldOption, {
    schema: OptionListWrite,
    example: [{ code: "black", sort_order: 1, labels: { en_US: "Black" } }]
  }),
  "DELETE /api/v1/rest/category-fields/{code}/options/{option}": removed(docs.fieldOption),

  "GET /api/v1/rest/products": {
    ...read(docs.product, "A page of products. Listing does not include associations."),
    notes: ["Pass --with-completeness to request completeness. Use pagination_type=search_after for large catalogs."]
  },
  "GET /api/v1/rest/products/{sku}": {
    ...read(docs.product, "One product, including associations."),
    notes: ["The response uses related_sku on association links. Requests use sku."]
  },
  "POST /api/v1/rest/products": write(docs.product, { schema: ProductWrite, example: productExample }, [productValuesNote, "Variant children are created here with parent set to the parent SKU."], productLive),
  "PUT /api/v1/rest/products/{sku}": write(docs.product, { schema: ProductWrite, example: productExample }, [productValuesNote, "PUT replaces the submitted product."], productLive),
  "PATCH /api/v1/rest/products/{sku}": write(docs.product, { schema: ProductPatch, example: { values: { common: { name: "Updated Product Name" } } } }, [productValuesNote], productLive),
  "DELETE /api/v1/rest/products/{sku}": removed(docs.product),

  "GET /api/v1/rest/configurable-products": read(docs.configurable, "A page of configurable products."),
  "GET /api/v1/rest/configurable-products/{sku}": read(docs.configurable, "One configurable product."),
  "POST /api/v1/rest/configurable-products": write(docs.configurable, { schema: ProductWrite, example: configurableExample }, [productValuesNote, "type is configurable. super_attributes names the variant axes."], productLive),
  "PUT /api/v1/rest/configurable-products/{sku}": write(docs.configurable, { schema: ProductWrite, example: configurableExample }, [productValuesNote], productLive),
  "PATCH /api/v1/rest/configurable-products/{sku}": write(docs.configurable, { schema: ProductPatch, example: { super_attributes: ["size"], variants: [{ sku: "shirt-s", attributes: { size: "s" } }] } }, [productValuesNote], productLive),
  "DELETE /api/v1/rest/configurable-products/{sku}": removed(docs.configurable),

  "GET /api/v1/rest/channels": read(docs.channel, "A page of channels."),
  "GET /api/v1/rest/channels/{code}": read(docs.channel, "One channel."),
  "POST /api/v1/rest/channels": write(docs.channel, {
    schema: ChannelWrite,
    example: { code: "print", locales: ["en_US"], currencies: ["USD"], root_category: "root", labels: { en_US: "Print" } }
  }),
  "PUT /api/v1/rest/channels/{code}": write(docs.channel, {
    schema: ChannelWrite,
    example: { code: "print", locales: ["en_US"], currencies: ["USD"], root_category: "root", labels: { en_US: "Print" } }
  }, ["PUT expects the full resource. Omitted translations keep their stored values."]),
  "DELETE /api/v1/rest/channels/{code}": removed(docs.channel),

  "GET /api/v1/rest/locales": read(docs.locale, "A page of locales."),
  "GET /api/v1/rest/locales/{code}": read(docs.locale, "One locale."),
  "POST /api/v1/rest/locales": write(docs.locale, { schema: LocaleWrite, example: { code: "fr_FR", status: 1 } }),
  "PUT /api/v1/rest/locales/{code}": write(docs.locale, { schema: LocaleWrite, example: { code: "fr_FR", status: 1 } }),
  "DELETE /api/v1/rest/locales/{code}": removed(docs.locale),

  "GET /api/v1/rest/currencies": read(docs.currency, "A page of currencies."),
  "GET /api/v1/rest/currencies/{code}": read(docs.currency, "One currency."),
  "POST /api/v1/rest/currencies": write(docs.currency, { schema: CurrencyWrite, example: { code: "CAD", status: 1 } }),
  "PUT /api/v1/rest/currencies/{code}": write(docs.currency, { schema: CurrencyWrite, example: { code: "CAD", status: 1 } }),
  "DELETE /api/v1/rest/currencies/{code}": removed(docs.currency),

  "GET /api/v1/rest/association-types": read(docs.association, "A page of association types."),
  "GET /api/v1/rest/association-types/{code}": read(docs.association, "One association type."),
  "POST /api/v1/rest/association-types": write(docs.association, {
    schema: AssociationTypeWrite,
    example: { code: "spare_parts", status: true, en_US: { name: "Spare Parts" } }
  }, ["Add one object { name } per active locale. Those keys are forwarded without a local type check."], ["upim locales list --json"]),
  "PUT /api/v1/rest/association-types/{code}": write(docs.association, {
    schema: AssociationTypeWrite,
    example: { code: "spare_parts", status: true, en_US: { name: "Spare Parts" } }
  }, ["PUT replaces the submitted attributes."]),
  "PATCH /api/v1/rest/association-types/{code}": write(docs.association, {
    schema: AssociationTypePatch,
    example: { en_US: { name: "Spare Parts" } }
  }, ["PATCH changes only the keys you send."]),
  "DELETE /api/v1/rest/association-types/{code}": {
    ...removed(docs.association),
    notes: ["Deleting a type removes its links from every product. The built-in types are refused with 422."]
  },

  "GET /api/v1/rest/association-types/{code}/fields": read(docs.association, "Per-link fields for one association type."),
  "POST /api/v1/rest/association-types/{code}/fields": write(docs.association, {
    schema: AssociationFieldWrite,
    example: { code: "quantity", type: "text", validation: "numeric", position: 1, is_required: 1, labels: { en_US: "Quantity" } }
  }, ["The published page shows the stored field, not a separate request schema."]),
  "PUT /api/v1/rest/association-types/{code}/fields/{field}": write(docs.association, {
    schema: AssociationFieldWrite,
    example: { code: "quantity", type: "text", labels: { en_US: "Quantity" } }
  }),
  "DELETE /api/v1/rest/association-types/{code}/fields/{field}": removed(docs.association),

  "POST /api/v1/rest/media-files/product": {
    docs: docs.media,
    notes: ["multipart/form-data. Gallery attributes also accept video. The file is not JSON."],
    success: ok("Stored file path.")
  },
  "GET /api/v1/rest/media-files/product": read(docs.media, "Stored product media paths."),
  "DELETE /api/v1/rest/media-files/product": removed(docs.media),
  "POST /api/v1/rest/media-files/category": {
    docs: docs.media,
    notes: ["multipart/form-data. The file is not JSON."],
    success: ok("Stored file path.")
  },
  "GET /api/v1/rest/media-files/category": read(docs.media, "Stored category media paths."),
  "DELETE /api/v1/rest/media-files/category": removed(docs.media),
  "POST /api/v1/rest/media-files/swatch": {
    docs: docs.media,
    notes: ["multipart/form-data. jpeg, png, jpg, webp, or svg, maximum 2 MB."],
    success: ok("Stored swatch path.")
  },
  "GET /api/v1/rest/media-files/swatch": read(docs.media, "Stored swatch path."),
  "DELETE /api/v1/rest/media-files/swatch": removed(docs.media),

  "GET /api/v1/rest/passports": read(docs.passport, "Passport publications, newest first."),
  "GET /api/v1/rest/passports/{sku}": read(docs.passport, "Every publication for one product."),
  "POST /api/v1/rest/passports/publish/{sku}": {
    ...write(docs.passport, { schema: PassportPublish, example: { channel_id: 1, locale_ids: [1, 3] } }, ["Publication is queued."]),
    success: ok("Publication queued.", 202)
  },
  "POST /api/v1/rest/passports/withdraw/{id}": {
    docs: docs.passport,
    notes: ["No request body is documented. The id is the numeric publication id."],
    success: ok("Publication withdrawn.")
  },
  "POST /api/v1/rest/passports/reinstate/{id}": {
    docs: docs.passport,
    notes: ["No request body is documented. The id is the numeric publication id."],
    success: ok("Publication reinstated.")
  },
  "POST /api/v1/rest/passports/redact/{id}": write(docs.passport, { schema: PassportRedact, example: { reason: "Data subject erasure request #4182" } }),

  "GET /api/v1/rest/measurement": {
    docs: docs.measurement,
    notes: ["UnoPim 3.1 documents this route and not the JSON body. Nothing is checked locally."],
    success: ok("Measurement families.")
  },
  "POST /api/v1/rest/measurement": {
    docs: docs.measurement,
    notes: ["UnoPim 3.1 documents this route and not the JSON body. Nothing is checked locally."],
    success: created("Measurement family accepted.")
  },
  "GET /api/v1/rest/measurement/{code}": {
    docs: docs.measurement,
    notes: ["UnoPim 3.1 documents this route and not the JSON body."],
    success: ok("One measurement family.")
  },
  "PUT /api/v1/rest/measurement/{code}": {
    docs: docs.measurement,
    notes: ["UnoPim 3.1 documents this route and not the JSON body. Nothing is checked locally."],
    success: created("Measurement family replaced.")
  },
  "DELETE /api/v1/rest/measurement/{code}": removed(docs.measurement),
  "GET /api/v1/rest/units/{family}": read(docs.measurement, "Units in one measurement family."),
  "POST /api/v1/rest/units/{family}": {
    docs: docs.measurement,
    notes: ["UnoPim 3.1 documents this route and not the JSON body. Nothing is checked locally."],
    success: created("Unit accepted.")
  },
  "GET /api/v1/rest/units/{family}/{code}": read(docs.measurement, "One unit."),
  "PUT /api/v1/rest/units/{family}/{code}": {
    docs: docs.measurement,
    notes: ["UnoPim 3.1 documents this route and not the JSON body. Nothing is checked locally."],
    success: created("Unit replaced.")
  },
  "DELETE /api/v1/rest/units/{family}/{code}": removed(docs.measurement),
  "GET /api/v1/rest/attribute-measurement/config/{attribute}": read(docs.measurement, "An attribute's measurement family and unit binding."),
  "GET /api/v1/rest/attribute-measurement/{family}": read(docs.measurement, "Units available to a measurement family."),
  "POST /api/v1/rest/attribute-measurement/{attribute}": {
    docs: docs.measurement,
    notes: ["Binds an attribute to a measurement family and unit. The 3.1 page does not publish the JSON body, so nothing is checked locally."],
    success: created("Binding accepted.")
  },
  "PUT /api/v1/rest/attribute-measurement/{attribute}": {
    docs: docs.measurement,
    notes: ["Updates an attribute's measurement binding. The 3.1 page does not publish the JSON body, so nothing is checked locally."],
    success: created("Binding replaced.")
  }
}

export const contractKey = (method: HttpMethod, path: string) => `${method} ${path}`

export const contractFor = (method: HttpMethod, path: string): Contract => {
  const contract = contracts[contractKey(method, path)]
  if (contract === undefined) throw new Error(`No contract for ${method} ${path}`)
  return contract
}

export const sharedErrors = [
  { status: 401, description: "The access token is missing or expired. upim refreshes once and retries the call." },
  { status: 403, description: "Authenticated, but this integration may not perform the action." },
  { status: 404, description: "The record does not exist." },
  { status: 406, description: "Accept was not application/json." },
  { status: 422, description: "UnoPim rejected the payload. The response body is the validation result." },
  { status: 429, description: "Rate limited. upim waits for Retry-After, or backs off, and retries." }
] as const

export { Filters, docs }
