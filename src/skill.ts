import { homedir } from "node:os"
import { Effect, FileSystem, Path } from "effect"
import { UsageError } from "./errors.ts"

type Services = FileSystem.FileSystem | Path.Path

/** The directory this package was installed into: the parent of dist/ or src/. */
const packageRoot = Effect.gen(function*() {
  const path = yield* Path.Path
  return yield* path.fromFileUrl(new URL("..", import.meta.url)).pipe(Effect.orDie)
})

export const skillSource = Effect.gen(function*() {
  const path = yield* Path.Path
  return path.join(yield* packageRoot, "skills", "upim")
})

const exists = (fs: FileSystem.FileSystem, target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false))

/** The nearest git root above `start`, else the nearest package.json directory, else `start` itself. */
export const projectRoot = Effect.fn("skill.projectRoot")(function*(start: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  let current = path.resolve(start)
  let packageDir: string | undefined
  while (true) {
    if (yield* exists(fs, path.join(current, ".git"))) return current
    if (packageDir === undefined && (yield* exists(fs, path.join(current, "package.json")))) packageDir = current
    const parent = path.dirname(current)
    if (parent === current) return packageDir ?? path.resolve(start)
    current = parent
  }
})

const expandHome = (value: string, path: Path.Path) => {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2))
  return value
}

export type InstallOptions = {
  readonly user?: boolean
  readonly path?: string
  readonly dir?: string
  readonly cwd?: string
}

export const skillDestination = Effect.fn("skill.skillDestination")(function*(options: InstallOptions) {
  const path = yield* Path.Path
  if (options.path !== undefined && options.user) {
    return yield* new UsageError({ message: "Pass either --path or --user, not both." })
  }
  const start = options.dir ?? options.cwd ?? process.cwd()
  if (options.path !== undefined && options.path.trim() !== "") {
    const expanded = expandHome(options.path.trim(), path)
    return path.isAbsolute(expanded) ? expanded : path.resolve(path.resolve(start), expanded)
  }
  if (options.user) return path.join(homedir(), ".agents", "skills", "upim")
  return path.join(yield* projectRoot(start), ".agents", "skills", "upim")
})

export const installSkill = Effect.fn("skill.installSkill")(
  function*(options: InstallOptions): Effect.fn.Return<{ installed: string; source: string; agents: string }, UsageError, Services> {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const source = yield* skillSource
    if (!(yield* exists(fs, path.join(source, "SKILL.md")))) {
      return yield* new UsageError({ message: `Bundled skill is missing at ${source}` })
    }
    const destination = yield* skillDestination(options)
    if (path.resolve(source) === path.resolve(destination)) {
      return yield* new UsageError({ message: "The skill is already loaded from this checkout. Pass --path or --dir to install it somewhere else." })
    }
    const copied = yield* Effect.gen(function*() {
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true })
      yield* fs.copy(source, destination, { overwrite: true })
      return yield* fs.readFileString(path.join(destination, "SKILL.md"))
    }).pipe(Effect.mapError((error) => new UsageError({ message: `Could not install the upim skill: ${error.message}`, cause: error })))
    if (!copied.startsWith("---\nname: upim\n")) {
      return yield* new UsageError({ message: `Installed skill at ${destination} is not the upim skill` })
    }
    return { installed: destination, source, agents: path.dirname(destination) }
  }
)
