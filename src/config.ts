import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Data, Effect, Schema } from "effect"
import { ConfigError } from "./errors.ts"
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

class FileReadError extends Data.TaggedError("FileReadError")<{
  readonly path: string
  readonly code?: string
  readonly message: string
}> {}

const readJson = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (error) => new FileReadError({
      path,
      code: typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined,
      message: `Could not read ${path}: ${String(error)}`
    })
  })

export const loadConfig = (locations: Locations) =>
  Effect.gen(function*() {
    const text = yield* readJson(locations.configPath).pipe(
      Effect.catch((error) => error.code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(new ConfigError({ message: error.message })))
    )
    if (text === undefined) return emptyConfig()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return yield* new ConfigError({ message: `Invalid JSON in ${locations.configPath}: ${String(error)}` })
    }
    return yield* Schema.decodeUnknownEffect(ConfigSchema)(parsed).pipe(
      Effect.mapError((error) => new ConfigError({ message: `Invalid config ${locations.configPath}: ${String(error)}` }))
    )
  })

export const saveConfig = (locations: Locations, config: ConfigFile) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(locations.configPath), { recursive: true, mode: 0o700 })
      await writeFile(locations.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
      await chmod(locations.configPath, 0o600)
    },
    catch: (error) => new ConfigError({ message: `Could not write ${locations.configPath}: ${String(error)}` })
  })

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
