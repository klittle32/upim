import { cp, mkdir } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { UsageError } from "./errors.ts"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

export const skillSource = () => join(packageRoot, "skills", "upim")

const projectRoot = (start: string) => {
  let current = resolve(start)
  let packageDir: string | undefined
  while (true) {
    if (existsSync(join(current, ".git"))) return current
    if (packageDir === undefined && existsSync(join(current, "package.json"))) packageDir = current
    const parent = dirname(current)
    if (parent === current) return packageDir ?? resolve(start)
    current = parent
  }
}

const expandHome = (value: string) => {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

export const skillDestination = (options: { readonly user?: boolean; readonly path?: string; readonly dir?: string; readonly cwd?: string }) => {
  if (options.path !== undefined && options.user) {
    throw new UsageError({ message: "Pass either --path or --user, not both." })
  }
  if (options.path !== undefined && options.path.trim() !== "") {
    const base = resolve(options.dir ?? options.cwd ?? process.cwd())
    const expanded = expandHome(options.path.trim())
    return isAbsolute(expanded) ? expanded : resolve(base, expanded)
  }
  return options.user
    ? join(homedir(), ".agents", "skills", "upim")
    : join(projectRoot(options.dir ?? options.cwd ?? process.cwd()), ".agents", "skills", "upim")
}

export const installSkill = (options: { readonly user?: boolean; readonly path?: string; readonly dir?: string; readonly cwd?: string }) =>
  Effect.tryPromise({
    try: async () => {
      const source = skillSource()
      if (!existsSync(join(source, "SKILL.md"))) {
        throw new UsageError({ message: `Bundled skill is missing at ${source}` })
      }
      const destination = skillDestination(options)
      if (resolve(source) === resolve(destination)) {
        throw new UsageError({ message: "The skill is already loaded from this checkout. Pass --path or --dir to install it somewhere else." })
      }
      await mkdir(dirname(destination), { recursive: true })
      await cp(source, destination, { recursive: true, force: true })
      const installed = readFileSync(join(destination, "SKILL.md"), "utf8")
      if (!installed.startsWith("---\nname: upim\n")) {
        throw new UsageError({ message: `Installed skill at ${destination} is not the upim skill` })
      }
      return { installed: destination, source, agents: dirname(destination) }
    },
    catch: (error) => error instanceof UsageError ? error : new UsageError({ message: `Could not install the upim skill: ${String(error)}` })
  })
