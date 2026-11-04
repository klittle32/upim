# AGENTS.md

`upim` is an Effect 4 CLI.

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md` completely, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the guide doesn't cover, search through the source code in `node_modules/effect/src`. Effect 4 renamed much of Effect 3. The installed `.d.ts` files are the API that is actually here.

A task is not done until `npm run verify` passes (`check`, `lint`, `check-suppressions`, and `test`).

Do not add `oxlint-disable`, `@ts-ignore`, `@ts-expect-error`, or `@effect-diagnostics` comments unless the same line includes `--` and a reason. `npm run check-suppressions` fails the build otherwise.

## Use Effect, not the platform globals

These are errors under oxlint (`effecttsgo/*`) and under `tsc`. Tests (`test/**`) and `scripts/**` are the boundary: node:test, process spawning, and the suppression checker may use the platform there. `src/main.ts` is the only `NodeRuntime.runMain` entrypoint.

| Do not write | Write instead |
| --- | --- |
| `try` / `catch` inside `Effect.gen` | `Effect.try`, `Effect.tryPromise`, `Effect.catch`, `Effect.catchTag` |
| `throw new Error` | `Schema.TaggedError`, then yield it or `Effect.fail` |
| `async` / `await`, `new Promise` | `Effect.gen` or `Effect.fn`; `Effect.promise` / `Effect.tryPromise` at a boundary |
| global `fetch` | `HttpClient` and `FetchHttpClient` from `effect/http` |
| `console.*` | `Effect.log`, `Effect.logInfo`, `Effect.logWarning`, `Effect.logError` |
| `process.env` | `Config.String` and `Config.option` |
| `setTimeout` / `setInterval` | `Effect.sleep`, `Schedule`, `Clock` |
| `Date.now()`, `new Date()` | `Clock.currentTimeMillis`, `DateTime.now`, `DateTime.makeUnsafe`, `DateTime.formatIso` |
| `Math.random()` | `Random.next` |
| `JSON.parse` / `JSON.stringify` for data | `Schema.decodeUnknownEffect(Schema.fromJsonString(...))` and a schema encoder |
| `node:fs`, `node:path`, `node:crypto`, `node:child_process` | `FileSystem`, `Path`, `effect/crypto`, `ChildProcess` / `ChildProcessSpawner` from `effect/process` |

`node:os` has no Effect counterpart. `os.homedir()` in `src/paths.ts` and `src/skill.ts` is the home-directory boundary.

## Commands

```sh
npm install          # patches tsc and oxlint (effect-tsgo patch --typescript --oxlint) and builds dist
npm run check        # tsc, TypeScript 7, Effect diagnostics
npm run lint         # oxlint --deny-warnings, recommended Effect preset, slip rules as errors
npm run diagnostics  # same Effect diagnostics as check, as JSON
npm run check-suppressions
npm test
npm run verify
```
