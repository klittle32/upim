import { Schema } from "effect"

export class ConfigError extends Schema.TaggedError<ConfigError, { readonly brand: unique symbol }>()("ConfigError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

export class AuthError extends Schema.TaggedError<AuthError, { readonly brand: unique symbol }>()("AuthError", {
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Unknown)
}) {}

export class ApiError extends Schema.TaggedError<ApiError, { readonly brand: unique symbol }>()("ApiError", {
  message: Schema.String,
  status: Schema.Finite,
  method: Schema.String,
  url: Schema.String,
  body: Schema.Unknown,
  /** JSON pointer to the first field UnoPim rejected, when the body says. */
  path: Schema.optional(Schema.String)
}) {}

export class UsageError extends Schema.TaggedError<UsageError, { readonly brand: unique symbol }>()("UsageError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown)
}) {}

export class TransportError extends Schema.TaggedError<TransportError, { readonly brand: unique symbol }>()("TransportError", {
  message: Schema.String
}) {}

/** Every error upim reports as JSON on stderr. */
export const AppError = Schema.Union([ConfigError, AuthError, ApiError, UsageError, TransportError])

export type AppError = typeof AppError.Type

export const isAppError = Schema.is(AppError)
