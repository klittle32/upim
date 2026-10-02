import assert from "node:assert/strict"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Fiber, FileSystem, PlatformError } from "effect"
import { emptyConfig, loadConfig, saveConfig, type ConfigFile } from "../src/config.ts"
import { AuthError, ConfigError } from "../src/errors.ts"
import { layer as nodeFileSystem } from "../src/filesystem.ts"
import type { Locations } from "../src/paths.ts"
import { loadTokens, saveTokens, type TokenSet } from "../src/tokens.ts"

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>, fileSystem: FileSystem.FileSystem) =>
  Effect.runPromise(effect.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)))

const locations = (directory: string): Locations => ({
  configPath: join(directory, "config.json"),
  tokenPath: join(directory, "tokens.json")
})

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

test("production filesystem layer persists private config and tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "upim-fs-"))
  const paths = locations(join(directory, "upim"))
  await Effect.runPromise(Effect.gen(function*() {
    yield* saveConfig(paths, config)
    assert.deepEqual(yield* loadConfig(paths), config)
    yield* saveTokens(paths, { profiles: { default: tokens } })
    assert.deepEqual(yield* loadTokens(paths), { profiles: { default: tokens } })
  }).pipe(Effect.provide(nodeFileSystem)))
  assert.equal(statSync(paths.configPath).mode & 0o777, 0o600)
  assert.equal(statSync(paths.tokenPath).mode & 0o777, 0o600)
  assert.equal(statSync(join(directory, "upim")).mode & 0o777, 0o700)
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
  await assert.rejects(
    () => run(loadTokens(paths), malformed),
    (error: unknown) => error instanceof AuthError && /Invalid token file/.test(error.message)
  )

  const unwritable = FileSystem.makeNoop({
    makeDirectory: () => Effect.void,
    writeFileString: () => Effect.fail(denied("writeFileString")),
    chmod: () => Effect.void
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
