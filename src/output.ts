import { Logger } from "effect"
import { isAppError } from "./errors.ts"

export const emit = (value: unknown, json: boolean) => {
  const compact = json || !process.stdout.isTTY
  process.stdout.write(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`)
}

const describeCause = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause ? String(cause.message) : String(cause)

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
        ...(error._tag === "AuthError" && error.details !== undefined ? { details: error.details } : {}),
        ...("cause" in error && error.cause !== undefined ? { cause: describeCause(error.cause) } : {})
      }
    : { error: "Error", message: error instanceof Error ? error.message : String(error), path: null }
  const compact = !process.stderr.isTTY
  process.stderr.write(`${JSON.stringify(payload, null, compact ? undefined : 2)}\n`)
}

const logText = (message: unknown) =>
  Array.isArray(message) ? message.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ") : String(message)

/**
 * One JSON line per log entry on stderr, so a caller that reads the last
 * stderr line as JSON on failure still gets a document. Warnings keep the
 * `{"warning": ...}` shape that callers already know.
 */
export const stderrLogger = Logger.make<unknown, void>(({ logLevel, message }) => {
  const text = logText(message)
  const payload = logLevel === "Warn" ? { warning: text } : { level: logLevel, message: text }
  process.stderr.write(`${JSON.stringify(payload)}\n`)
})
