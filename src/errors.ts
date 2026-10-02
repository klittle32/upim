import { Data } from "effect"

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string
  readonly details?: unknown
}> {}

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly message: string
  readonly status: number
  readonly method: string
  readonly url: string
  readonly body: unknown
  readonly path?: string
}> {}

export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string
  readonly path?: string
}> {}

export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string
}> {}

export type AppError = ConfigError | AuthError | ApiError | UsageError | TransportError

export const isAppError = (value: unknown): value is AppError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  (value._tag === "ConfigError" ||
    value._tag === "AuthError" ||
    value._tag === "ApiError" ||
    value._tag === "UsageError" ||
    value._tag === "TransportError")
