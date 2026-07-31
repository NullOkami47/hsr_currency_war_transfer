import { fetchConfig, fetchLineupDetail } from "../src/api.mjs";
import { toGlobalPublishPayload } from "../src/transform.mjs";
import { diffPayloads } from "../src/verify.mjs";

async function main() {
  const sourceId = process.argv[2];
  const globalId = process.argv[3];

  if (!sourceId || !globalId) {
    throw new Error(
      "Usage: node scripts/diff-live.mjs <china-lineup-id> <global-lineup-id>",
    );
  }

  const [globalConfig, sourceResult, globalResult] = await Promise.all([
    fetchConfig("global"),
    fetchLineupDetail("cn", sourceId),
    fetchLineupDetail("global", globalId),
  ]);

  const expected = toGlobalPublishPayload(
    sourceResult.lineup,
    globalConfig,
  );
  const actual = toGlobalPublishPayload(
    globalResult.lineup,
    globalConfig,
  );
  const differences = diffPayloads(expected.payload, actual.payload);
  const gameplayDifferences = diffPayloads(
    expected.payload,
    actual.payload,
    { ignorePaths: ["$.title", "$.description"] },
  );

  console.log(
    JSON.stringify(
      {
        sourceId,
        globalId,
        expectedHash: expected.contentHash,
        actualHash: actual.contentHash,
        ignoredFromSource: expected.ignored,
        ignoredFromGlobal: actual.ignored,
        differenceCount: differences.length,
        differences,
        gameplayDifferenceCount: gameplayDifferences.length,
        gameplayDifferences,
      },
      null,
      2,
    ),
  );

  if (gameplayDifferences.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
