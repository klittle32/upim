import type { OperationDocument } from "./document.ts"

export type LiveAttribute = {
  readonly code: string
  readonly type?: string
  readonly value_per_locale?: number | boolean
  readonly value_per_channel?: number | boolean
  readonly is_required?: number | boolean
  readonly labels?: Readonly<Record<string, string>>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const rows = (body: unknown): readonly unknown[] => {
  const object = record(body)
  const data = object && "data" in object ? object.data : body
  return Array.isArray(data) ? data : object ? [object] : []
}

export const attributesFromBody = (body: unknown): readonly LiveAttribute[] =>
  rows(body).flatMap((row) => {
    const object = record(row)
    if (object === undefined || typeof object.code !== "string" || object.code === "") return []
    const labels = record(object.labels)
    return [{
      code: object.code,
      ...(typeof object.type === "string" ? { type: object.type } : {}),
      ...(typeof object.value_per_locale === "number" || typeof object.value_per_locale === "boolean"
        ? { value_per_locale: object.value_per_locale }
        : {}),
      ...(typeof object.value_per_channel === "number" || typeof object.value_per_channel === "boolean"
        ? { value_per_channel: object.value_per_channel }
        : {}),
      ...(typeof object.is_required === "number" || typeof object.is_required === "boolean"
        ? { is_required: object.is_required }
        : {}),
      ...(labels ? { labels: Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {})
    }]
  })

export const familyAttributeCodes = (body: unknown): readonly string[] => {
  const object = record(body)
  const family = object && record(object.data) ? record(object.data)! : object
  const groups = family?.attribute_groups
  if (!Array.isArray(groups)) return []
  return groups.flatMap((group) => {
    const attributes = record(group)?.custom_attributes
    if (!Array.isArray(attributes)) return []
    return attributes.flatMap((attribute) => {
      const code = record(attribute)?.code
      return typeof code === "string" ? [code] : []
    })
  })
}

const enabled = (value: number | boolean | undefined) => value === true || value === 1

const bucketFor = (attribute: LiveAttribute) => {
  if (attribute.code === "categories") return undefined
  if (enabled(attribute.value_per_channel) && enabled(attribute.value_per_locale)) return "channel_locale_specific"
  if (enabled(attribute.value_per_channel)) return "channel_specific"
  return "common"
}

const valueSchema = (attribute: LiveAttribute): Record<string, unknown> => {
  const label = attribute.labels ? Object.values(attribute.labels)[0] : undefined
  const bits = [attribute.type ?? "value", enabled(attribute.is_required) ? "required by the attribute" : "optional", label]
  const description = bits.filter((bit) => bit !== undefined && bit !== "").join(". ")
  if (attribute.type === "boolean") return { type: "boolean", description }
  if (attribute.type === "number") return { type: "number", description }
  if (attribute.type === "price") return { type: "object", additionalProperties: { type: "string" }, description: `${description}. Currency code to amount.` }
  return { description }
}

const asRecord = (value: unknown) => record(value) ?? {}

const propertiesOf = (schema: Record<string, unknown>, name: string) => {
  const properties = asRecord(schema.properties)
  const current = asRecord(properties[name])
  return { properties, current }
}

export const applyLiveDictionary = (
  document: OperationDocument,
  input: { readonly attributes: readonly LiveAttribute[]; readonly family?: string; readonly familyAttributes?: readonly string[] }
): OperationDocument => {
  if (document.body === undefined) return document
  const schema = structuredClone(document.body.schema) as Record<string, unknown>
  const values = propertiesOf(schema, "values")
  if (Object.keys(values.current).length === 0) return document
  const allowed = input.familyAttributes === undefined ? undefined : new Set(input.familyAttributes)
  const selected = input.attributes.filter((attribute) => allowed === undefined || allowed.has(attribute.code))
  const fields: Record<"common" | "channel_specific" | "channel_locale_specific", Record<string, unknown>> = {
    common: {},
    channel_specific: {},
    channel_locale_specific: {}
  }
  for (const attribute of selected) {
    const bucket = bucketFor(attribute)
    if (bucket === undefined) continue
    fields[bucket][attribute.code] = valueSchema(attribute)
  }
  const valueProperties = asRecord(values.current.properties)
  const common = asRecord(valueProperties.common)
  valueProperties.common = { ...common, type: "object", properties: { ...asRecord(common.properties), ...fields.common }, additionalProperties: true }
  const channel = asRecord(valueProperties.channel_specific)
  valueProperties.channel_specific = {
    ...channel,
    type: "object",
    additionalProperties: { type: "object", properties: fields.channel_specific, additionalProperties: true }
  }
  const both = asRecord(valueProperties.channel_locale_specific)
  valueProperties.channel_locale_specific = {
    ...both,
    type: "object",
    additionalProperties: {
      type: "object",
      additionalProperties: { type: "object", properties: fields.channel_locale_specific, additionalProperties: true }
    }
  }
  values.properties.values = { ...values.current, properties: valueProperties }
  schema.properties = values.properties
  return {
    ...document,
    notes: [
      ...document.notes,
      input.family
        ? `Live attribute dictionary for family ${input.family}. Unknown codes are still sent. A 422 from UnoPim remains the authority.`
        : "Live attribute dictionary for every attribute on this server. Pass --family <code> to limit it to one family."
    ],
    liveDictionary: { family: input.family ?? null, attributes: selected.length },
    body: { ...document.body, schema }
  }
}
