#!/usr/bin/env node
import { Cause, Effect, Exit } from "effect"
import { CliError } from "effect/cli"
import { run } from "./cli.ts"
import { printFailure } from "./output.ts"
import { layer } from "./runtime.ts"

const exit = await Effect.runPromiseExit(run.pipe(Effect.provide(layer)))
if (Exit.isFailure(exit)) {
  const failure = Cause.squash(exit.cause)
  if (CliError.isCliError(failure)) {
    const tag = "_tag" in failure ? String(failure._tag) : ""
    process.exit(tag === "ShowHelp" || tag === "ShowVersion" ? 0 : 2)
  }
  printFailure(failure)
  process.exit(1)
}
