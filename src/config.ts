import { dirname } from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import { ConfigError } from "./errors.ts"
import { isNotFound } from "./filesystem.ts"
import { resolveLocations, type Locations } from "./paths.ts"

export const ProfileSchema = Schema.Struct({
  baseUrl: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.String,
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String)
})

export type Profile = typeof ProfileSchema.Type

export const ConfigSchema = Schema.Struct({
  current: Schema.optional(Schema.String),
  profiles: Schema.Record(Schema.String, ProfileSchema)
})

export type ConfigFile = typeof ConfigSchema.Type

export const emptyConfig = (): ConfigFile => ({ current: "default", profiles: {} })

const readText = (path: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(path)
  })

export const loadConfig = (locations: Locations) =>
  Effect.gen(function*() {
    const text = yield* readText(locations.configPath).pipe(
      Effect.catch((error) => isNotFound(error)
        ? Effect.succeed(undefined)
        : Effect.fail(new ConfigError({ message: `Could not read ${locations.configPath}: ${error.message}` })))
    )
    if (text === undefined) return emptyConfig()
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (error) => new ConfigError({ message: `Invalid JSON in ${locations.configPath}: ${String(error)}` })
    })
    return yield* Schema.decodeUnknownEffect(ConfigSchema)(parsed).pipe(
      Effect.mapError((error) => new ConfigError({ message: `Invalid config ${locations.configPath}: ${String(error)}` }))
    )
  })

const writePrivate = (path: string, contents: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(path, contents, { mode: 0o600 })
    yield* fs.chmod(path, 0o600)
  })

export const saveConfig = (locations: Locations, config: ConfigFile) =>
  writePrivate(locations.configPath, `${JSON.stringify(config, null, 2)}\n`).pipe(
    Effect.mapError((error) => new ConfigError({ message: `Could not write ${locations.configPath}: ${error.message}` }))
  )

export const normalizeBaseUrl = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, "")
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error("baseUrl must be an absolute http or https URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https")
  }
  return trimmed
}

export const profileName = (config: ConfigFile, requested: string | undefined): string =>
  requested || process.env.UPIM_PROFILE || config.current || "default"

export const activeProfile = (config: ConfigFile, requested: string | undefined): Profile => {
  const name = profileName(config, requested)
  const profile = config.profiles[name]
  if (profile === undefined) {
    throw new ConfigError({
      message: `Profile "${name}" is not configured. Run \`upim config init\` or create the XDG config file.`
    })
  }
  return applyEnv(profile)
}

export const applyEnv = (profile: Profile): Profile => ({
  baseUrl: process.env.UPIM_BASE_URL?.trim() || profile.baseUrl,
  clientId: process.env.UPIM_CLIENT_ID?.trim() || profile.clientId,
  clientSecret: process.env.UPIM_CLIENT_SECRET?.trim() || profile.clientSecret,
  username: process.env.UPIM_USERNAME?.trim() || profile.username,
  password: process.env.UPIM_PASSWORD ?? profile.password
})

export const locationsFrom = (configFlag: string | undefined) => resolveLocations(configFlag)

export const maskProfile = (profile: Profile): Profile => ({
  ...profile,
  clientSecret: profile.clientSecret ? "********" : "",
  password: profile.password ? "********" : undefined
})
