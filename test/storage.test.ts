import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Effect, Fiber, FileSystem, Layer, Logger, Path, PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { emptyConfig, loadConfig, saveConfig, type ConfigFile } from "../src/config.ts"
import { AuthError, ConfigError } from "../src/errors.ts"
import { layer as nodeFileSystem } from "../src/filesystem.ts"
import { LockSettings, TokenLocks } from "../src/locks.ts"
import type { Locations } from "../src/paths.ts"
import {
  loadTokens,
  longestValidPrefix,
  makeTokenStore,
  saveTokens,
  withTokenLock,
  type StorageEnv,
  type TokenSet
} from "../src/tokens.ts"

// A fresh TokenLocks per run, so tests do not share permits or flights.
const storage = Layer.mergeAll(nodeFileSystem, Path.layer, NodeCrypto.layer, TokenLocks.layer)

const live = <A, E>(effect: Effect.Effect<A, E, StorageEnv>) =>
  Effect.runPromise(effect.pipe(Effect.provide(storage)))

/** Runs with a virtual clock: lock waits, stale checks, and timeouts advance only through TestClock.adjust. */
const clocked = <A, E>(effect: Effect.Effect<A, E, StorageEnv | TestClock.TestClock>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(storage, TestClock.layer()))))

const run = <A>(effect: Effect.Effect<A, unknown, StorageEnv>, fileSystem: FileSystem.FileSystem) =>
  Effect.runPromise(effect.pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provide(Layer.mergeAll(Path.layer, NodeCrypto.layer, TokenLocks.layer))
  ))

/** Collects log lines instead of printing them. */
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const warnings: string[] = []
    const collector = Logger.make<unknown, void>(({ message }) => {
      warnings.push(Array.isArray(message) ? message.map(String).join(" ") : String(message))
    })
    const value = yield* effect.pipe(Effect.provide(Logger.layer([collector])))
    return { value, warnings }
  })

const quickLocks = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, LockSettings, { pollMs: 10, staleMs: 10_000, waitMs: 5_000 })

/**
 * Step the virtual clock until the fiber finishes. The lock code does real file
 * I/O between sleeps, so each step also yields a sliver of live time for that
 * I/O to complete before the next virtual tick.
 */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>, limit = 2_000) =>
  Effect.gen(function*() {
    for (let step = 0; fiber.pollUnsafe() === undefined; step++) {
      assert.ok(step < limit, `fiber did not settle within ${limit} virtual steps`)
      yield* TestClock.adjust("10 millis")
      yield* TestClock.withLive(Effect.sleep("1 millis"))
    }
    return yield* Fiber.join(fiber)
  })

/** Hold for a number of virtual steps and report whether the fiber is still pending afterwards. */
const stillPendingAfter = <A, E>(fiber: Fiber.Fiber<A, E>, steps: number) =>
  Effect.gen(function*() {
    for (let step = 0; step < steps; step++) {
      yield* TestClock.adjust("10 millis")
      yield* TestClock.withLive(Effect.sleep("1 millis"))
    }
    return fiber.pollUnsafe() === undefined
  })

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

/** A lock file as another process would leave it, stamped at `at` on the virtual clock. */
const foreignLock = (lockPath: string, owner: string, at: number) =>
  writeFileSync(lockPath, `${JSON.stringify({ pid: 0, owner, at })}\n`, { flag: "wx" })

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
    (error: unknown) => error instanceof AuthError && /Could not read/.test(error.message) && PlatformError.isPlatformError(error.cause)
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
    (error: unknown) => error instanceof AuthError && /Could not write/.test(error.message) && PlatformError.isPlatformError(error.cause)
  )
})

test("an unreadable token file is treated as empty with a warning, not a hard error", async () => {
  for (const text of ["{", "", "not json", "{\"profiles\":{\"default\":{\"accessToken\":1}}}"]) {
    const broken = FileSystem.makeNoop({ readFileString: () => Effect.succeed(text) })
    const { value, warnings } = await run(captureLogs(loadTokens(locations("/virtual"))), broken)
    assert.deepEqual(value, { profiles: {} }, JSON.stringify(text))
    assert.deepEqual(warnings, ["Ignoring unreadable token file /virtual/tokens.json. Tokens will be requested again."])
  }
})

test("a torn token file parses from its longest valid prefix", async () => {
  // Two processes wrote at once: B's shorter document landed over A's longer
  // one, so the file is B's complete JSON followed by the tail of A's.
  const winner = document({ default: tokenSet("short"), other: tokenSet("kept") })
  const torn = `${winner.trimEnd()}\n}\n`
  assert.throws(() => JSON.parse(torn))
  assert.deepEqual(longestValidPrefix(torn), { value: JSON.parse(winner), end: winner.trimEnd().length })

  const paths = scratch()
  await live(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(join(paths.tokenPath, ".."), { recursive: true })
    yield* fs.writeFileString(paths.tokenPath, torn)
  }))
  const { value, warnings } = await live(captureLogs(loadTokens(paths)))
  assert.deepEqual(value, { profiles: { default: tokenSet("short"), other: tokenSet("kept") } })
  assert.deepEqual(warnings, [`Recovered ${paths.tokenPath} from a torn write by dropping 3 trailing byte(s)`])

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
  const codes = await Effect.runPromise(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* Effect.all(
      names.map((name) => spawner.exitCode(ChildProcess.make(process.execPath, [writer, paths.tokenPath, name, "5"], { stderr: "inherit" }))),
      { concurrency: "unbounded" }
    )
  }).pipe(Effect.provide(NodeServices.layer)))
  assert.deepEqual(codes.map(Number), names.map(() => 0))
  const saved = JSON.parse(readFileSync(paths.tokenPath, "utf8")) as { profiles: Record<string, TokenSet> }
  assert.deepEqual(Object.keys(saved.profiles).sort(), [...names].sort())
  for (const name of names) assert.equal(saved.profiles[name]?.accessToken, `access-${name}-4`)
  assert.equal(existsSync(`${paths.tokenPath}.lock`), false)
})

test("a second writer waits for the lock and then sees what the holder stored", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  await live(saveTokens(paths, { profiles: { default: tokenSet("old") } }))
  foreignLock(lock, "0:holder", 0)

  const store = makeTokenStore(paths, "default")
  const { seen, stillWaiting } = await clocked(quickLocks(Effect.gen(function*() {
    const waiter = yield* Effect.forkChild(store.exclusive(({ stored }) => Effect.succeed(stored)))
    // The holder stays busy for 200 ms of virtual time. The waiter polls and keeps failing.
    const stillWaiting = yield* stillPendingAfter(waiter, 20)
    // The holder finishes its refresh, stores the result, and releases.
    yield* saveTokens(paths, { profiles: { default: tokenSet("winner") } })
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(lock)
    return { seen: yield* settle(waiter), stillWaiting }
  })))
  assert.equal(stillWaiting, true)
  assert.deepEqual(seen, tokenSet("winner"))
  assert.equal(existsSync(lock), false)
})

test("a stale lock from a dead process is taken over", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  await live(saveTokens(paths, { profiles: {} }))
  foreignLock(lock, "0:dead", 0)

  const store = makeTokenStore(paths, "default")
  const stored = await clocked(quickLocks(Effect.gen(function*() {
    // Two minutes pass on the virtual clock; the stamp is far past the 10 s stale timeout.
    yield* TestClock.adjust("2 minutes")
    const writer = yield* Effect.forkChild(store.write(tokenSet("fresh")))
    // Takeover removes the file; the next poll creates the lock and the write proceeds.
    yield* settle(writer)
    return yield* store.read
  })))
  assert.deepEqual(stored, tokenSet("fresh"))
  assert.equal(existsSync(lock), false)
})

test("waiting for a live lock times out with a typed error that names the holder", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  await live(saveTokens(paths, { profiles: {} }))
  foreignLock(lock, "4242:busy", 0)
  const store = makeTokenStore(paths, "default")
  const outcome = await clocked(Effect.gen(function*() {
    const writer = yield* Effect.forkChild(store.write(tokenSet("blocked")).pipe(Effect.flip))
    return yield* settle(writer)
  }).pipe(Effect.provideService(LockSettings, { pollMs: 10, staleMs: 60_000, waitMs: 200 })))
  assert.ok(outcome instanceof AuthError)
  assert.match(outcome.message, /Timed out after 200 ms/)
  assert.match(outcome.message, /4242:busy/)
  assert.equal(existsSync(lock), true)
})

test("the lock is released after failure and after interrupt", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  const store = makeTokenStore(paths, "default")
  await assert.rejects(
    () => live(store.exclusive(() => Effect.fail(new AuthError({ message: "refresh failed" })))),
    /refresh failed/
  )
  assert.equal(existsSync(lock), false)

  const heldWhileRunning = await live(Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(store.exclusive(() => Effect.never))
    for (let attempt = 0; attempt < 50 && !existsSync(lock); attempt++) yield* Effect.sleep("10 millis")
    const held = existsSync(lock)
    yield* Fiber.interrupt(fiber)
    return held
  }))
  assert.equal(heldWhileRunning, true)
  assert.equal(existsSync(lock), false)
})

test("release leaves a lock that another process took over after a stale timeout", async () => {
  const paths = scratch()
  const lock = `${paths.tokenPath}.lock`
  const successor = JSON.stringify({ pid: 0, owner: "0:successor", at: 0 })
  const { warnings } = await live(captureLogs(withTokenLock(paths)(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const mine = JSON.parse(yield* fs.readFileString(lock)) as { owner: string; pid: number; at: number }
    assert.equal(mine.pid, process.pid)
    assert.match(mine.owner, new RegExp(`^${process.pid}:`))
    assert.equal(typeof mine.at, "number")
    // Simulate a waiter that decided this lock was stale and took it over.
    yield* fs.writeFileString(lock, successor)
  }))))
  assert.equal(existsSync(lock), true)
  assert.equal(readFileSync(lock, "utf8"), successor)
  assert.deepEqual(warnings, [
    `Leaving ${lock} in place: 0:successor took it over after this process held it past the stale timeout`
  ])

  // A lock file that no longer parses is treated as ours and cleaned up.
  await live(withTokenLock(paths)(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(lock, "garbage")
  })))
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
