import { Effect, FileSystem, Path, Schema } from "effect"
import { flatten, type ExtensionTag, type FlatAction, type Resource } from "./catalog.ts"
import { ConfigError } from "./errors.ts"
import { dam } from "./extensions/dam.ts"
import { isNotFound } from "./filesystem.ts"
import type { Locations } from "./paths.ts"
import { projectRoot } from "./skill.ts"

const QuerySpecSchema = Schema.Struct({
  kind: Schema.Literals(["string", "boolean"]),
  name: Schema.String,
  param: Schema.String,
  description: Schema.String,
  required: Schema.optional(Schema.Boolean)
})

const ActionSchema = Schema.Struct({
  name: Schema.String,
  summary: Schema.String,
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: Schema.String.pipe(Schema.check(Schema.isPattern(/^\//, { description: "a path starting with /" }))),
  args: Schema.optional(Schema.Array(Schema.String)),
  body: Schema.optional(Schema.Literals(["required", "optional"])),
  list: Schema.optional(Schema.Boolean),
  upload: Schema.optional(Schema.Boolean),
  fileField: Schema.optional(Schema.String),
  query: Schema.optional(Schema.Array(QuerySpecSchema))
})

const ResourceSchema = Schema.Struct({
  name: Schema.String,
  summary: Schema.String,
  actions: Schema.optional(Schema.Array(ActionSchema)),
  children: Schema.optional(Schema.Array(Schema.suspend((): Schema.Codec<Resource> => ResourceSchema)))
})

/**
 * An extension is a catalog fragment: the same Resource[] shape the core CLI
 * builds commands from, plus a name a profile can enable and an optional
 * probe request that tells whether a host has the package installed.
 */
export const ExtensionSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/, {
    description: "lowercase letters, digits, and dashes, starting with a letter"
  }))),
  summary: Schema.String,
  docs: Schema.optional(Schema.String),
  probe: Schema.optional(Schema.Struct({
    method: Schema.Literal("GET"),
    path: Schema.String
  })),
  resources: Schema.Array(ResourceSchema)
})

export type Extension = typeof ExtensionSchema.Type

export type InstalledExtension = {
  readonly extension: Extension
  /** "builtin", or the JSON file the fragment was read from. */
  readonly source: string
}

export const builtinExtensions: readonly Extension[] = [dam]

const decodeExtensionText = Schema.decodeUnknownEffect(Schema.fromJsonString(ExtensionSchema))

/** Where custom fragments are read from: the project (its root and the current directory) and the user config dir. */
export const extensionDirectories = (cwd: string, locations: Locations, path: Path.Path): readonly string[] => {
  const root = projectRoot(cwd)
  const candidates = [
    path.join(root, ".upim", "extensions"),
    path.join(path.resolve(cwd), ".upim", "extensions"),
    path.join(path.dirname(locations.configPath), "extensions")
  ]
  return [...new Set(candidates)]
}

const readFragments = Effect.fnUntraced(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.catch((error) => isNotFound(error)
      ? Effect.succeed([] as string[])
      : Effect.fail(new ConfigError({ message: `Could not read extensions in ${directory}: ${error.message}`, cause: error })))
  )
  const files = entries.filter((entry) => entry.endsWith(".json")).sort()
  return yield* Effect.forEach(files, (file) => {
    const source = path.join(directory, file)
    return fs.readFileString(source).pipe(
      Effect.mapError((error) => new ConfigError({ message: `Could not read extension ${source}: ${error.message}`, cause: error })),
      Effect.flatMap((text) => decodeExtensionText(text).pipe(
        Effect.mapError((error) => new ConfigError({ message: `Invalid extension ${source}: ${error.message}`, cause: error }))
      )),
      Effect.map((extension): InstalledExtension => ({ extension, source }))
    )
  })
})

/**
 * Built-in fragments plus every `*.json` fragment in the extension
 * directories. Names must be unique, and a custom fragment may not reuse a
 * built-in name.
 */
export const loadExtensions = Effect.fn("extensions.loadExtensions")(function*(cwd: string, locations: Locations) {
  const path = yield* Path.Path
  const installed: InstalledExtension[] = builtinExtensions.map((extension) => ({ extension, source: "builtin" }))
  for (const directory of extensionDirectories(cwd, locations, path)) {
    for (const found of yield* readFragments(directory)) {
      const clash = installed.find((entry) => entry.extension.name === found.extension.name)
      if (clash) {
        return yield* new ConfigError({
          message: clash.source === "builtin"
            ? `Extension ${found.source} is named "${found.extension.name}", which is a built-in extension. Rename it.`
            : `Extension "${found.extension.name}" is defined twice: ${clash.source} and ${found.source}. Remove one.`
        })
      }
      installed.push(found)
    }
  }
  return installed as readonly InstalledExtension[]
})

export const tagFor = (extension: Extension): ExtensionTag => ({
  name: extension.name,
  summary: extension.summary,
  ...(extension.docs !== undefined ? { docs: extension.docs } : {})
})

/** Every action of an extension as `upim ext <name> <resource> <action>`. */
export const flattenExtension = (extension: Extension): readonly FlatAction[] =>
  flatten(extension.resources, ["ext", extension.name], tagFor(extension))

/** The `ext` command tree for the describe index and group lookups. */
export const extensionTree = (extensions: readonly Extension[]): Resource => ({
  name: "ext",
  summary: "Extension catalogs enabled for the selected profile",
  children: extensions.map((extension) => ({
    name: extension.name,
    summary: extension.summary,
    children: extension.resources
  }))
})

/** The installed extensions the profile enables, in the profile's order. Unknown names are reported. */
export const selectEnabled = (
  installed: readonly InstalledExtension[],
  enabled: readonly string[]
): { readonly extensions: readonly Extension[]; readonly unknown: readonly string[] } => {
  const byName = new Map(installed.map((entry) => [entry.extension.name, entry.extension]))
  const extensions: Extension[] = []
  const unknown: string[] = []
  for (const name of enabled) {
    const extension = byName.get(name)
    if (extension) extensions.push(extension)
    else unknown.push(name)
  }
  return { extensions, unknown }
}

export const enableHint = (name: string) =>
  `Run \`upim extensions enable ${name}\`, or set UPIM_EXTENSIONS=${name} for one run.`
