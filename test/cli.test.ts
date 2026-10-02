import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const runCli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["src/main.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  })

test("endpoints lists product and oauth-backed resources as JSON", () => {
  const result = runCli(["endpoints", "--json"])
  assert.equal(result.status, 0, result.stderr)
  const body = JSON.parse(result.stdout) as { errors: string; commands: Array<{ command: string; method: string; path: string }> }
  assert.equal(body.errors, "stderr")
  assert.ok(body.commands.some((entry) => entry.command === "upim products list" && entry.method === "GET"))
  assert.ok(body.commands.some((entry) => entry.path === "/api/v1/rest/passports/publish/{sku}"))
})

test("help exits 0", () => {
  const result = runCli(["--help"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /upim endpoints --json/)
  assert.match(result.stdout, /site root/)
})

test("config init writes a private XDG-style file", () => {
  const directory = mkdtempSync(join(tmpdir(), "upim-"))
  const config = join(directory, "config.json")
  const result = runCli([
    "--config",
    config,
    "config",
    "init",
    "--non-interactive",
    "--base-url",
    "https://pim.example.com",
    "--client-id",
    "id",
    "--client-secret",
    "secret",
    "--username",
    "robot",
    "--password",
    "pw",
    "--save-password"
  ])
  assert.equal(result.status, 0, result.stderr)
  const saved = JSON.parse(readFileSync(config, "utf8")) as {
    current: string
    profiles: { default: { baseUrl: string; password?: string } }
  }
  assert.equal(saved.current, "default")
  assert.equal(saved.profiles.default.baseUrl, "https://pim.example.com")
  assert.equal(saved.profiles.default.password, "pw")
  chmodSync(config, statSync(config).mode)
  assert.equal(statSync(config).mode & 0o777, 0o600)
  const tokens = statSync(join(directory, "tokens.json"), { throwIfNoEntry: false })
  assert.equal(tokens, undefined)
})
