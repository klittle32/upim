import { Effect, Schema } from "effect"
import { Filters } from "./contract/schemas.ts"
import { UsageError } from "./errors.ts"

export type FilterClause = typeof Filters.Type[string][number]

export type FilterMap = Record<string, readonly FilterClause[]>

const IN_OPERATORS = new Set(["IN", "NOT IN"])

const invalid = (message: string, cause?: unknown) => new UsageError({ message, cause })

const decodeFilters = Schema.decodeUnknownEffect(Schema.fromJsonString(Filters))

/** A filter value: JSON when it looks like JSON, a list for IN operators, else a scalar with true/false/null recognised. */
const coerce = (operator: string, raw: string): Effect.Effect<unknown, UsageError> => {
  const value = raw.trim()
  if (value.startsWith("[") || value.startsWith("{")) {
    return Effect.try({
      try: () => JSON.parse(value) as unknown,
      catch: (error) => invalid(`Invalid JSON in filter value ${value}: ${String(error)}`, error)
    })
  }
  if (IN_OPERATORS.has(operator)) {
    return Effect.forEach(value.split(","), (part) => coerce("=", part))
  }
  if (value === "true") return Effect.succeed(true)
  if (value === "false") return Effect.succeed(false)
  if (value === "null") return Effect.succeed(null)
  return Effect.succeed(value)
}

/** Parse `key:operator:value`. Operator may be `=`, `>=`, `IN`, or `NOT IN`. */
export const parseFilter = (input: string): Effect.Effect<{ readonly key: string; readonly clause: FilterClause }, UsageError> => {
  const first = input.indexOf(":")
  const second = input.indexOf(":", first + 1)
  if (first <= 0 || second <= first + 1) {
    return invalid(`Invalid filter "${input}". Expected key:operator:value, for example sku:IN:a,b`)
  }
  const key = input.slice(0, first).trim()
  const operator = input.slice(first + 1, second).trim()
  const raw = input.slice(second + 1)
  if (!key || !operator) {
    return invalid(`Invalid filter "${input}". Expected key:operator:value`)
  }
  return Effect.map(coerce(operator, raw), (value) => ({ key, clause: { operator, value } }))
}

/** The `--filters` JSON object merged with every repeated `--filter` clause, checked against the Filters schema. */
export const mergeFilters = (filtersJson: string | undefined, clauses: readonly string[]): Effect.Effect<FilterMap, UsageError> =>
  Effect.gen(function*() {
    const merged: FilterMap = filtersJson !== undefined && filtersJson.trim() !== ""
      ? { ...yield* decodeFilters(filtersJson).pipe(Effect.mapError((error) => invalid(`Invalid --filters: ${error.message}`, error))) }
      : {}
    for (const clause of clauses) {
      const parsed = yield* parseFilter(clause)
      merged[parsed.key] = [...(merged[parsed.key] ?? []), parsed.clause]
    }
    return merged
  })

export const parsePair = (input: string, label: string): Effect.Effect<readonly [string, string], UsageError> => {
  const index = input.indexOf("=")
  if (index <= 0) return invalid(`Invalid ${label} "${input}". Expected key=value`)
  return Effect.succeed([input.slice(0, index), input.slice(index + 1)])
}

/** Every `key=value` pair as a record. Later pairs win. */
export const parsePairs = (inputs: readonly string[], label: string): Effect.Effect<Record<string, string>, UsageError> =>
  Effect.map(
    Effect.forEach(inputs, (input) => parsePair(input, label)),
    (pairs) => Object.fromEntries(pairs)
  )

export const fillPath = (template: string, params: Readonly<Record<string, string>>): Effect.Effect<string, UsageError> =>
  Effect.gen(function*() {
    let filled = ""
    let last = 0
    for (const match of template.matchAll(/\{([^}]+)\}/g)) {
      const key = match[1]!
      const value = params[key]
      if (value === undefined || value === "") {
        return yield* invalid(`Missing path parameter {${key}}`)
      }
      filled += template.slice(last, match.index) + encodeURIComponent(value)
      last = match.index + match[0].length
    }
    return filled + template.slice(last)
  })

export const resolveUrl = (baseUrl: string, pathOrUrl: string, query: Readonly<Record<string, string | undefined>>): URL => {
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value)
  }
  return url
}
