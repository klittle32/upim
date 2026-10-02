import { createInterface } from "node:readline/promises"
import { Effect } from "effect"
import { UsageError } from "./errors.ts"

const readSecret = (label: string) =>
  new Promise<string>((resolve, reject) => {
    const input = process.stdin
    if (!input.isTTY) {
      reject(new Error(`Cannot prompt for ${label} without a TTY. Pass a flag or environment variable.`))
      return
    }
    const chars: string[] = []
    process.stderr.write(`${label}: `)
    input.setRawMode(true)
    input.resume()
    const cleanup = () => {
      input.setRawMode(false)
      input.pause()
      input.off("data", onData)
    }
    const onData = (buffer: Buffer) => {
      const text = buffer.toString("utf8")
      if (text === "\u0003") {
        cleanup()
        process.stderr.write("\n")
        reject(new Error("interrupted"))
        return
      }
      if (text === "\r" || text === "\n") {
        cleanup()
        process.stderr.write("\n")
        resolve(chars.join(""))
        return
      }
      if (text === "\u007f" || text === "\b") {
        chars.pop()
        return
      }
      if (text.startsWith("\u001b")) return
      chars.push(text)
    }
    input.on("data", onData)
  })

export const ask = (label: string, options?: { readonly secret?: boolean; readonly fallback?: string }) =>
  Effect.tryPromise({
    try: async () => {
      if (options?.secret) return await readSecret(label)
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const hint = options?.fallback ? ` (${options.fallback})` : ""
        const answer = (await rl.question(`${label}${hint}: `)).trim()
        return answer || options?.fallback || ""
      } finally {
        rl.close()
      }
    },
    catch: (error) => new UsageError({ message: error instanceof Error ? error.message : String(error) })
  })

export const confirm = (label: string, fallback = false) =>
  Effect.gen(function*() {
    const answer = (yield* ask(`${label} ${fallback ? "[Y/n]" : "[y/N]"}`)).trim().toLowerCase()
    if (answer === "") return fallback
    return answer === "y" || answer === "yes"
  })
