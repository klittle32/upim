import { Clock, Crypto, Data, Effect, FileSystem, Option, Path, Schedule, Schema, Semaphore } from "effect"
import { AuthError } from "./errors.ts"
import { isAlreadyExists, isNotFound } from "./filesystem.ts"
import { LockSettings, TokenLocks } from "./locks.ts"
import type { Locations } from "./paths.ts"

export const TokenSetSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  tokenType: Schema.String,
  expiresAt: Schema.Finite
})

export type TokenSet = typeof TokenSetSchema.Type

const TokenFileSchema = Schema.Struct({
  profiles: Schema.Record(Schema.String, TokenSetSchema)
})

export type TokenFile = typeof TokenFileSchema.Type

const empty = (): TokenFile => ({ profiles: {} })

/** Everything token storage needs from the environment. */
export type StorageEnv = FileSystem.FileSystem | Path.Path | Crypto.Crypto | TokenLocks

/**
 * The longest prefix of `text` that parses as JSON, with where it ends, or
 * undefined. The token file is an object, so only prefixes ending in `}` are
 * tried. A torn file from two concurrent writers is one complete document
 * with a few bytes of the other document's tail after it.
 */
export const longestValidPrefix = (text: string): { readonly value: unknown; readonly end: number } | undefined => {
  for (let end = text.length; end > 0; end--) {
    if (text[end - 1] !== "}") continue
    try {
      return { value: JSON.parse(text.slice(0, end)) as unknown, end }
    } catch {
      continue
    }
  }
  return undefined
}

const decodeTokenFile = Schema.decodeUnknownEffect(TokenFileSchema)
const decodeTokenText = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenFileSchema))

/**
 * Parse the token file leniently. Unreadable content is treated as empty so
 * that the next call falls back to the password grant and rewrites the file,
 * instead of every call failing until someone repairs it by hand.
 */
const parseTokenFile = Effect.fnUntraced(function*(path: string, text: string) {
  const whole = yield* decodeTokenText(text).pipe(Effect.option)
  if (Option.isSome(whole)) return whole.value
  const prefix = longestValidPrefix(text)
  const recovered = prefix === undefined
    ? Option.none()
    : yield* decodeTokenFile(prefix.value).pipe(Effect.option)
  if (Option.isSome(recovered) && prefix !== undefined) {
    yield* Effect.logWarning(`Recovered ${path} from a torn write by dropping ${text.length - prefix.end} trailing byte(s)`)
    return recovered.value
  }
  yield* Effect.logWarning(`Ignoring unreadable token file ${path}. Tokens will be requested again.`)
  return empty()
})

export const loadTokens = Effect.fn("tokens.loadTokens")(function*(locations: Locations) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(locations.tokenPath).pipe(
    Effect.catch((error) => isNotFound(error)
      ? Effect.succeed(undefined)
      : Effect.fail(new AuthError({ message: `Could not read ${locations.tokenPath}: ${error.message}`, cause: error })))
  )
  if (text === undefined) return empty()
  return yield* parseTokenFile(locations.tokenPath, text)
})

/**
 * Write the whole token file atomically: a private temp file in the same
 * directory, then rename over the target. Readers see the old document or
 * the new one, never a mix of two writers.
 */
export const saveTokens = Effect.fn("tokens.saveTokens")(
  function*(locations: Locations, file: TokenFile) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = locations.tokenPath
    const temporary = `${target}.${process.pid}.tmp`
    yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 })
    yield* Effect.gen(function*() {
      yield* fs.writeFileString(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      yield* fs.chmod(temporary, 0o600)
      yield* fs.rename(temporary, target)
    }).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
  },
  (effect, locations) => Effect.mapError(effect, (error) =>
    new AuthError({ message: `Could not write ${locations.tokenPath}: ${error.message}`, cause: error }))
)

class LockBusy extends Data.TaggedError("LockBusy")<{
  readonly path: string
  readonly holder: string
}> {}

const lockPathFor = (locations: Locations) => `${locations.tokenPath}.lock`

const lockFailure = (path: string) => (error: { readonly message: string }) =>
  new AuthError({ message: `Could not lock ${path}: ${error.message}`, cause: error })

type Lock = {
  readonly path: string
  /** pid plus a random nonce, written into the file so release can tell its own lock from a successor's. */
  readonly owner: string
}

/** What a live holder writes into the lock file. `at` is the holder's clock in epoch milliseconds. */
const LockStampSchema = Schema.Struct({
  pid: Schema.Number,
  owner: Schema.String,
  at: Schema.Number
})

const decodeLockStamp = Schema.decodeUnknownEffect(Schema.fromJsonString(LockStampSchema))

const readLockStamp = (fs: FileSystem.FileSystem, lockPath: string) =>
  fs.readFileString(lockPath).pipe(
    Effect.flatMap(decodeLockStamp),
    Effect.option
  )

/** One attempt to create the lock file. Fails with LockBusy while another live process holds it. */
const tryLock = Effect.fnUntraced(function*(fs: FileSystem.FileSystem, lockPath: string, owner: string, staleMs: number) {
  const now = yield* Clock.currentTimeMillis
  const stamp = `${JSON.stringify({ pid: process.pid, owner, at: now })}\n`
  const created = yield* fs.writeFileString(lockPath, stamp, { flag: "wx", mode: 0o600 }).pipe(
    Effect.as(true),
    Effect.catch((error) => isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(lockFailure(lockPath)(error)))
  )
  if (created) return
  const holder = yield* readLockStamp(fs, lockPath)
  // A stamp that does not parse is dated by the file instead.
  const since = Option.isSome(holder)
    ? Option.some(holder.value.at)
    : yield* fs.stat(lockPath).pipe(
      Effect.map((info) => Option.map(info.mtime, (date) => date.getTime())),
      Effect.orElseSucceed(() => Option.none<number>())
    )
  if (Option.isSome(since) && now - since.value > staleMs) {
    // Rename first so only one waiter wins the takeover, then drop the renamed file.
    const abandoned = `${lockPath}.stale.${process.pid}`
    yield* fs.rename(lockPath, abandoned).pipe(
      Effect.andThen(fs.remove(abandoned)),
      Effect.ignore
    )
  }
  return yield* new LockBusy({
    path: lockPath,
    holder: Option.isSome(holder) ? holder.value.owner : "an unknown process"
  })
})

const acquireLock = Effect.fn("tokens.acquireLock")(function*(lockPath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const settings = yield* LockSettings
  const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(lockFailure(lockPath)))
  const owner = `${process.pid}:${nonce}`
  yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true, mode: 0o700 }).pipe(
    Effect.mapError(lockFailure(lockPath))
  )
  yield* tryLock(fs, lockPath, owner, settings.staleMs).pipe(
    Effect.retry({
      while: (error) => error._tag === "LockBusy",
      schedule: Schedule.spaced(`${settings.pollMs} millis`).pipe(
        Schedule.jittered,
        Schedule.upTo({ duration: `${settings.waitMs} millis` })
      )
    }),
    Effect.catchTag("LockBusy", (busy) => new AuthError({
      message: `Timed out after ${settings.waitMs} ms waiting for the token lock ${busy.path} held by ${busy.holder}. Remove the file if that process is gone.`
    }))
  )
  return { path: lockPath, owner } satisfies Lock
})

/**
 * Release the lock only while it is still ours. If this process stalled past
 * the stale timeout, a waiter has taken the lock over, and deleting the file
 * now would let a third process in while the waiter is mid-refresh.
 */
const releaseLock = Effect.fnUntraced(function*(lock: Lock) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(lock.path).pipe(Effect.orElseSucceed(() => false))
  if (!exists) return
  const holder = yield* readLockStamp(fs, lock.path)
  if (Option.isSome(holder) && holder.value.owner !== lock.owner) {
    yield* Effect.logWarning(`Leaving ${lock.path} in place: ${holder.value.owner} took it over after this process held it past the stale timeout`)
    return
  }
  yield* fs.remove(lock.path).pipe(Effect.ignore)
})

/**
 * Run `work` while holding the cross-process token lock. The lock is a
 * scoped resource, so it is released on success, failure, and interrupt.
 */
export const withTokenLock = (locations: Locations) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | AuthError, R | StorageEnv> =>
    Effect.gen(function*() {
      const lockPath = lockPathFor(locations)
      const locks = yield* TokenLocks
      const locked = Effect.acquireRelease(acquireLock(lockPath), releaseLock).pipe(
        Effect.andThen(work),
        Effect.scoped
      )
      return yield* Semaphore.withPermit(locks.permit(lockPath))(locked)
    }).pipe(Effect.withSpan("tokens.withTokenLock"))

/** The token file as seen while holding the lock, plus a way to replace one profile's tokens. */
export type LockedTokens = {
  readonly stored: TokenSet | undefined
  readonly commit: (tokens: TokenSet | undefined) => Effect.Effect<void, AuthError, StorageEnv>
}

export type TokenStore = {
  /** The profile's saved tokens, without locking. */
  readonly read: Effect.Effect<TokenSet | undefined, AuthError, StorageEnv>
  /** Replace or delete the profile's tokens under the lock. Other profiles are preserved. */
  readonly write: (tokens: TokenSet | undefined) => Effect.Effect<void, AuthError, StorageEnv>
  /**
   * Take the lock, re-read the file, and run `work` with what is stored now.
   * A process that lost a refresh race finds the winner's tokens in `stored`.
   */
  readonly exclusive: <A, E, R>(
    work: (locked: LockedTokens) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | AuthError, R | StorageEnv>
}

const withProfile = (file: TokenFile, profile: string, tokens: TokenSet | undefined): TokenFile => {
  const profiles = { ...file.profiles }
  if (tokens === undefined) delete profiles[profile]
  else profiles[profile] = tokens
  return { profiles }
}

export const makeTokenStore = (locations: Locations, profile: string): TokenStore => {
  const lock = withTokenLock(locations)
  const exclusive: TokenStore["exclusive"] = (work) =>
    lock(Effect.gen(function*() {
      const file = yield* loadTokens(locations)
      return yield* work({
        stored: file.profiles[profile],
        commit: (tokens) => saveTokens(locations, withProfile(file, profile, tokens))
      })
    }))
  return {
    read: Effect.map(loadTokens(locations), (file) => file.profiles[profile]),
    write: (tokens) => exclusive(({ commit }) => commit(tokens)),
    exclusive
  }
}

export const tokenIsFresh = (tokens: TokenSet, now: number, skewMs = 60_000) =>
  tokens.accessToken !== "" && tokens.expiresAt - skewMs > now
