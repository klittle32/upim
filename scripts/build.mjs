// Bundles the CLI into a single dist/main.js.
//
// Node loads about 1,500 files when it runs the unbundled output, which costs
// 0.4 s per call on macOS and about 2 s on Windows. One file removes that, and
// building from the repo's lockfile means every install runs one copy of Effect.
//
// The output must stay at dist/main.js: src/cli.ts and src/skill.ts find
// package.json and skills/ one directory above the entry point.
//
// Usage: node scripts/build.mjs [outDir]   (default: dist)
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "rolldown"

const outDir = resolve(process.argv[2] ?? "dist")
const file = join(outDir, "main.js")

const output = await build({
  input: "src/main.ts",
  platform: "node",
  write: false,
  output: { format: "esm", file }
})

if (output.output.length !== 1) {
  console.error(`Expected one output file, got ${output.output.map((item) => item.fileName).join(", ")}`)
  process.exit(1)
}
const chunk = output.output[0]

// Anything other than a Node builtin left as an import would have to be
// installed next to the package, which is what this build exists to avoid.
const external = [...chunk.imports, ...chunk.dynamicImports].filter((name) => !name.startsWith("node:"))
if (external.length > 0) {
  console.error(`The bundle still imports packages: ${external.join(", ")}`)
  process.exit(1)
}

const packageOf = (id) => {
  const match = id.replaceAll("\\", "/").match(/.*node_modules\/((?:@[^/]+\/)?[^/]+)/)
  return match?.[1]
}
const bundled = new Map()
for (const [id, module] of Object.entries(chunk.modules)) {
  const name = packageOf(id)
  if (name !== undefined && module.renderedLength > 0) {
    const root = id.replaceAll("\\", "/").match(/.*node_modules\/(?:@[^/]+\/)?[^/]+/)[0]
    const previous = bundled.get(name)
    if (previous !== undefined && previous !== root) {
      console.error(`Two copies of ${name} in the bundle: ${previous} and ${root}`)
      process.exit(1)
    }
    bundled.set(name, root)
  }
}

// MIT asks that the notice travel with the code, so the licence of every
// package with code in the bundle ships beside it.
const notices = [...bundled].sort(([a], [b]) => a.localeCompare(b)).map(([name, root]) => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license"].map((n) => join(root, n)).find(existsSync)
  if (licenseFile === undefined) {
    console.error(`No licence file for bundled package ${name}`)
    process.exit(1)
  }
  return `## ${name}@${manifest.version} (${manifest.license})\n\n${readFileSync(licenseFile, "utf8").trim()}\n`
})

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(file, chunk.code)
chmodSync(file, 0o755)
writeFileSync(
  join(outDir, "THIRD_PARTY_LICENSES.md"),
  `# Third-party licences\n\ndist/main.js includes code from these packages.\n\n${notices.join("\n")}`
)

console.log(`${file}: ${(chunk.code.length / 1e6).toFixed(2)} MB from ${[...bundled.keys()].join(", ")} and upim`)
