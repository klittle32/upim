/**
 * Development log backed by @earendil-works/pi-durable and its runtime dependencies.
 * This is a dev tool. The installed `upim` CLI depends only on `effect`.
 */
import { mkdir } from "node:fs/promises"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { createRegistry, defineDoc, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import type { JsonValue } from "@earendil-works/chord"

const Journal = defineDoc<{ notes: JsonValue[] }>({
  kind: "dev.journal",
  version: 1,
  scope: "session",
  initial: () => ({ notes: [] })
})

const Step = defineTask<{ text: string }, { phase: "record" }, { text: string }, Record<string, never>>({
  name: "dev.step",
  version: 1,
  initial: () => ({ phase: "record" }),
  phases: {
    record: async (_task, runtime, context) => {
      await runtime.commit(() => ({
        status: "terminal",
        outcome: { status: "completed", result: { text: _task.input.text } }
      }), context)
    }
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({
      status: "terminal",
      outcome: { status: "aborted", reason: "aborted" }
    }), context)
  }
})

const DevTools = defineExtension({
  name: "upim-dev",
  tasks: [Step]
})

const text = process.argv.slice(2).join(" ").trim()
const context = BACKGROUND_CONTEXT
await mkdir(".durable", { recursive: true })
const storage = await openNodeSqliteStorage(".durable/upim.sqlite")
const models = createModels()
const registry = createRegistry()
registry.install(CodingTools)
registry.install(DevTools)
const harness = await Harness.open(storage, { models, registry }, context)
try {
  const root = await harness.root(context)
  if (text === "") {
    const notes = (await harness.snapshot(Journal, context))?.notes ?? []
    process.stdout.write(`${JSON.stringify(notes, null, 2)}\n`)
  } else {
    const taskId = await root.commit(async (tx) => {
      const doc = await tx.doc(Journal)
      doc.notes.push({ at: new Date().toISOString(), text })
      return await tx.createTask(Step, { text }, { ownership: { kind: "conversation" } })
    }, context)
    const settled = await harness.waitForTask(taskId, context)
    const notes = (await harness.snapshot(Journal, context))?.notes ?? []
    process.stdout.write(`${JSON.stringify({ settled: settled.state.outcome, notes: notes.length }, null, 2)}\n`)
  }
} finally {
  await harness.close(context)
}
