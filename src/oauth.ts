import { Schema } from "effect"
import { Base64 } from "effect/encoding"

export const basicAuthorization = (clientId: string, clientSecret: string) =>
  `Basic ${Base64.encode(`${clientId}:${clientSecret}`)}`

export const passwordGrantBody = (username: string, password: string) => ({
  username,
  password,
  grant_type: "password" as const
})

export const refreshGrantBody = (refreshToken: string) => ({
  refresh_token: refreshToken,
  grant_type: "refresh_token" as const
})

export const TokenResponseSchema = Schema.Struct({
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Finite),
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String)
})

export type TokenResponse = typeof TokenResponseSchema.Type

export const expiresAtFrom = (expiresIn: number | undefined, now: number) =>
  now + (expiresIn ?? 3600) * 1000
