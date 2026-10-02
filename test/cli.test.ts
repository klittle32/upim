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

test("--wizard without a terminal explains why", () => {
  const result = runCli(["--wizard"])
  assert.equal(result.status, 1, result.stderr)
  const body = JSON.parse(result.stderr) as { error: string; message: string }
  assert.equal(body.error, "UsageError")
  assert.match(body.message, /interactive terminal/)
  assert.doesNotMatch(result.stderr, /unsettled top-level await/)
})

test("--wizard reads keys from a terminal", () => {
  const script = `
import os, pty, select, sys, time
node, cwd = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execv(node, [node, "src/main.ts", "--wizard"])
buf = b""
def pump(seconds, needle=b""):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        if needle and needle in buf:
            return
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 8192)
        except OSError:
            return
        if not chunk:
            return
        buf += chunk
pump(5, b"--profile")
if b"--profile" not in buf:
    sys.stdout.buffer.write(buf)
    os.kill(pid, 9)
    sys.exit(3)
os.write(fd, b"n")
pump(3, b"Set Json")
if b"Set Json" not in buf:
    sys.stdout.buffer.write(buf)
    os.kill(pid, 9)
    sys.exit(4)
os.write(fd, b"\\x03")
pump(3, b"Wizard cancelled")
sys.stdout.buffer.write(buf)
deadline = time.time() + 2
status = None
while time.time() < deadline:
    wpid, status = os.waitpid(pid, os.WNOHANG)
    if wpid != 0:
        break
    time.sleep(0.05)
else:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    sys.exit(5)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 5)
`
  const result = spawnSync("python3", ["-c", script, process.execPath, process.cwd()], {
    encoding: "utf8",
    timeout: 10000
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /Wizard cancelled/)
})
