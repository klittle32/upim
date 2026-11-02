import { Effect, Redacted } from "effect"
import { Prompt } from "effect/cli"
import { UsageError } from "./errors.ts"

const cancelled = () => new UsageError({ message: "interrupted" })

/**
 * One line of input through the Terminal service. `secret` hides the
 * keystrokes and `fallback` is the answer when the user just presses enter.
 * Callers check `Stdio.stdinIsTerminal` first; without a TTY the runtime's
 * terminal refuses to read.
 */
export const ask = (label: string, options?: { readonly secret?: boolean; readonly fallback?: string }) =>
  Prompt.run(
    options?.secret
      ? Prompt.Password({ message: label }).pipe(Prompt.map(Redacted.value))
      // Prompt.String spreads its options over a default of "", so the key must be absent rather than undefined.
      : Prompt.String({ message: label, ...(options?.fallback !== undefined ? { default: options.fallback } : {}) })
  ).pipe(
    Effect.map((answer) => answer.trim() || options?.fallback || ""),
    Effect.catchTag("QuitError", cancelled)
  )

export const confirm = (label: string, fallback = false) =>
  Prompt.run(Prompt.Confirm({ message: label, initial: fallback })).pipe(Effect.catchTag("QuitError", cancelled))
