#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node"
import { Cause, Effect, Exit, type Runtime } from "effect"
import { CliError } from "effect/cli"
import { run } from "./cli.ts"
import { printFailure } from "./output.ts"
import { layer } from "./runtime.ts"

/**
 * Exit codes: 0 for success, help, and version; 2 for a command-line
 * mistake, which the CLI has already explained; 1 for a upim error, printed
 * as JSON on stderr; 130 when interrupted. runMain turns SIGINT and SIGTERM
 * into fiber interruption, so the token lock and other finalizers run first.
 */
const teardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isSuccess(exit)) return onExit(0)
  if (Cause.hasInterruptsOnly(exit.cause)) return onExit(130)
  const failure = Cause.squash(exit.cause)
  if (CliError.isCliError(failure)) {
    const tag = "_tag" in failure ? String(failure._tag) : ""
    return onExit(tag === "ShowHelp" || tag === "ShowVersion" ? 0 : 2)
  }
  printFailure(failure)
  onExit(1)
}

NodeRuntime.runMain(run.pipe(Effect.provide(layer)), { disableErrorReporting: true, teardown })
