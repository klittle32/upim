import { dirname } from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import { AuthError } from "./errors.ts"
import { isNotFound } from "./filesystem.ts"
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

type TokenFile = typeof TokenFileSchema.Type

const empty = (): TokenFile => ({ profiles: {} })

export const loadTokens = (locations: Locations) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(locations.tokenPath).pipe(
      Effect.catch((error) => isNotFound(error)
        ? Effect.succeed(undefined)
        : Effect.fail(new AuthError({ message: `Could not read ${locations.tokenPath}: ${error.message}` })))
    )
    if (text === undefined) return empty()
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) => new AuthError({ message: `Invalid token file ${locations.tokenPath}: ${String(error)}` })
    })
    return yield* Schema.decodeUnknownEffect(TokenFileSchema)(parsed).pipe(
      Effect.mapError((error) => new AuthError({ message: `Invalid token file ${locations.tokenPath}: ${String(error)}` }))
    )
  })

export const saveTokens = (locations: Locations, file: TokenFile) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = locations.tokenPath
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    yield* fs.chmod(path, 0o600)
  }).pipe(
    Effect.mapError((error) => new AuthError({ message: `Could not write ${locations.tokenPath}: ${error.message}` }))
  )

export const readProfileTokens = (locations: Locations, profile: string) =>
  Effect.map(loadTokens(locations), (file) => file.profiles[profile])

export const writeProfileTokens = (locations: Locations, profile: string, tokens: TokenSet | undefined) =>
  Effect.gen(function*() {
    const file = yield* loadTokens(locations)
    const profiles = { ...file.profiles }
    if (tokens === undefined) delete profiles[profile]
    else profiles[profile] = tokens
    yield* saveTokens(locations, { profiles })
  })

export const tokenIsFresh = (tokens: TokenSet, now = Date.now(), skewMs = 60_000) =>
  tokens.accessToken !== "" && tokens.expiresAt - skewMs > now
