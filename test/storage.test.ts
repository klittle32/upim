import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { NodeCrypto } from "@effect/platform-node"
import { type Crypto, Effect, Fiber, FileSystem, Layer, Path, PlatformError } from "effect"
import { emptyConfig, loadConfig, saveConfig, type ConfigFile } from "../src/config.ts"
import { AuthError, ConfigError } from "../src/errors.ts"
import { layer as nodeFileSystem } from "../src/filesystem.ts"
import type { Locations } from "../src/paths.ts"
import { loadTokens, longestValidPrefix, makeTokenStore, saveTokens, withTokenLock, type TokenSet } from "../src/tokens.ts"

const storage = Layer.mergeAll(nodeFileSystem, Path.layer, NodeCrypto.layer)

type Services = FileSystem.FileSystem | Path.Path | Crypto.Crypto

const live = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(storage)))

const run = <A>(effect: Effect.Effect<A, unknown, Services>, fileSystem: FileSystem.FileSystem) =>
  Effect.runPromise(effect.pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provide(Layer.mergeAll(Path.layer, NodeCrypto.layer))
  ))

const locations = (directory: string): Locations => ({
  configPath: join(directory, "config.json"),
  tokenPath: join(directory, "tokens.json")
})

const scratch = () => locations(join(mkdtempSync(join(tmpdir(), "upim-fs-")), "upim"))

const denied = (method: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method
  })

const missing = (method: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method
  })

const config: ConfigFile = {
  current: "default",
  profiles: {
    default: {
      baseUrl: "https://pim.example.com",
      clientId: "id",
      clientSecret: "secret"
    }
  }
}

const tokens: TokenSet = {
  accessToken: "access",
  refreshToken: "refresh",
  tokenType: "Bearer",
  expiresAt: 1_700_000_000_000
}

const tokenSet = (label: string): TokenSet => ({ ...tokens, accessToken: `access-${label}` })

const document = (profiles: Record<string, TokenSet>) => `${JSON.stringify({ profiles }, null, 2)}\n`

const quiet = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const write = process.stderr.write.bind(process.stderr)
  const lines: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return Effect.ensuring(effect, Effect.sync(() => {
    process.stderr.write = write
  })).pipe(Effect.map((value) => ({ value, warnings: lines })))
}

test("production filesystem layer persists private config and tokens", async () => {
  const paths = scratch()
  await live(Effect.gen(function*() {
    yield* saveConfig(paths, config)
    assert.deepEqual(yield* loadConfig(paths), config)
    const store = makeTokenStore(paths, "default")
    yield* store.write(tokens)
    assert.deepEqual(yield* loadTokens(paths), { profiles: { default: tokens } })
    assert.deepEqual(yield* store.read, tokens)
    yield* store.write(undefined)
    assert.deepEqual(yield* loadTokens(paths), { profiles: {} })
  }))
  assert.equal(statSync(paths.configPath).mode & 0o777, 0o600)
  assert.equal(statSync(paths.tokenPath).mode & 0o777, 0o600)
  assert.equal(statSync(join(paths.tokenPath, "..")).mode & 0o777, 0o700)
  assert.equal(existsSync(`${paths.tokenPath}.lock`), false)
  assert.equal(existsSync(`${paths.tokenPath}.${process.pid}.tmp`), false)
})

test("missing files are empty and bad JSON or permissions are typed errors", async () => {
  const paths = locations("/virtual")
  const absent = FileSystem.makeNoop({
    readFileString: () => Effect.fail(missing("readFileString"))
  })
  assert.deepEqual(await run(loadConfig(paths), absent), emptyConfig())
  assert.deepEqual(await run(loadTokens(paths), absent), { profiles: {} })

  const unreadable = FileSystem.makeNoop({
    readFileString: (path) => Effect.fail(denied(`readFileString ${path}`))
  })
  await assert.rejects(
    () => run(loadConfig(paths), unreadable),
    (error: unknown) => error instanceof ConfigError && /Could not read/.test(error.message)
  )
  await assert.rejects(
    () => run(loadTokens(paths), unreadable),
    (error: unknown) => error instanceof AuthError && /Could not read/.test(error.message)
  )

  const malformed = FileSystem.makeNoop({
    readFileString: () => Effect.succeed("{")
  })
  await assert.rejects(
    () => run(loadConfig(paths), malformed),
    (error: unknown) => error instanceof ConfigError && /Invalid JSON/.test(error.message)
  )

  const unwritable = FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    writeFileString: () => Effect.fail(denied("writeFileString")),
    chmod: () => Effect.void,
    remove: () => Effect.void
  })
  await assert.rejects(
    () => run(saveConfig(paths, config), unwritable),
    (error: unknown) => error instanceof ConfigError && /Could not write/.test(error.message)
  )
  await assert.rejects(
    () => run(saveTokens(paths, { profiles: {} }), unwritable),
    (error: unknown) => error instanceof AuthError && /Could not write/.test(error.message)
  )
})

test("an unreadable token file is treated as empty with a warning, not a hard error", async () => {
  for (const text of ["{", "", "not json", "{\"profiles\":{\"default\":{\"accessToken\":1}}}"]) {
    const broken = FileSystem.makeNoop({ readFileString: () => Effect.succeed(text) })
    const { value, warnings } = await run(quiet(loadTokens(locations("/virtual"))), broken)
    assert.deepEqual(value, { profiles: {} }, JSON.stringify(text))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /"warning"/)
  }
})

test("a torn token file parses from its longest valid prefix", async () => {
  // Two processes wrote at once: B's shorter document landed over A's longer
  // one, so the file is B's complete JSON followed by the tail of A's.
  const winner = document({ default: tokenSet("short"), other: tokenSet("kept") })
  const torn = `${winner.trimEnd()}\n}\n`
  assert.throws(() => JSON.parse(torn))
  assert.deepEqual(longestValidPrefix(torn), JSON.parse(winner))

  const paths = scratch()
  await live(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(join(paths.tokenPath, ".."), { recursive: true })
    yield* fs.writeFileString(paths.tokenPath, torn)
  }))
  const { value, warnings } = await live(quiet(loadTokens(paths)))
  assert.deepEqual(value, { profiles: { default: tokenSet("short"), other: tokenSet("kept") } })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /torn write/)

  // A write after recovery leaves a clean file behind.
  await live(makeTokenStore(paths, "default").write(tokenSet("healed")))
  assert.deepEqual(JSON.parse(readFileSync(paths.tokenPath, "utf8")), {
    profiles: { default: tokenSet("healed"), other: tokenSet("kept") }
  })
  assert.equal(longestValidPrefix("{\"a\":"), undefined)
})

test("parallel saves from many fibers never tear the file or drop a profile", async () => {
  const paths = scratch()
  const names = Array.from({ length: 40 }, (_, index) => `profile-${index}`)
  await live(Effect.all(
    names.map((name) => makeTokenStore(paths, name).write(tokenSet(name))),
    { concurrency: "unbounded" }
  ))
  const saved = JSON.parse(readFileSync(paths.tokenPath, "utf8")) as { profiles: Record<string, TokenSet> }
  assert.deepEqual(Object.keys(saved.profiles).sort(), [...names].sort())

  // Many writers to one profile: the file stays valid and holds one of the writes intact.
  const values = Array.from({ length: 25 }, (_, index) => tokenSet(`same-${index}`))
  await live(Effect.all(
    values.map((value) => makeTokenStore(paths, "default").write(value)),
    { concurrency: "unbounded" }
  ))
  const after = JSON.parse(readFileSync(paths.tokenPath, "utf8")) as { profiles: Record<string, TokenSet> }
  assert.ok(values.some((value) => value.accessToken === after.profiles.default?.accessToken))
  assert.equal(Object.keys(after.profiles).length, names.length + 1)
  assert.equal(existsSync(`${paths.tokenPath}.lock`), false)
})

test("parallel saves from separate processes serialize on the lock file", async () => {
  const paths = scratch()
  const writer = join(import.meta.dirname, "fixtures", "token-writer.ts")
  const names = Array.from({ length: 8 }, (_, index) => `process-${index}`)
  const results = await Promise.all(names.map((name) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [writer, paths.tokenPath, name, "5"], { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("close", (code) => resolve({ code, stderr }))
  })))
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  const saved = JSON.parse(readFileSync(paths.tokenPath, "utf8")) as { profiles: Record<string, TokenSet> }
  assert.deepEqual(Object.keys(saved.profiles).sort(), [...names].sort())
  for (const name of names) assert.equal(saved.profiles[name]?.accessToken, `access-${name}-4`)
  assert.equal(existsSync(`${paths.tokenPath}.lock`), false)
})

test("a second writer waits for the lock and then sees what the holder stored", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  await live(saveTokens(paths, { profiles: { default: tokenSet("old") } }))
  writeFileSync(lock, JSON.stringify({ pid: 0 }), { flag: "wx" })

  const store = makeTokenStore(paths, "default", { pollMs: 10, staleMs: 10_000, waitMs: 5_000 })
  const started = Date.now()
  const seen = await live(Effect.gen(function*() {
    const waiter = yield* Effect.forkChild(store.exclusive(({ stored }) => Effect.succeed(stored)))
    yield* Effect.sleep("200 millis")
    // The holder finishes its refresh, stores the result, and releases.
    yield* saveTokens(paths, { profiles: { default: tokenSet("winner") } })
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(lock)
    return yield* Fiber.join(waiter)
  }))
  assert.ok(Date.now() - started >= 180)
  assert.deepEqual(seen, tokenSet("winner"))
  assert.equal(existsSync(lock), false)
})

test("a stale lock from a dead process is taken over", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  await live(saveTokens(paths, { profiles: {} }))
  writeFileSync(lock, JSON.stringify({ pid: 0 }), { flag: "wx" })
  const twoMinutesAgo = new Date(Date.now() - 120_000)
  utimesSync(lock, twoMinutesAgo, twoMinutesAgo)

  const store = makeTokenStore(paths, "default", { pollMs: 10, staleMs: 1_000, waitMs: 2_000 })
  const started = Date.now()
  await live(store.write(tokenSet("fresh")))
  assert.ok(Date.now() - started < 1_000)
  assert.deepEqual(await live(store.read), tokenSet("fresh"))
  assert.equal(existsSync(lock), false)
})

test("waiting for a live lock times out with a typed error and the lock is released after failure", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  await live(saveTokens(paths, { profiles: {} }))
  writeFileSync(lock, JSON.stringify({ pid: 4242 }), { flag: "wx" })
  const store = makeTokenStore(paths, "default", { pollMs: 10, staleMs: 60_000, waitMs: 200 })
  await assert.rejects(
    () => live(store.write(tokenSet("blocked"))),
    (error: unknown) => error instanceof AuthError && /Timed out/.test(error.message) && /4242/.test(error.message)
  )
  assert.equal(existsSync(lock), true)
  await live(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(lock)
  }))

  const failing = makeTokenStore(paths, "default", { pollMs: 10, staleMs: 60_000, waitMs: 200 })
  await assert.rejects(
    () => live(failing.exclusive(() => Effect.fail(new AuthError({ message: "refresh failed" })))),
    /refresh failed/
  )
  assert.equal(existsSync(lock), false)

  const interrupted = await live(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(failing.exclusive(() => Effect.never))
    for (let attempt = 0; attempt < 50 && !existsSync(lock); attempt++) yield* Effect.sleep("10 millis")
    const held = existsSync(lock)
    yield* Fiber.interrupt(fiber)
    return held
  }))
  assert.equal(interrupted, true)
  assert.equal(existsSync(lock), false)
})

test("release leaves a lock that another process took over after a stale timeout", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  const successor = JSON.stringify({ pid: 0, owner: "0:successor" })
  const { warnings } = await live(quiet(withTokenLock(paths)(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const mine = JSON.parse(yield* fs.readFileString(lock)) as { owner: string; pid: number }
    assert.equal(mine.pid, process.pid)
    assert.match(mine.owner, new RegExp(`^${process.pid}:`))
    // Simulate a waiter that decided this lock was stale and took it over.
    yield* fs.writeFileString(lock, successor)
  }))))
  assert.equal(existsSync(lock), true)
  assert.equal(readFileSync(lock, "utf8"), successor)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /0:successor took it over/)

  // A lock file that no longer parses is treated as ours and cleaned up.
  await live(withTokenLock(paths)(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(lock, "garbage")
  })))
  assert.equal(existsSync(lock), false)
  await live(withTokenLock(paths)(Effect.void))
  assert.equal(existsSync(lock), false)
})

test("an interrupted config write can be retried", async () => {
  const paths = locations("/virtual")
  let started = false
  let stored: string | undefined
  const blocking = FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    writeFileString: () => Effect.sync(() => {
      started = true
    }).pipe(Effect.andThen(Effect.never)),
    chmod: () => Effect.void
  })
  await run(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(saveConfig(paths, config))
    for (let attempt = 0; attempt < 20 && !started; attempt++) yield* Effect.yieldNow
    assert.equal(started, true)
    yield* Fiber.interrupt(fiber)
  }), blocking)

  const memory = FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    writeFileString: (_path, data) => Effect.sync(() => {
      stored = data
    }),
    chmod: () => Effect.void,
    readFileString: () => stored === undefined
      ? Effect.fail(missing("readFileString"))
      : Effect.succeed(stored)
  })
  await run(saveConfig(paths, config), memory)
  assert.deepEqual(await run(loadConfig(paths), memory), config)
})
