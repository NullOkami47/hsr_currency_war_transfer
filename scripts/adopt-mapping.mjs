import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parseChinaLineupInput } from "../src/api.mjs";
import { JsonTransferStore } from "../src/store.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceInput = process.argv[2];
const globalId = process.argv[3];
if (!sourceInput || !/^[a-f0-9]{24}$/i.test(globalId ?? "")) {
  throw new Error(
    "Usage: npm run mapping:adopt -- <China lineup URL or id> <global lineup id> [--state PATH]",
  );
}

const statePath = resolve(
  option("--state") ??
    process.env.CURRENCY_WAR_STATE_PATH ??
    join(homedir(), ".hsr-currency-war-transfer", "transfers.json"),
);
const sourceId = parseChinaLineupInput(sourceInput);
const store = new JsonTransferStore(statePath);

await store.withTransferLock(() =>
  store.set(sourceId, {
    globalId,
    sourceHash: null,
    shareCode: null,
    updatedAt: new Date().toISOString(),
  }),
);

console.log(
  JSON.stringify({ sourceId, globalId, statePath, adopted: true }, null, 2),
);
