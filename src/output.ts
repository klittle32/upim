import { Cause, Effect, Logger, Stdio, Stream } from "effect"
import { isAppError } from "./errors.ts"

/** Write `text` to standard output through the Stdio service. A broken stdout is a defect, there is no one left to tell. */
export const writeStdout = (text: string) =>
  Effect.flatMap(Stdio.Stdio, (stdio) => Stream.succeed(text).pipe(Stream.run(stdio.stdout()))).pipe(Effect.orDie)

/** Print a result as JSON: compact for pipes and --json, indented on a terminal. */
export const emit = (value: unknown, json: boolean) =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio
    const compact = json || !(yield* stdio.stdoutIsTerminal)
    yield* writeStdout(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`)
  })

const describeCause = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "message" in cause ? String(cause.message) : String(cause)

const failurePath = (error: object): string | null =>
  "path" in error && typeof error.path === "string" && error.path !== "" ? error.path : null

/** The final error as one JSON document on stderr. Runs in teardown, after the runtime is gone, so it writes directly. */
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

/** One log entry as text: the message, then the failure it reports when the entry carries one. */
export const logLine = (message: unknown, cause: Cause.Cause<unknown>) => {
  const text = logText(message)
  return cause.reasons.length === 0 ? text : `${text} ${describeCause(Cause.squash(cause))}`
}

/**
 * One JSON line per log entry on stderr, so a caller that reads the last
 * stderr line as JSON on failure still gets a document. Warnings keep the
 * `{"warning": ...}` shape that callers already know.
 */
export const stderrLogger = Logger.make<unknown, void>(({ cause, logLevel, message }) => {
  const text = logLine(message, cause)
  const payload = logLevel === "Warn" ? { warning: text } : { level: logLevel, message: text }
  process.stderr.write(`${JSON.stringify(payload)}\n`)
})
