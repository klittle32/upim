// Writes `count` token sets for one profile into a shared token file.
// The storage test runs several copies at once to exercise the file lock.
import { dirname } from "node:path"
import { NodeCrypto } from "@effect/platform-node"
import { Effect, Layer, Path } from "effect"
import { layer as nodeFileSystem } from "../../src/filesystem.ts"
import { makeTokenStore } from "../../src/tokens.ts"

const [tokenPath, profile, count] = process.argv.slice(2)
if (!tokenPath || !profile) {
  process.stderr.write("usage: token-writer.ts <tokens.json> <profile> [count]\n")
  process.exit(2)
}

const store = makeTokenStore({ configPath: `${dirname(tokenPath)}/config.json`, tokenPath }, profile)
const writes = Number(count ?? "1")

await Effect.runPromise(
  Effect.forEach(
    Array.from({ length: writes }, (_, index) => index),
    (index) => store.write({
      accessToken: `access-${profile}-${index}`,
      refreshToken: "refresh",
      tokenType: "Bearer",
      expiresAt: 1_700_000_000_000
    }),
    { discard: true }
  ).pipe(Effect.provide(Layer.mergeAll(nodeFileSystem, Path.layer, NodeCrypto.layer)))
)
