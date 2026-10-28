import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { ProfileEnv, ProfileNameEnv, readEnv } from "./env.ts"
import { ConfigError } from "./errors.ts"
import { isNotFound } from "./filesystem.ts"
import { resolveLocations, type Locations } from "./paths.ts"

export const ProfileSchema = Schema.Struct({
  baseUrl: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.String,
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
  /** Extension catalogs this host has installed. Definitions are shared; enablement is per profile. */
  extensions: Schema.optional(Schema.Array(Schema.String))
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
      Effect.asSome,
      Effect.catch((error) => isNotFound(error)
        ? Effect.succeedNone
        : Effect.fail(new ConfigError({ message: `Could not read ${locations.configPath}: ${error.message}` })))
    )
    if (Option.isNone(text)) return emptyConfig()
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text.value) as unknown,
      catch: (error) => new ConfigError({ message: `Invalid JSON in ${locations.configPath}: ${String(error)}` })
    })
    return yield* Schema.decodeUnknownEffect(ConfigSchema)(parsed).pipe(
      Effect.mapError((error) => new ConfigError({ message: `Invalid config ${locations.configPath}: ${String(error)}` }))
    )
  })

const writePrivate = (target: string, contents: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(target, contents, { mode: 0o600 })
    yield* fs.chmod(target, 0o600)
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

/** The selected profile name: the flag, then UPIM_PROFILE, then the config's current profile, then "default". */
export const profileName = (config: ConfigFile, requested: string | undefined) =>
  Effect.map(readEnv(ProfileNameEnv), (fromEnv) =>
    requested || Option.getOrUndefined(fromEnv) || config.current || "default")

export const activeProfile = Effect.fn("config.activeProfile")(function*(config: ConfigFile, requested: string | undefined) {
  const name = yield* profileName(config, requested)
  const profile = config.profiles[name]
  if (profile === undefined) {
    return yield* new ConfigError({
      message: `Profile "${name}" is not configured. Run \`upim config init\` or create the XDG config file.`
    })
  }
  return yield* applyEnv(profile)
})

/** Parse `UPIM_EXTENSIONS=dam,acme-sync` into unique, trimmed names. */
export const parseExtensionList = (value: string): readonly string[] =>
  [...new Set(value.split(",").map((name) => name.trim()).filter((name) => name !== ""))]

/** The profile with the UPIM_* environment overrides applied. Nothing here is written back. */
export const applyEnv = (profile: Profile) =>
  Effect.map(readEnv(ProfileEnv), (env): Profile => ({
    baseUrl: Option.getOrElse(env.baseUrl, () => profile.baseUrl),
    clientId: Option.getOrElse(env.clientId, () => profile.clientId),
    clientSecret: Option.getOrElse(env.clientSecret, () => profile.clientSecret),
    username: Option.getOrElse(env.username, () => profile.username),
    password: Option.getOrElse(env.password, () => profile.password),
    extensions: Option.getOrElse(Option.map(env.extensions, parseExtensionList), () => profile.extensions)
  }))

/** Names of the extensions the active profile enables, after the environment override. */
export const enabledExtensions = (profile: Profile): readonly string[] => profile.extensions ?? []

export const locationsFrom = (configFlag: string | undefined) => resolveLocations(configFlag)

export const maskProfile = (profile: Profile): Profile => ({
  ...profile,
  clientSecret: profile.clientSecret ? "********" : "",
  password: profile.password ? "********" : undefined
})
