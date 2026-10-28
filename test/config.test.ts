import assert from "node:assert/strict"
import test from "node:test"
import { ConfigProvider, Effect, Path } from "effect"
import { activeProfile, applyEnv, profileName, type ConfigFile, type Profile } from "../src/config.ts"
import { ConfigError } from "../src/errors.ts"
import { resolveLocations } from "../src/paths.ts"

const profile: Profile = {
  baseUrl: "https://pim.example.com",
  clientId: "id",
  clientSecret: "secret",
  username: "robot",
  password: "stored",
  extensions: ["dam"]
}

const config: ConfigFile = { current: "staging", profiles: { staging: profile } }

/** Runs with the given variables as the whole environment, so the real process.env never leaks in. */
const withEnv = <A, E>(variables: Record<string, string>, effect: Effect.Effect<A, E, Path.Path>) =>
  Effect.runPromise(effect.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(variables))),
    Effect.provide(Path.layer)
  ))

test("environment overrides apply per run and blank variables mean unset", async () => {
  assert.deepEqual(await withEnv({}, applyEnv(profile)), profile)

  const overridden = await withEnv({
    UPIM_BASE_URL: " https://override.example.com ",
    UPIM_CLIENT_ID: "",
    UPIM_USERNAME: "  ",
    UPIM_PASSWORD: "",
    UPIM_EXTENSIONS: "acme-sync, dam,,acme-sync"
  }, applyEnv(profile))
  assert.deepEqual(overridden, {
    ...profile,
    baseUrl: "https://override.example.com",
    extensions: ["acme-sync", "dam"]
  })
})

test("the profile name comes from the flag, then UPIM_PROFILE, then the config", async () => {
  assert.equal(await withEnv({}, profileName(config, undefined)), "staging")
  assert.equal(await withEnv({ UPIM_PROFILE: "prod" }, profileName(config, undefined)), "prod")
  assert.equal(await withEnv({ UPIM_PROFILE: "prod" }, profileName(config, "flag")), "flag")
  assert.equal(await withEnv({ UPIM_PROFILE: " " }, profileName({ profiles: {} }, undefined)), "default")

  assert.deepEqual(await withEnv({ UPIM_BASE_URL: "https://x.example" }, activeProfile(config, undefined)), {
    ...profile,
    baseUrl: "https://x.example"
  })
  await assert.rejects(
    () => withEnv({ UPIM_PROFILE: "missing" }, activeProfile(config, undefined)),
    (error: unknown) => error instanceof ConfigError && /"missing" is not configured/.test(error.message)
  )
})

test("file locations follow the flag, UPIM_* variables, then XDG homes", async () => {
  const flagged = await withEnv({ UPIM_CONFIG_HOME: "/ignored" }, resolveLocations("/etc/upim/config.json"))
  assert.deepEqual(flagged, { configPath: "/etc/upim/config.json", tokenPath: "/etc/upim/tokens.json" })

  const pinned = await withEnv({ UPIM_CONFIG_FILE: "/pin/config.json", UPIM_TOKEN_FILE: "/elsewhere/tokens.json" }, resolveLocations(undefined))
  assert.deepEqual(pinned, { configPath: "/pin/config.json", tokenPath: "/elsewhere/tokens.json" })

  const homes = await withEnv({ UPIM_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/xdg-state", XDG_CONFIG_HOME: "/xdg-cfg" }, resolveLocations(""))
  assert.deepEqual(homes, { configPath: "/cfg/upim/config.json", tokenPath: "/xdg-state/upim/tokens.json" })

  const fallback = await withEnv({}, resolveLocations(undefined))
  assert.match(fallback.configPath, /\/\.config\/upim\/config\.json$/)
  assert.match(fallback.tokenPath, /\/\.local\/state\/upim\/tokens\.json$/)
})
