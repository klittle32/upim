import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Locations = {
  readonly configPath: string
  readonly tokenPath: string
}

const home = () => homedir()

/** XDG config directory, unless a config file or config home is pinned. */
export const resolveLocations = (configFlag?: string): Locations => {
  const explicit = configFlag || process.env.UPIM_CONFIG_FILE
  if (explicit) {
    const directory = dirname(explicit)
    return {
      configPath: explicit,
      tokenPath: process.env.UPIM_TOKEN_FILE ?? join(directory, "tokens.json")
    }
  }
  const configHome = process.env.UPIM_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME ?? join(home(), ".config")
  const stateHome = process.env.UPIM_STATE_HOME ?? process.env.XDG_STATE_HOME ?? join(home(), ".local", "state")
  return {
    configPath: join(configHome, "upim", "config.json"),
    tokenPath: process.env.UPIM_TOKEN_FILE ?? join(stateHome, "upim", "tokens.json")
  }
}
