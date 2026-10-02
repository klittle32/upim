import { emitKeypressEvents, type Key } from "node:readline"
import { type Cause, Effect, Layer, Option, Path, Queue, Sink, Stdio, Stream, Terminal } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { UsageError } from "./errors.ts"
import { layer as nodeFileSystem } from "./filesystem.ts"

const stdio = Stdio.make({
  args: Effect.succeed(process.argv.slice(2)),
  stdin: Stream.empty,
  stdinIsTerminal: Effect.succeed(Boolean(process.stdin.isTTY)),
  stdoutIsTerminal: Effect.succeed(Boolean(process.stdout.isTTY)),
  stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => {
    process.stdout.write(chunk)
  })),
  stderr: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => {
    process.stderr.write(chunk)
  }))
})

// Effect's --wizard reads Terminal.readInput. The queue has to be fed from stdin,
// and stdin has to stay referenced, or Node drains the event loop and exits
// while the top-level await in main.ts is still pending.
const terminal = Terminal.make({
  columns: Effect.sync(() => process.stdout.columns || 80),
  rows: Effect.sync(() => process.stdout.rows || 24),
  display: (text) => Effect.sync(() => {
    process.stderr.write(text)
  }),
  readLine: Effect.die("Use upim prompts instead of Terminal.readLine"),
  readInput: Effect.gen(function*() {
    const queue = yield* Queue.unbounded<Terminal.UserInput, Cause.Done>()
    const input = process.stdin
    if (!input.isTTY || input.setRawMode === undefined) {
      return yield* Effect.die(new UsageError({ message: "--wizard needs an interactive terminal" }))
    }

    const onKeypress = (sequence: string | undefined, key?: Key) => {
      if (key?.ctrl && key.name === "c") {
        Queue.endUnsafe(queue)
        return
      }
      Queue.offerUnsafe(queue, {
        input: sequence === undefined ? Option.none() : Option.some(sequence),
        key: {
          name: key?.name ?? "",
          ctrl: key?.ctrl === true,
          meta: key?.meta === true,
          shift: key?.shift === true
        }
      })
    }
    const onEnd = () => {
      Queue.endUnsafe(queue)
    }

    yield* Effect.addFinalizer(() => Effect.sync(() => {
      input.off("keypress", onKeypress)
      input.off("end", onEnd)
      input.setRawMode?.(false)
      input.pause()
      input.unref()
      Queue.endUnsafe(queue)
    }))

    emitKeypressEvents(input)
    input.setRawMode(true)
    input.on("keypress", onKeypress)
    input.on("end", onEnd)
    input.ref()
    input.resume()
    return queue
  })
})

export const layer = Layer.mergeAll(
  FetchHttpClient.layer,
  Path.layer,
  nodeFileSystem,
  Layer.succeed(Stdio.Stdio, stdio),
  Layer.succeed(Terminal.Terminal, terminal),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("upim does not spawn child processes"))
  )
)
