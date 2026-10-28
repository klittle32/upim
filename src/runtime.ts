import { NodeChildProcessSpawner, NodeCrypto, NodeFileSystem, NodePath, NodeStdio, NodeTerminal } from "@effect/platform-node"
import { Effect, Layer, Logger, Stdio, Terminal } from "effect"
import { FetchHttpClient } from "effect/http"
import { UsageError } from "./errors.ts"
import { TokenLocks } from "./locks.ts"
import { stderrLogger } from "./output.ts"

const files = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

// The platform terminal, except that the wizard refuses to start without a TTY
// instead of reading an empty stdin and exiting as if the user had quit.
const terminal = Layer.effect(
  Terminal.Terminal,
  Effect.gen(function*() {
    const node = yield* NodeTerminal.make()
    const stdio = yield* Stdio.Stdio
    return Terminal.make({
      columns: node.columns,
      rows: node.rows,
      display: node.display,
      readLine: node.readLine,
      readInput: Effect.gen(function*() {
        if (!(yield* stdio.stdinIsTerminal)) {
          return yield* Effect.die(new UsageError({ message: "--wizard needs an interactive terminal" }))
        }
        return yield* node.readInput
      })
    })
  })
).pipe(Layer.provide(NodeStdio.layer))

export const layer = Layer.mergeAll(
  FetchHttpClient.layer,
  files,
  NodeCrypto.layer,
  NodeStdio.layer,
  terminal,
  NodeChildProcessSpawner.layer.pipe(Layer.provide(files)),
  TokenLocks.layer,
  Logger.layer([stderrLogger])
)
