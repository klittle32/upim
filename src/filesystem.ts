import { NodeFileSystem } from "@effect/platform-node"
import type { PlatformError } from "effect"

export const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound"

export const isAlreadyExists = (error: PlatformError.PlatformError) => error.reason._tag === "AlreadyExists"

export const layer = NodeFileSystem.layer
