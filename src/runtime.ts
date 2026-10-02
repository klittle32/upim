import { Effect, FileSystem, Layer, Path, Queue, Sink, Stdio, Stream, Terminal } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"

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

const terminal = Terminal.make({
  columns: Effect.succeed(process.stdout.columns || 80),
  rows: Effect.succeed(process.stdout.rows || 24),
  display: (text) => Effect.sync(() => {
    process.stderr.write(text)
  }),
  readLine: Effect.die("Use upim prompts instead of Terminal.readLine"),
  readInput: Effect.gen(function*() {
    yield* Effect.scope
    return yield* Queue.unbounded<Terminal.UserInput>()
  })
})

export const layer = Layer.mergeAll(
  FetchHttpClient.layer,
  Path.layer,
  FileSystem.layerNoop({}),
  Layer.succeed(Stdio.Stdio, stdio),
  Layer.succeed(Terminal.Terminal, terminal),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("upim does not spawn child processes"))
  )
)
