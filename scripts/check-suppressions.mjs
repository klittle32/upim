// Fails when a suppression comment has no stated reason.
// A reason is `--` followed by non-whitespace text on the same line.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const roots = ["src", "test", "scripts"]
const markers = ["oxlint-disable", "@ts-ignore", "@ts-expect-error", "@effect-diagnostics"]
const reason = /--\s*\S/

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path)
    else if (name.endsWith(".ts") || name.endsWith(".mjs") || name.endsWith(".js")) files.push(path)
  }
}
for (const root of roots) walk(root)

const failures = []
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const comment = line.match(/\/\/(.*)$|\/\*(.*)\*\//)
    const text = comment?.[1] ?? comment?.[2]
    if (text === undefined) continue
    if (!markers.some((marker) => text.includes(marker))) continue
    if (reason.test(text)) continue
    failures.push(`${file}:${index + 1}: ${line.trim()}`)
  }
}

if (failures.length > 0) {
  console.error("Suppression comments need a reason after -- on the same line:")
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
