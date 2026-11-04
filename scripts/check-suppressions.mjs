// Fails when a suppression comment has no stated reason.
// A reason is `--` followed by non-whitespace text in that comment.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const roots = ["src", "test", "scripts"]
const markers = ["oxlint-disable", "eslint-disable", "@ts-ignore", "@ts-expect-error", "@effect-diagnostics"]
const reason = /--\s*\S/

const files = []
const walk = (directory) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (name.endsWith(".ts") || name.endsWith(".mjs") || name.endsWith(".js")) files.push(path)
  }
}
for (const root of roots) walk(root)

const commentsIn = (source) => {
  const comments = []
  let index = 0
  let line = 1
  const length = source.length

  const takeComment = (startLine, text) => {
    comments.push({ line: startLine, text })
  }

  const readCode = (closer) => {
    while (index < length) {
      const character = source[index]
      const next = source[index + 1]
      if (character === "\n") {
        line++
        index++
        continue
      }
      if (closer === "}" && character === "}") return
      if (character === "/" && next === "/") {
        const startLine = line
        index += 2
        let text = ""
        while (index < length && source[index] !== "\n") text += source[index++]
        takeComment(startLine, text)
        continue
      }
      if (character === "/" && next === "*") {
        const startLine = line
        index += 2
        let text = ""
        while (index < length && !(source[index] === "*" && source[index + 1] === "/")) {
          if (source[index] === "\n") line++
          text += source[index++]
        }
        index = Math.min(index + 2, length)
        takeComment(startLine, text)
        continue
      }
      if (character === "'" || character === "\"") {
        const quote = character
        index++
        while (index < length && source[index] !== quote) {
          if (source[index] === "\\") index += 2
          else {
            if (source[index] === "\n") line++
            index++
          }
        }
        index++
        continue
      }
      if (character === "`") {
        index++
        while (index < length && source[index] !== "`") {
          if (source[index] === "\\") {
            index += 2
            continue
          }
          if (source[index] === "\n") line++
          if (source[index] === "$" && source[index + 1] === "{") {
            index += 2
            readCode("}")
            if (source[index] === "}") index++
            continue
          }
          index++
        }
        index++
        continue
      }
      index++
    }
  }

  readCode()
  return comments
}

const failures = []
for (const file of files) {
  for (const comment of commentsIn(readFileSync(file, "utf8"))) {
    const marker = markers.find((name) => comment.text.includes(name))
    if (marker === undefined) continue
    if (reason.test(comment.text)) continue
    const before = comment.text.slice(0, comment.text.indexOf(marker))
    const markerLine = comment.line + (before.match(/\n/g)?.length ?? 0)
    const snippet = comment.text.trim().replaceAll(/\s+/g, " ")
    failures.push(`${file}:${markerLine}: ${snippet}`)
  }
}

if (failures.length > 0) {
  console.error("Suppression comments need a reason after -- in the comment:")
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
