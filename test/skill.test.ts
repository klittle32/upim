import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const runCli = (args: string[]) =>
  spawnSync(process.execPath, ["src/main.ts", ...args], { encoding: "utf8", env: process.env })

test("skill install copies the bundled skill into a project", () => {
  const project = mkdtempSync(join(tmpdir(), "upim-skill-"))
  writeFileSync(join(project, "package.json"), "{}\n")
  const result = runCli(["skill", "install", "--dir", project, "--json"])
  assert.equal(result.status, 0, result.stderr)
  const body = JSON.parse(result.stdout) as { installed: string }
  const skill = readFileSync(join(body.installed, "SKILL.md"), "utf8")
  assert.equal(body.installed, join(project, ".agents", "skills", "upim"))
  assert.match(skill, /^---\nname: upim\n/)
  assert.match(skill, /upim endpoints --json/)
  assert.match(skill, /example\.command/)
  assert.match(skill, /stderr/)
  assert.match(skill, /--live/)
  assert.match(skill, /\/api\/v1\/rest/)
})

test("skill install --path accepts a project path and a home path", () => {
  const project = mkdtempSync(join(tmpdir(), "upim-skill-path-"))
  const home = mkdtempSync(join(tmpdir(), "upim-skill-home-"))
  const relative = runCli(["skill", "install", "--path", ".letta/skills/upim", "--dir", project, "--json"])
  assert.equal(relative.status, 0, relative.stderr)
  assert.equal(JSON.parse(relative.stdout).installed, join(project, ".letta", "skills", "upim"))
  assert.match(readFileSync(join(project, ".letta", "skills", "upim", "SKILL.md"), "utf8"), /name: upim/)

  const userPath = spawnSync(process.execPath, ["src/main.ts", "skill", "install", "--path", "~/.claude/skills/upim", "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home }
  })
  assert.equal(userPath.status, 0, userPath.stderr)
  assert.equal(JSON.parse(userPath.stdout).installed, join(home, ".claude", "skills", "upim"))
})
