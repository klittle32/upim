export type FilterClause = {
  readonly operator: string
  readonly value: unknown
}

export type FilterMap = Record<string, FilterClause[]>

const IN_OPERATORS = new Set(["IN", "NOT IN"])

const coerce = (operator: string, raw: string): unknown => {
  const value = raw.trim()
  if (value.startsWith("[") || value.startsWith("{")) {
    return JSON.parse(value) as unknown
  }
  if (IN_OPERATORS.has(operator)) {
    return value.split(",").map((part) => coerce("=", part))
  }
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  return value
}

/** Parse `key:operator:value`. Operator may be `=`, `>=`, `IN`, or `NOT IN`. */
export const parseFilter = (input: string): { readonly key: string; readonly clause: FilterClause } => {
  const first = input.indexOf(":")
  const second = input.indexOf(":", first + 1)
  if (first <= 0 || second <= first + 1) {
    throw new Error(`Invalid filter "${input}". Expected key:operator:value, for example sku:IN:a,b`)
  }
  const key = input.slice(0, first).trim()
  const operator = input.slice(first + 1, second).trim()
  const raw = input.slice(second + 1)
  if (!key || !operator) {
    throw new Error(`Invalid filter "${input}". Expected key:operator:value`)
  }
  return { key, clause: { operator, value: coerce(operator, raw) } }
}

export const mergeFilters = (filtersJson: string | undefined, clauses: readonly string[]): FilterMap => {
  const merged: FilterMap = {}
  if (filtersJson !== undefined && filtersJson.trim() !== "") {
    const parsed: unknown = JSON.parse(filtersJson)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("--filters must be a JSON object")
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        throw new Error(`--filters.${key} must be an array of { operator, value }`)
      }
      merged[key] = value as FilterClause[]
    }
  }
  for (const clause of clauses) {
    const parsed = parseFilter(clause)
    const existing = merged[parsed.key] ?? []
    merged[parsed.key] = [...existing, parsed.clause]
  }
  return merged
}

export const parsePair = (input: string, label: string): readonly [string, string] => {
  const index = input.indexOf("=")
  if (index <= 0) {
    throw new Error(`Invalid ${label} "${input}". Expected key=value`)
  }
  return [input.slice(0, index), input.slice(index + 1)]
}

export const fillPath = (template: string, params: Readonly<Record<string, string>>): string =>
  template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params[key]
    if (value === undefined || value === "") {
      throw new Error(`Missing path parameter {${key}}`)
    }
    return encodeURIComponent(value)
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
