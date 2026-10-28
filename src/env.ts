import { Config, Effect, Option } from "effect"
import { ConfigError } from "./errors.ts"

/**
 * An environment variable where unset and blank both mean "not given". The
 * value is trimmed. Effect's config providers already drop empty values, so
 * an empty string can never act as an override.
 */
const text = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.flatMap((value) => {
      const trimmed = value.trim()
      return trimmed === "" ? Option.none() : Option.some(trimmed)
    }))
  )

/** Per-run overrides for the selected profile. None of these are written back to the config file. */
export const ProfileEnv = Effect.all({
  baseUrl: text("UPIM_BASE_URL"),
  clientId: text("UPIM_CLIENT_ID"),
  clientSecret: text("UPIM_CLIENT_SECRET"),
  username: text("UPIM_USERNAME"),
  password: text("UPIM_PASSWORD"),
  extensions: text("UPIM_EXTENSIONS")
})

export const ProfileNameEnv = text("UPIM_PROFILE")

/** Where the config and token files live. */
export const LocationEnv = Effect.all({
  configFile: text("UPIM_CONFIG_FILE"),
  tokenFile: text("UPIM_TOKEN_FILE"),
  configHome: text("UPIM_CONFIG_HOME"),
  xdgConfigHome: text("XDG_CONFIG_HOME"),
  stateHome: text("UPIM_STATE_HOME"),
  xdgStateHome: text("XDG_STATE_HOME")
})

/** Read configuration through the ConfigProvider, turning a provider failure into upim's ConfigError. */
export const readEnv = <A>(config: Effect.Effect<A, Config.ConfigError>) =>
  Effect.mapError(config, (error) => new ConfigError({ message: `Could not read the environment: ${String(error)}`, cause: error }))
