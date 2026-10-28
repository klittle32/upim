import { homedir } from "node:os"
import { Effect, Option, Path } from "effect"
import { LocationEnv, readEnv } from "./env.ts"

export type Locations = {
  readonly configPath: string
  readonly tokenPath: string
}

const given = (value: string | undefined) =>
  value !== undefined && value.trim() !== "" ? Option.some(value) : Option.none<string>()

/** XDG config directory, unless a config file or config home is pinned by a flag or the environment. */
export const resolveLocations = Effect.fn("paths.resolveLocations")(function*(configFlag?: string) {
  const path = yield* Path.Path
  const env = yield* readEnv(LocationEnv)
  const explicit = Option.orElse(given(configFlag), () => env.configFile)
  if (Option.isSome(explicit)) {
    return {
      configPath: explicit.value,
      tokenPath: Option.getOrElse(env.tokenFile, () => path.join(path.dirname(explicit.value), "tokens.json"))
    } satisfies Locations
  }
  const home = homedir()
  const configHome = Option.getOrElse(Option.orElse(env.configHome, () => env.xdgConfigHome), () => path.join(home, ".config"))
  const stateHome = Option.getOrElse(Option.orElse(env.stateHome, () => env.xdgStateHome), () => path.join(home, ".local", "state"))
  return {
    configPath: path.join(configHome, "upim", "config.json"),
    tokenPath: Option.getOrElse(env.tokenFile, () => path.join(stateHome, "upim", "tokens.json"))
  } satisfies Locations
})
