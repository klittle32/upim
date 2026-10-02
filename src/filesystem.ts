import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { Effect, FileSystem, Layer, PlatformError } from "effect"

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined

const tagFor = (code: string | undefined): PlatformError.SystemErrorTag => {
  if (code === "ENOENT") return "NotFound"
  if (code === "EACCES" || code === "EPERM") return "PermissionDenied"
  return "Unknown"
}

const fromNode = (method: string, path: string, error: unknown) => {
  const code = codeOf(error)
  return PlatformError.systemError({
    _tag: tagFor(code),
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: code,
    cause: error
  })
}

export const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound"

const nodeFileSystem = FileSystem.makeNoop({
  readFileString: (path) => Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (error) => fromNode("readFileString", path, error)
  }),
  makeDirectory: (path, options) => Effect.tryPromise({
    try: async () => {
      await mkdir(path, { recursive: options?.recursive, mode: options?.mode })
    },
    catch: (error) => fromNode("makeDirectory", path, error)
  }),
  writeFileString: (path, data, options) => Effect.tryPromise({
    try: async () => {
      await writeFile(path, data, { mode: options?.mode })
    },
    catch: (error) => fromNode("writeFileString", path, error)
  }),
  chmod: (path, mode) => Effect.tryPromise({
    try: async () => {
      await chmod(path, mode)
    },
    catch: (error) => fromNode("chmod", path, error)
  })
})

export const layer = Layer.succeed(FileSystem.FileSystem, nodeFileSystem)
