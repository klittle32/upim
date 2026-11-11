import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// Lays the bundle out the way npm installs it, but outside the repo, so a
// stray node_modules lookup or a path that assumes src/ fails here.
test("the bundled CLI runs on its own from an installed layout", () => {
  const root = mkdtempSync(join(tmpdir(), "upim-bundle-"))
  const build = spawnSync(process.execPath, ["scripts/build.mjs", join(root, "dist")], { encoding: "utf8" })
  assert.equal(build.status, 0, build.stderr)
  cpSync("package.json", join(root, "package.json"))
  cpSync("skills", join(root, "skills"), { recursive: true })

  assert.deepEqual(readdirSync(join(root, "dist")).sort(), ["THIRD_PARTY_LICENSES.md", "main.js"])
  const main = join(root, "dist", "main.js")
  assert.match(readFileSync(main, "utf8"), /^#!\/usr\/bin\/env node\n/)
  if (process.platform !== "win32") assert.equal(statSync(main).mode & 0o111, 0o111)
  assert.match(readFileSync(join(root, "dist", "THIRD_PARTY_LICENSES.md"), "utf8"), /## effect@[\d.]+ \(MIT\)/)

  const version = spawnSync(process.execPath, [main, "--version"], { encoding: "utf8", cwd: root })
  assert.equal(version.status, 0, version.stderr)
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string }
  assert.equal(version.stdout.trim(), `upim v${manifest.version}`)

  const project = mkdtempSync(join(tmpdir(), "upim-bundle-skill-"))
  writeFileSync(join(project, "package.json"), "{}\n")
  const skill = spawnSync(process.execPath, [main, "skill", "install", "--dir", project, "--json"], { encoding: "utf8" })
  assert.equal(skill.status, 0, skill.stderr)
  const installed = (JSON.parse(skill.stdout) as { installed: string }).installed
  assert.match(readFileSync(join(installed, "SKILL.md"), "utf8"), /^---\nname: upim\n/)
})

test("the published package has no runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.equal((manifest.bin as Record<string, string>).upim, "dist/main.js")
})
