import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect, Layer, Path, Schema } from "effect"
import { parseExtensionList } from "../src/config.ts"
import { ConfigError } from "../src/errors.ts"
import { dam } from "../src/extensions/dam.ts"
import { ExtensionSchema, flattenExtension, loadExtensions, selectEnabled } from "../src/extensions.ts"
import { layer as nodeFileSystem } from "../src/filesystem.ts"

const acme = {
  name: "acme-sync",
  summary: "Acme product sync",
  resources: [
    {
      name: "jobs",
      summary: "Sync jobs",
      actions: [
        { name: "list", summary: "List sync jobs", method: "GET", path: "/api/v1/rest/acme/jobs", list: true },
        { name: "get", summary: "Get a job", method: "GET", path: "/api/v1/rest/acme/jobs/{id}", args: ["id"] }
      ]
    }
  ]
}

const services = Layer.mergeAll(nodeFileSystem, Path.layer)

const load = (cwd: string, configPath: string) =>
  Effect.runPromise(loadExtensions(cwd, { configPath, tokenPath: join(configPath, "..", "tokens.json") }).pipe(Effect.provide(services)))

/** A fake project: git root with a fragment, a nested working directory, and a separate user config dir. */
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "upim-ext-"))
  const project = join(root, "project")
  const configHome = join(root, "config")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(join(project, ".upim", "extensions"), { recursive: true })
  mkdirSync(join(project, "src", "deep"), { recursive: true })
  mkdirSync(join(configHome, "upim", "extensions"), { recursive: true })
  return { project, cwd: join(project, "src", "deep"), configHome, configPath: join(configHome, "upim", "config.json") }
}

const env = (space: ReturnType<typeof workspace>, extra: NodeJS.ProcessEnv = {}) => ({
  ...process.env,
  UPIM_CONFIG_HOME: space.configHome,
  UPIM_STATE_HOME: join(space.configHome, "state"),
  UPIM_PROFILE: "",
  UPIM_BASE_URL: "",
  UPIM_EXTENSIONS: "",
  ...extra
})

const runCli = (args: string[], cwd: string, environment: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [join(import.meta.dirname, "..", "src", "main.ts"), ...args], { encoding: "utf8", cwd, env: environment })

const json = (text: string) => JSON.parse(text) as any

test("the DAM fragment validates and covers the 3.x routes", () => {
  Schema.decodeUnknownSync(ExtensionSchema)(JSON.parse(JSON.stringify(dam)))
  const paths = new Set(flattenExtension(dam).map((entry) => `${entry.action.method} ${entry.action.path}`))
  for (const route of [
    "GET /api/v1/rest/assets",
    "GET /api/v1/rest/assets/{id}",
    "POST /api/v1/rest/assets",
    "POST /api/v1/rest/assets/reupload",
    "PUT /api/v1/rest/assets/{id}",
    "PUT /api/v1/rest/assets/edit/{id}",
    "GET /api/v1/rest/assets/{id}/metadata",
    "DELETE /api/v1/rest/assets/{id}",
    "GET /api/v1/rest/directories",
    "GET /api/v1/rest/directories/{id}",
    "POST /api/v1/rest/directories",
    "PUT /api/v1/rest/directories/{id}",
    "DELETE /api/v1/rest/directories/{id}",
    "GET /api/v1/rest/comments/{id}",
    "POST /api/v1/rest/comments",
    "PUT /api/v1/rest/comments/{id}",
    "DELETE /api/v1/rest/comments/{id}",
    "GET /api/v1/rest/tags",
    "POST /api/v1/rest/tags/bulk",
    "GET /api/v1/rest/tags/{id}",
    "POST /api/v1/rest/tags",
    "DELETE /api/v1/rest/tags",
    "DELETE /api/v1/rest/tags/{id}",
    "GET /api/v1/rest/properties/{id}",
    "POST /api/v1/rest/properties/{id}",
    "PATCH /api/v1/rest/properties/{id}",
    "DELETE /api/v1/rest/properties/{id}",
    "GET /api/v1/rest/linked-resource/{id}",
    "GET /api/v1/rest/shares",
    "GET /api/v1/rest/shares/{id}",
    "POST /api/v1/rest/shares",
    "PUT /api/v1/rest/shares/{id}",
    "POST /api/v1/rest/shares/{id}/revoke",
    "POST /api/v1/rest/shares/{id}/reauthorize",
    "DELETE /api/v1/rest/shares/{id}"
  ]) assert.ok(paths.has(route), `missing ${route}`)
  // Binary and signed-URL downloads stay off the catalog until --output exists.
  assert.ok(!paths.has("GET /api/v1/rest/assets/download/{id}"))
  assert.equal(dam.probe?.path, "/api/v1/rest/directories")
  for (const entry of flattenExtension(dam)) assert.equal(entry.command[0], "ext")
  const upload = flattenExtension(dam).find((entry) => entry.command.join(" ") === "ext dam assets upload")!
  assert.equal(upload.action.fileField, "files[]")
})

test("custom fragments load from the project root, the working directory, and the user config dir", async () => {
  const space = workspace()
  writeFileSync(join(space.project, ".upim", "extensions", "acme-sync.json"), JSON.stringify(acme))
  mkdirSync(join(space.cwd, ".upim", "extensions"), { recursive: true })
  writeFileSync(join(space.cwd, ".upim", "extensions", "local.json"), JSON.stringify({ ...acme, name: "local-tools", summary: "Local" }))
  writeFileSync(join(space.configHome, "upim", "extensions", "home.json"), JSON.stringify({ ...acme, name: "home-tools", summary: "Home" }))
  writeFileSync(join(space.configHome, "upim", "extensions", "notes.txt"), "ignored")

  const installed = await load(space.cwd, space.configPath)
  assert.deepEqual(installed.map((entry) => entry.extension.name), ["dam", "acme-sync", "local-tools", "home-tools"])
  assert.equal(installed[0]!.source, "builtin")
  assert.equal(installed[1]!.source, join(space.project, ".upim", "extensions", "acme-sync.json"))
  assert.deepEqual(installed[1]!.extension, acme)

  const selected = selectEnabled(installed, ["home-tools", "missing", "dam"])
  assert.deepEqual(selected.extensions.map((extension) => extension.name), ["home-tools", "dam"])
  assert.deepEqual(selected.unknown, ["missing"])
})

test("invalid, duplicate, and built-in-shadowing fragments are config errors that name the file", async () => {
  const space = workspace()
  const broken = join(space.project, ".upim", "extensions", "broken.json")
  writeFileSync(broken, JSON.stringify({ ...acme, resources: [{ name: "x", summary: "x", actions: [{ name: "a", summary: "a", method: "FETCH", path: "/x" }] }] }))
  await assert.rejects(
    () => load(space.cwd, space.configPath),
    (error: unknown) => error instanceof ConfigError && error.message.includes(broken) && /Invalid extension/.test(error.message)
  )
  writeFileSync(broken, "{ not json")
  await assert.rejects(
    () => load(space.cwd, space.configPath),
    (error: unknown) => error instanceof ConfigError && error.message.includes(broken)
  )
  writeFileSync(broken, JSON.stringify({ ...acme, name: "Bad Name" }))
  await assert.rejects(
    () => load(space.cwd, space.configPath),
    (error: unknown) => error instanceof ConfigError && /a-z0-9/.test(error.message)
  )

  writeFileSync(broken, JSON.stringify({ ...acme, name: "dam" }))
  await assert.rejects(
    () => load(space.cwd, space.configPath),
    (error: unknown) => error instanceof ConfigError && /built-in/.test(error.message)
  )

  writeFileSync(broken, JSON.stringify(acme))
  writeFileSync(join(space.configHome, "upim", "extensions", "again.json"), JSON.stringify(acme))
  await assert.rejects(
    () => load(space.cwd, space.configPath),
    (error: unknown) => error instanceof ConfigError && /defined twice/.test(error.message)
  )
})

test("UPIM_EXTENSIONS parses a comma list into unique trimmed names", () => {
  assert.deepEqual(parseExtensionList("dam, acme-sync,,dam"), ["dam", "acme-sync"])
  assert.deepEqual(parseExtensionList(" , "), [])
})

test("endpoints, describe, and ext commands follow the profile's enabled extensions", () => {
  const space = workspace()
  writeFileSync(join(space.project, ".upim", "extensions", "acme-sync.json"), JSON.stringify(acme))
  const base = env(space)

  // Before any profile exists: core only, but installed extensions are listed.
  const bare = runCli(["endpoints", "--json"], space.cwd, base)
  assert.equal(bare.status, 0, bare.stderr)
  assert.deepEqual(json(bare.stdout).extensions, { profile: "default", enabled: [], installed: ["dam", "acme-sync"] })
  assert.equal(json(bare.stdout).commands.some((row: any) => row.extension !== undefined), false)

  const init = runCli([
    "config", "init", "--non-interactive", "--base-url", "https://pim.example.com",
    "--client-id", "id", "--client-secret", "secret", "--username", "robot", "--password", "pw"
  ], space.cwd, base)
  assert.equal(init.status, 0, init.stderr)

  // Disabled extension: the command exists but refuses with the enable hint, and describe does not list it.
  const refused = runCli(["ext", "dam", "assets", "list", "--json"], space.cwd, base)
  assert.equal(refused.status, 1)
  const refusal = json(refused.stderr)
  assert.equal(refusal.error, "ConfigError")
  assert.match(refusal.message, /upim extensions enable dam/)
  const hidden = runCli(["describe", "ext", "dam", "assets", "list", "--json"], space.cwd, base)
  assert.equal(hidden.status, 1)
  assert.match(json(hidden.stderr).message, /No enabled extension command/)

  // Enable writes the profile; endpoints and describe follow.
  const enabled = runCli(["extensions", "enable", "dam", "--json"], space.cwd, base)
  assert.equal(enabled.status, 0, enabled.stderr)
  assert.deepEqual(json(readFileSync(space.configPath, "utf8")).profiles.default.extensions, ["dam"])
  const listed = runCli(["endpoints", "--json"], space.cwd, base)
  const rows = json(listed.stdout).commands.filter((row: any) => row.extension === "dam")
  assert.ok(rows.some((row: any) => row.command === "upim ext dam directories list" && row.path === "/api/v1/rest/directories"))
  assert.equal(json(listed.stdout).commands.some((row: any) => row.extension === "acme-sync"), false)
  const described = runCli(["describe", "ext", "dam", "assets", "list", "--json"], space.cwd, base)
  assert.equal(described.status, 0, described.stderr)
  assert.equal(json(described.stdout).method, "GET")
  assert.equal(json(described.stdout).path, "/api/v1/rest/assets")
  assert.match(json(described.stdout).validation, /422 from the host/)
  const index = runCli(["describe", "--json"], space.cwd, base)
  assert.ok(json(index.stdout).resources.some((row: any) => row.name === "ext dam"))

  // The environment override applies for one run and is not written back.
  const override = runCli(["endpoints", "--json"], space.cwd, env(space, { UPIM_EXTENSIONS: "acme-sync" }))
  assert.deepEqual(json(override.stdout).extensions.enabled, ["acme-sync"])
  assert.ok(json(override.stdout).commands.some((row: any) => row.command === "upim ext acme-sync jobs list"))
  assert.equal(json(override.stdout).commands.some((row: any) => row.extension === "dam"), false)
  assert.deepEqual(json(readFileSync(space.configPath, "utf8")).profiles.default.extensions, ["dam"])

  const list = runCli(["extensions", "list", "--json"], space.cwd, base)
  assert.equal(list.status, 0, list.stderr)
  const summary = json(list.stdout)
  assert.deepEqual(summary.enabled, ["dam"])
  assert.deepEqual(summary.extensions.map((row: any) => [row.name, row.enabled, row.source === "builtin"]), [["dam", true, true], ["acme-sync", false, false]])

  const disabled = runCli(["extensions", "disable", "dam", "--json"], space.cwd, base)
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.deepEqual(json(readFileSync(space.configPath, "utf8")).profiles.default.extensions, [])

  const unknown = runCli(["extensions", "enable", "nope"], space.cwd, base)
  assert.equal(unknown.status, 1)
  assert.match(json(unknown.stderr).message, /No extension named "nope"/)

  // A broken fragment stops the CLI with the file name instead of a stack trace.
  writeFileSync(join(space.project, ".upim", "extensions", "acme-sync.json"), "nope")
  const broken = runCli(["endpoints", "--json"], space.cwd, base)
  assert.equal(broken.status, 1)
  assert.equal(json(broken.stderr).error, "ConfigError")
  assert.match(json(broken.stderr).message, /acme-sync\.json/)
})
