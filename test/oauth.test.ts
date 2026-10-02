import assert from "node:assert/strict"
import test from "node:test"
import { basicAuthorization, expiresAtFrom, passwordGrantBody, refreshGrantBody } from "../src/oauth.ts"

test("password and refresh grants match the UnoPim OAuth bodies", () => {
  assert.deepEqual(passwordGrantBody("robot", "secret"), {
    username: "robot",
    password: "secret",
    grant_type: "password"
  })
  assert.deepEqual(refreshGrantBody("refresh"), {
    refresh_token: "refresh",
    grant_type: "refresh_token"
  })
})

test("basic authorization is clientId:clientSecret", () => {
  const header = basicAuthorization("id", "secret")
  const decoded = Buffer.from(header.replace("Basic ", ""), "base64").toString("utf8")
  assert.equal(decoded, "id:secret")
})

test("expiry uses expires_in and defaults to one hour", () => {
  assert.equal(expiresAtFrom(10, 1_000), 11_000)
  assert.equal(expiresAtFrom(undefined, 0), 3_600_000)
})
