import { Effect, Schema } from "effect"
import { flatten, resources, type Action, type FlatAction, type Resource } from "../catalog.ts"
import { UsageError } from "../errors.ts"
import { contractFor, sharedErrors, validationNote, type Contract } from "./operations.ts"

export type ParameterDocument = {
  readonly name: string
  readonly in: "path" | "query"
  readonly required: boolean
  readonly description: string
  readonly schema: Readonly<Record<string, unknown>>
}

export type CliFlagDocument = {
  readonly name: string
  readonly description: string
}

export type OperationDocument = {
  readonly kind: "operation"
  readonly command: string
  readonly errors: "stderr"
  readonly summary: string
  readonly method: Action["method"]
  readonly path: string
  readonly docs: string
  readonly parameters: readonly ParameterDocument[]
  readonly cli: readonly CliFlagDocument[]
  readonly example: {
    readonly command: string
    readonly body?: unknown
  }
  readonly body?: {
    readonly required: boolean
    readonly mediaType: "application/json"
    readonly schema: Readonly<Record<string, unknown>>
    readonly example: unknown
  }
  readonly responses: readonly { readonly status: number; readonly description: string }[]
  readonly notes: readonly string[]
  readonly live: readonly string[]
  readonly validation: string
  readonly liveDictionary?: {
    readonly family: string | null
    readonly attributes: number
  }
}

export type GroupDocument = {
  readonly kind: "group"
  readonly command: string
  readonly errors: "stderr"
  readonly summary: string
  readonly operations: readonly {
    readonly command: string
    readonly method: Action["method"]
    readonly path: string
    readonly summary: string
    readonly describe: string
  }[]
}

export type IndexDocument = {
  readonly kind: "index"
  readonly docs: "https://devdocs.unopim.com/3.1/api/"
  readonly errors: "stderr"
  readonly usage: "upim describe <resource> [action] [--json]"
  readonly resources: readonly { readonly name: string; readonly summary: string; readonly describe: string }[]
}

export type DescribeDocument = OperationDocument | GroupDocument | IndexDocument

const stringSchema = { type: "string" }
const integerSchema = { type: "integer" }

const definitionsOf = (schema: Schema.ConstraintDecoder<unknown>) => {
  const document = Schema.toJsonSchemaDocument(schema)
  return {
    root: document.schema as Record<string, unknown>,
    definitions: document.definitions as Record<string, Record<string, unknown>>
  }
}

const definitionFor = (ref: unknown, definitions: Record<string, Record<string, unknown>>) => {
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return undefined
  return definitions[ref.slice("#/$defs/".length)]
}

const inlineOneLevel = (schema: Record<string, unknown>, definitions: Record<string, Record<string, unknown>>) => {
  const properties = schema.properties
  if (typeof properties !== "object" || properties === null) return schema
  const next: Record<string, unknown> = {}
  for (const [name, definition] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof definition !== "object" || definition === null) {
      next[name] = definition
      continue
    }
    const record = definition as Record<string, unknown>
    const direct = definitionFor(record.$ref, definitions)
    if (direct) {
      next[name] = { ...direct }
      continue
    }
    const items = typeof record.items === "object" && record.items !== null ? record.items as Record<string, unknown> : undefined
    const item = items ? definitionFor(items.$ref, definitions) : undefined
    next[name] = item ? { ...record, items: { ...item } } : definition
  }
  return { ...schema, properties: next }
}

export const jsonSchemaFor = (schema: Schema.ConstraintDecoder<unknown>): Record<string, unknown> => {
  const { root, definitions } = definitionsOf(schema)
  const target = definitionFor(root.$ref, definitions)
  const body = inlineOneLevel(target ? { ...target } : { ...root }, definitions)
  return Object.keys(definitions).length > 0 ? { ...body, $defs: definitions } : body
}

const listParameters = (): readonly ParameterDocument[] => [
  { name: "limit", in: "query", required: false, description: "Page size. UnoPim clamps this to 100. The default is 10.", schema: integerSchema },
  { name: "page", in: "query", required: false, description: "Page number when pagination_type is page.", schema: integerSchema },
  { name: "pagination_type", in: "query", required: false, description: "page or search_after. search_after omits total and last_page.", schema: { type: "string", enum: ["page", "search_after"] } },
  { name: "search_after", in: "query", required: false, description: "Cursor from the previous page. Follow links.next until it is null.", schema: integerSchema },
  { name: "filters", in: "query", required: false, description: "JSON object of field clauses. See the Filters schema. --filter key:operator:value is the CLI form of the same value.", schema: stringSchema }
]

const parametersFor = (action: Action): readonly ParameterDocument[] => [
  ...(action.args ?? []).map((name) => ({
    name,
    in: "path" as const,
    required: true,
    description: `Path parameter {${name}}.`,
    schema: stringSchema
  })),
  ...(action.list ? listParameters() : []),
  ...(action.query ?? []).map((query) => ({
    name: query.param,
    in: "query" as const,
    required: query.required === true,
    description: query.description,
    schema: query.kind === "boolean" ? { type: "boolean" } : stringSchema
  }))
]

const cliFor = (action: Action): readonly CliFlagDocument[] => [
  ...(action.body ? [
    { name: "--data", description: "JSON request body." },
    { name: "--file", description: "JSON file, or - to read stdin." }
  ] : []),
  ...(action.upload ? [{ name: "--file", description: "Media file to upload as multipart/form-data." }] : []),
  ...(action.list ? [
    { name: "--filter", description: "Repeatable key:operator:value filter. Merged into the filters query parameter." },
    { name: "--filters", description: "Raw filters JSON object." },
    { name: "--all", description: "Follow links.next and concatenate data. Fails instead of returning a partial catalog. This is a client flag, not a query parameter." },
    { name: "--max-pages", description: "Safety cap for --all. The default is 1000. A remaining links.next fails the command." }
  ] : []),
  { name: "--if-none-match", description: "Send If-None-Match. A 304 becomes { notModified: true }." },
  ...(!action.list ? [{ name: "--query", description: "Extra query parameter as key=value. Repeatable." }] : [])
]

const samples: Readonly<Record<string, string>> = {
  sku: "shirt-1",
  code: "demo",
  id: "1",
  family: "length",
  attribute: "image",
  structure: "colour_size",
  option: "red",
  field: "quantity",
  category_field: "banner",
  attribute_code: "color"
}

const quote = (value: string) => /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`

const sampleFor = (name: string, example: unknown) => {
  if (typeof example === "object" && example !== null && !Array.isArray(example) && name in example) {
    const value = (example as Record<string, unknown>)[name]
    if (typeof value === "string" || typeof value === "number") return String(value)
  }
  return samples[name] ?? "value"
}

export const exampleCommand = (entry: FlatAction, example: unknown) => {
  const action = entry.action
  const parts = [["upim", ...entry.command].join(" ")]
  for (const name of action.args ?? []) parts.push(quote(sampleFor(name, example)))
  if (action.upload) parts.push("--file", "./image.webp")
  for (const query of action.query ?? []) {
    if (!query.required || query.kind === "boolean") continue
    parts.push(`--${query.name}`, quote(sampleFor(query.param, example)))
  }
  if (action.list) parts.push("--limit", "10", "--pagination-type", "search_after", "--filter", quote("sku:IN:shirt-1"))
  if (action.body && example !== undefined) parts.push("--data", quote(JSON.stringify(example)))
  return parts.join(" ")
}

export const operationDocument = (entry: FlatAction): OperationDocument => {
  const contract = contractFor(entry.action.method, entry.action.path)
  const command = ["upim", ...entry.command].join(" ")
  const example = contract.body?.example
  return {
    kind: "operation",
    command,
    errors: "stderr",
    summary: entry.action.summary,
    example: {
      command: exampleCommand(entry, example),
      ...(example !== undefined ? { body: example } : {})
    },
    method: entry.action.method,
    path: entry.action.path,
    docs: contract.docs,
    parameters: parametersFor(entry.action),
    cli: cliFor(entry.action),
    ...(contract.body
      ? {
          body: {
            required: entry.action.body === "required",
            mediaType: "application/json" as const,
            schema: jsonSchemaFor(contract.body.schema),
            example: contract.body.example
          }
        }
      : {}),
    responses: [
      ...contract.success,
      { status: 304, description: "Not modified when If-None-Match matches. upim prints { notModified: true }." },
      ...sharedErrors
    ],
    notes: contract.notes,
    live: contract.live ?? [],
    validation: contract.body ? validationNote : "This call has no local JSON body check."
  }
}

const findResource = (nodes: readonly Resource[], segments: readonly string[]): Resource | undefined => {
  const [head, ...rest] = segments
  const node = nodes.find((candidate) => candidate.name === head)
  if (node === undefined) return undefined
  if (rest.length === 0) return node
  return findResource(node.children ?? [], rest)
}

const matches = (entry: FlatAction, segments: readonly string[]) =>
  segments.every((segment, index) => entry.command[index] === segment)

export const describe = (segments: readonly string[]): Effect.Effect<DescribeDocument, UsageError> => {
  if (segments.length === 0) {
    return Effect.succeed({
      kind: "index",
      docs: "https://devdocs.unopim.com/3.1/api/",
      errors: "stderr",
      usage: "upim describe <resource> [action] [--json]",
      resources: resources.map((resource) => ({
        name: resource.name,
        summary: resource.summary,
        describe: `upim describe ${resource.name}`
      }))
    })
  }
  const entries = flatten().filter((entry) => matches(entry, segments))
  if (entries.length === 0) {
    return Effect.fail(new UsageError({
      message: `No upim command matches \`${segments.join(" ")}\`. Run \`upim describe\` to list resources.`
    }))
  }
  const exact = entries.find((entry) => entry.command.length === segments.length)
  if (exact) return Effect.succeed(operationDocument(exact))
  const resource = findResource(resources, segments)
  return Effect.succeed({
    kind: "group",
    command: `upim describe ${segments.join(" ")}`,
    errors: "stderr",
    summary: resource?.summary ?? segments.join(" "),
    operations: entries.map((entry) => ({
      command: ["upim", ...entry.command].join(" "),
      method: entry.action.method,
      path: entry.action.path,
      summary: entry.action.summary,
      describe: `upim describe ${entry.command.join(" ")} --json`
    }))
  })
}

const line = (label: string, value: string) => `${label.padEnd(12)}${value}`

const typeName = (record: Record<string, unknown>) =>
  typeof record.type === "string"
    ? record.type
    : typeof record.$ref === "string"
      ? record.$ref.replace("#/$defs/", "")
      : "any"

const fieldLines = (schema: Readonly<Record<string, unknown>>, depth = 0): readonly string[] => {
  const properties = schema.properties
  if (typeof properties !== "object" || properties === null) {
    if (schema.type === "array") return ["JSON array. Item schema is in `upim describe <command> --json`."]
    return []
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [])
  return Object.entries(properties as Record<string, unknown>).flatMap(([name, definition]) => {
    const record = typeof definition === "object" && definition !== null ? definition as Record<string, unknown> : {}
    const description = typeof record.description === "string" ? `  ${record.description}` : ""
    const line = `${name.padEnd(28)} ${(required.has(name) ? "required" : "optional").padEnd(10)} ${typeName(record)}${description}`
    const nested = depth < 1 && typeof record.properties === "object" && record.properties !== null
      ? fieldLines(record, depth + 1).map((child) => `  ${child}`)
      : []
    return [line, ...nested]
  })
}

export const renderText = (document: DescribeDocument): string => {
  if (document.kind === "index") {
    return [
      "Field reference for upim. Add --json for the machine-readable record.",
      "",
      ...document.resources.map((resource) => `${resource.describe.padEnd(36)} ${resource.summary}`)
    ].join("\n") + "\n"
  }
  if (document.kind === "group") {
    return [
      document.summary,
      "",
      ...document.operations.map((operation) => `${operation.method.padEnd(7)} ${operation.command.padEnd(42)} ${operation.summary}`),
      "",
      "Add the action name for fields, validation, and an example. Append --json for agents."
    ].join("\n") + "\n"
  }
  const body = document.body
  return [
    document.command,
    `${document.method} ${document.path}`,
    "",
    document.summary,
    "",
    line("Docs", document.docs),
    line("Errors", "JSON on stderr"),
    line("Validation", document.validation),
    ...(document.live.length > 0 ? ["", "Live dictionary", ...document.live.map((item) => `  ${item}`)] : []),
    ...(document.notes.length > 0 ? ["", ...document.notes] : []),
    "",
    "Parameters",
    ...(document.parameters.length === 0
      ? ["  none"]
      : document.parameters.map((parameter) => `  ${parameter.in.padEnd(6)} ${parameter.name.padEnd(22)} ${(parameter.required ? "required" : "optional").padEnd(10)} ${parameter.description}`)),
    "",
    "CLI",
    ...document.cli.map((flag) => `  ${flag.name.padEnd(20)} ${flag.description}`),
    ...(body
      ? [
          "",
          `Body  ${body.required ? "required" : "optional"}  ${body.mediaType}`,
          ...fieldLines(body.schema).map((item) => `  ${item}`),
          "",
          "Example",
          `  ${document.example.command}`,
          "",
          JSON.stringify(body.example, null, 2)
        ]
      : [
          "",
          "Example",
          `  ${document.example.command}`
        ]),
    "",
    "Agents: append --json for the schema, example, and status codes."
  ].join("\n") + "\n"
}

const schemaName = (schema: Schema.ConstraintDecoder<unknown>, fallback: string) => {
  const { root, definitions } = definitionsOf(schema)
  if (typeof root.title === "string") return root.title
  const ref = typeof root.$ref === "string" ? root.$ref : undefined
  const title = ref?.startsWith("#/$defs/") ? definitions[ref.slice("#/$defs/".length)]?.title : undefined
  return typeof title === "string" ? title : fallback
}

export const openApiDocument = () => {
  const componentSchemas: Record<string, unknown> = {}
  const paths: Record<string, Record<string, unknown>> = {}
  for (const entry of flatten()) {
    const operation = operationDocument(entry)
    const contract: Contract = contractFor(entry.action.method, entry.action.path)
    let requestBody: unknown
    if (contract.body) {
      const name = schemaName(contract.body.schema, operation.command.replaceAll(" ", "_"))
      componentSchemas[name] = jsonSchemaFor(contract.body.schema)
      requestBody = {
        required: operation.body?.required === true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${name}` },
            example: contract.body.example
          }
        }
      }
    }
    const pathItem = paths[operation.path] ?? {}
    pathItem[operation.method.toLowerCase()] = {
      operationId: entry.command.join("_"),
      summary: operation.summary,
      description: [operation.validation, ...operation.notes].filter((item) => item !== "").join("\n\n"),
      tags: [entry.command[0]],
      externalDocs: { url: operation.docs },
      parameters: operation.parameters.map((parameter) => ({
        name: parameter.name,
        in: parameter.in,
        required: parameter.required,
        description: parameter.description,
        schema: parameter.schema
      })),
      ...(requestBody ? { requestBody } : {}),
      responses: Object.fromEntries(operation.responses.map((response) => [
        String(response.status),
        { description: response.description }
      ]))
    }
    paths[operation.path] = pathItem
  }
  return {
    openapi: "3.1.0" as const,
    info: {
      title: "UnoPim 3.1 REST API via upim",
      version: "3.1.0",
      description: "Client contract for the upim CLI. It is generated from Effect schemas and the UnoPim 3.1 docs. It is not an official UnoPim OpenAPI document. Instance-defined fields, including product attribute values, are envelopes."
    },
    servers: [{
      url: "{baseUrl}",
      variables: { baseUrl: { default: "https://pim.example.com", description: "Site root. Do not include /api/v1/rest." } }
    }],
    tags: resources.map((resource) => ({ name: resource.name, description: resource.summary })),
    paths,
    components: {
      schemas: componentSchemas,
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "Access token from POST /oauth/token. upim obtains and refreshes it." }
      }
    },
    security: [{ bearer: [] }]
  }
}
