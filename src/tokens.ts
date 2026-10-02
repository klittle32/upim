import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Data, Effect, Schema } from "effect"
import { AuthError } from "./errors.ts"
import type { Locations } from "./paths.ts"

export const TokenSetSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  tokenType: Schema.String,
  expiresAt: Schema.Number
})

export type TokenSet = typeof TokenSetSchema.Type

const TokenFileSchema = Schema.Struct({
  profiles: Schema.Record(Schema.String, TokenSetSchema)
})

type TokenFile = typeof TokenFileSchema.Type

class TokenReadError extends Data.TaggedError("TokenReadError")<{
  readonly code?: string
  readonly message: string
}> {}

const empty = (): TokenFile => ({ profiles: {} })

export const loadTokens = (locations: Locations) =>
  Effect.gen(function*() {
    const text = yield* Effect.tryPromise({
      try: () => readFile(locations.tokenPath, "utf8"),
      catch: (error) => new TokenReadError({
        code: typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined,
        message: `Could not read ${locations.tokenPath}: ${String(error)}`
      })
    }).pipe(
      Effect.catch((error) => error.code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(new AuthError({ message: error.message })))
    )
    if (text === undefined) return empty()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return yield* new AuthError({ message: `Invalid token file ${locations.tokenPath}: ${String(error)}` })
    }
    return yield* Schema.decodeUnknownEffect(TokenFileSchema)(parsed).pipe(
      Effect.mapError((error) => new AuthError({ message: `Invalid token file ${locations.tokenPath}: ${String(error)}` }))
    )
  })

export const saveTokens = (locations: Locations, file: TokenFile) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(locations.tokenPath), { recursive: true, mode: 0o700 })
      await writeFile(locations.tokenPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      await chmod(locations.tokenPath, 0o600)
    },
    catch: (error) => new AuthError({ message: `Could not write ${locations.tokenPath}: ${String(error)}` })
  })

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
