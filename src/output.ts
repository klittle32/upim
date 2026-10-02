import { isAppError } from "./errors.ts"

export const emit = (value: unknown, json: boolean) => {
  const compact = json || !process.stdout.isTTY
  process.stdout.write(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`)
}

const failurePath = (error: object): string | null =>
  "path" in error && typeof error.path === "string" && error.path !== "" ? error.path : null

export const printFailure = (error: unknown) => {
  const payload = isAppError(error)
    ? {
        error: error._tag,
        message: error.message,
        path: failurePath(error),
        ...(error._tag === "ApiError"
          ? { status: error.status, method: error.method, url: error.url, body: error.body }
          : {}),
        ...(error._tag === "AuthError" && error.details !== undefined ? { details: error.details } : {})
      }
    : { error: "Error", message: error instanceof Error ? error.message : String(error), path: null }
  const compact = !process.stderr.isTTY
  process.stderr.write(`${JSON.stringify(payload, null, compact ? undefined : 2)}\n`)
}
