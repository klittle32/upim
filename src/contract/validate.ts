import { Effect, Schema, SchemaIssue } from "effect"
import type { Action } from "../catalog.ts"
import { UsageError } from "../errors.ts"
import { contractFor, validationNote } from "./operations.ts"
import { Filters } from "./schemas.ts"

const encodePointer = (key: PropertyKey) =>
  String(key).replaceAll("~", "~0").replaceAll("/", "~1")

export const issuePointer = (issue: SchemaIssue.Issue): string | null => {
  const keys: PropertyKey[] = []
  const walk = (node: SchemaIssue.Issue): boolean => {
    if (node._tag === "Pointer") {
      keys.push(...node.path)
      return walk(node.issue)
    }
    if (node._tag === "Filter" || node._tag === "Encoding") return walk(node.issue)
    if (node._tag === "Composite" || node._tag === "AnyOf") {
      for (const child of node.issues) {
        const mark = keys.length
        if (walk(child)) return true
        keys.length = mark
      }
      return false
    }
    return true
  }
  if (!walk(issue) || keys.length === 0) return null
  return `/${keys.map(encodePointer).join("/")}`
}

const failure = (error: unknown, prefix: string) =>
  new UsageError({
    message: `${prefix} ${validationNote} ${error instanceof Error ? error.message : String(error)}`,
    ...(Schema.isSchemaError(error) && issuePointer(error.issue) ? { path: issuePointer(error.issue)! } : {})
  })

export const checkBody = (action: Action, body: unknown) => {
  const contract = contractFor(action.method, action.path)
  if (contract.body === undefined || body === undefined) return Effect.void
  return Schema.decodeUnknownEffect(contract.body.schema)(body).pipe(
    Effect.mapError((error) => failure(error, `Local schema check failed for ${action.method} ${action.path}.`)),
    Effect.asVoid
  )
}

export const checkFilters = (filtersJson: string | undefined) => {
  if (filtersJson === undefined || filtersJson === "") return Effect.void
  return Effect.try({
    try: () => JSON.parse(filtersJson) as unknown,
    catch: (error) => failure(error, "Invalid filters.")
  }).pipe(Effect.flatMap((parsed) => Schema.decodeUnknownEffect(Filters)(parsed).pipe(
    Effect.mapError((error) => failure(error, "Invalid filters."))
  )))
}
