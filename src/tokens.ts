import { Clock, Crypto, Data, Effect, FileSystem, Option, Path, Schedule, Schema, Semaphore } from "effect"
import { AuthError } from "./errors.ts"
import { isAlreadyExists, isNotFound } from "./filesystem.ts"
import { warn } from "./output.ts"
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

type Services = FileSystem.FileSystem | Path.Path | Crypto.Crypto

/**
 * The longest prefix of `text` that parses as JSON, or undefined.
 * The token file is an object, so only prefixes ending in `}` are tried.
 * A torn file from two concurrent writers is one complete document with
 * a few bytes of the other document's tail after it.
 */
export const longestValidPrefix = (text: string): unknown => {
  for (let end = text.length; end > 0; end--) {
    if (text[end - 1] !== "}") continue
    try {
      return JSON.parse(text.slice(0, end)) as unknown
    } catch {
      continue
    }
  }
  return undefined
}

const decodeTokenFile = Schema.decodeUnknownEffect(TokenFileSchema)

/**
 * Parse the token file leniently. Unreadable content is treated as empty so
 * that the next call falls back to the password grant and rewrites the file,
 * instead of every call failing until someone repairs it by hand.
 */
const parseTokenFile = (path: string, text: string): Effect.Effect<TokenFile> =>
  Effect.gen(function*() {
    const whole = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(Effect.option)
    if (Option.isSome(whole)) {
      const decoded = yield* decodeTokenFile(whole.value).pipe(Effect.option)
      if (Option.isSome(decoded)) return decoded.value
    }
    const prefix = longestValidPrefix(text)
    const recovered = prefix === undefined
      ? Option.none()
      : yield* decodeTokenFile(prefix).pipe(Effect.option)
    if (Option.isSome(recovered)) {
      yield* warn(`Recovered ${path} from a torn write by dropping ${text.length - JSON.stringify(prefix).length} trailing byte(s)`)
      return recovered.value
    }
    yield* warn(`Ignoring unreadable token file ${path}. Tokens will be requested again.`)
    return empty()
  })

export const loadTokens = (locations: Locations): Effect.Effect<TokenFile, AuthError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(locations.tokenPath).pipe(
      Effect.catch((error) => isNotFound(error)
        ? Effect.succeed(undefined)
        : Effect.fail(new AuthError({ message: `Could not read ${locations.tokenPath}: ${error.message}` })))
    )
    if (text === undefined) return empty()
    return yield* parseTokenFile(locations.tokenPath, text)
  })

/**
 * Write the whole token file atomically: a private temp file in the same
 * directory, then rename over the target. Readers see the old document or
 * the new one, never a mix of two writers.
 */
export const saveTokens = (locations: Locations, file: TokenFile): Effect.Effect<void, AuthError, Services> =>
  Effect.gen(function*() {
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
  }).pipe(
    Effect.mapError((error) => new AuthError({ message: `Could not write ${locations.tokenPath}: ${error.message}` }))
  )

export type LockOptions = {
  /** A lock older than this is abandoned by a dead process and may be taken over. */
  readonly staleMs?: number
  /** Give up waiting for the lock after this long. */
  readonly waitMs?: number
  /** Base interval between lock attempts. Jitter is added. */
  readonly pollMs?: number
}

const LOCK_DEFAULTS = { staleMs: 30_000, waitMs: 45_000, pollMs: 50 } satisfies Required<LockOptions>

class LockBusy extends Data.TaggedError("LockBusy")<{
  readonly path: string
  readonly holder: string
}> {}

const lockPathFor = (locations: Locations) => `${locations.tokenPath}.lock`

const lockFailure = (path: string) => (error: { readonly message: string }) =>
  new AuthError({ message: `Could not lock ${path}: ${error.message}` })

type Lock = {
  readonly path: string
  /** pid plus a random nonce, written into the file so release can tell its own lock from a successor's. */
  readonly owner: string
}

const LockHolderSchema = Schema.Struct({ owner: Schema.String })

/** One attempt to create the lock file. Fails with LockBusy while another live process holds it. */
const tryLock = (fs: FileSystem.FileSystem, lockPath: string, owner: string, staleMs: number) =>
  Effect.gen(function*() {
    const holder = `${JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() })}\n`
    const created = yield* fs.writeFileString(lockPath, holder, { flag: "wx", mode: 0o600 }).pipe(
      Effect.as(true),
      Effect.catch((error) => isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(lockFailure(lockPath)(error)))
    )
    if (created) return
    const info = yield* fs.stat(lockPath).pipe(Effect.option)
    if (Option.isNone(info)) return yield* new LockBusy({ path: lockPath, holder: "a process that just released it" })
    const now = yield* Clock.currentTimeMillis
    const modified = Option.getOrElse(info.value.mtime, () => new Date(now)).getTime()
    const current = yield* fs.readFileString(lockPath).pipe(Effect.orElseSucceed(() => "unknown"))
    if (now - modified > staleMs) {
      // Rename first so only one waiter wins the takeover, then drop the renamed file.
      const abandoned = `${lockPath}.stale.${process.pid}`
      yield* fs.rename(lockPath, abandoned).pipe(
        Effect.andThen(fs.remove(abandoned)),
        Effect.ignore
      )
    }
    return yield* new LockBusy({ path: lockPath, holder: current.trim() })
  })

const acquireLock = (lockPath: string, options: Required<LockOptions>): Effect.Effect<Lock, AuthError, Services> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const nonce = yield* crypto.randomUUIDv4().pipe(Effect.mapError(lockFailure(lockPath)))
    const owner = `${process.pid}:${nonce}`
    yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true, mode: 0o700 }).pipe(
      Effect.mapError(lockFailure(lockPath))
    )
    yield* tryLock(fs, lockPath, owner, options.staleMs).pipe(
      Effect.retry({
        while: (error) => error._tag === "LockBusy",
        schedule: Schedule.spaced(`${options.pollMs} millis`).pipe(
          Schedule.jittered,
          Schedule.upTo({ duration: `${options.waitMs} millis` })
        )
      }),
      Effect.catchTag("LockBusy", (busy) => new AuthError({
        message: `Timed out after ${options.waitMs} ms waiting for the token lock ${busy.path} held by ${busy.holder}. Remove the file if that process is gone.`
      }))
    )
    return { path: lockPath, owner }
  })

/**
 * Release the lock only while it is still ours. If this process stalled past
 * the stale timeout, a waiter has taken the lock over, and deleting the file
 * now would let a third process in while the waiter is mid-refresh.
 */
const releaseLock = (lock: Lock) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(lock.path).pipe(Effect.option)
    if (Option.isNone(text)) return
    const holder = yield* Effect.try(() => JSON.parse(text.value) as unknown).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LockHolderSchema)),
      Effect.option
    )
    if (Option.isSome(holder) && holder.value.owner !== lock.owner) {
      yield* warn(`Leaving ${lock.path} in place: ${holder.value.owner} took it over after this process held it past the stale timeout`)
      return
    }
    yield* fs.remove(lock.path)
  }).pipe(Effect.ignore)

// One permit per token file keeps fibers in this process from racing each
// other for the file lock, which is not re-entrant.
const permits = new Map<string, Semaphore.Semaphore>()

const permitFor = (lockPath: string) => {
  const existing = permits.get(lockPath)
  if (existing) return existing
  const created = Semaphore.makeUnsafe(1)
  permits.set(lockPath, created)
  return created
}

/**
 * Run `work` while holding the cross-process token lock. The lock is a
 * scoped resource, so it is released on success, failure, and interrupt.
 */
export const withTokenLock = (locations: Locations, options?: LockOptions) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E | AuthError, R | Services> => {
    const lockPath = lockPathFor(locations)
    const settings = { ...LOCK_DEFAULTS, ...options }
    const locked = Effect.acquireRelease(acquireLock(lockPath, settings), releaseLock).pipe(
      Effect.andThen(work),
      Effect.scoped
    )
    return Semaphore.withPermit(permitFor(lockPath))(locked)
  }

/** The token file as seen while holding the lock, plus a way to replace one profile's tokens. */
export type LockedTokens = {
  readonly stored: TokenSet | undefined
  readonly commit: (tokens: TokenSet | undefined) => Effect.Effect<void, AuthError, Services>
}

export type TokenStore = {
  /** The profile's saved tokens, without locking. */
  readonly read: Effect.Effect<TokenSet | undefined, AuthError, FileSystem.FileSystem>
  /** Replace or delete the profile's tokens under the lock. Other profiles are preserved. */
  readonly write: (tokens: TokenSet | undefined) => Effect.Effect<void, AuthError, Services>
  /**
   * Take the lock, re-read the file, and run `work` with what is stored now.
   * A process that lost a refresh race finds the winner's tokens in `stored`.
   */
  readonly exclusive: <A, E, R>(
    work: (locked: LockedTokens) => Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | AuthError, R | Services>
}

const withProfile = (file: TokenFile, profile: string, tokens: TokenSet | undefined): TokenFile => {
  const profiles = { ...file.profiles }
  if (tokens === undefined) delete profiles[profile]
  else profiles[profile] = tokens
  return { profiles }
}

export const makeTokenStore = (locations: Locations, profile: string, options?: LockOptions): TokenStore => {
  const lock = withTokenLock(locations, options)
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

export const tokenIsFresh = (tokens: TokenSet, now = Date.now(), skewMs = 60_000) =>
  tokens.accessToken !== "" && tokens.expiresAt - skewMs > now
