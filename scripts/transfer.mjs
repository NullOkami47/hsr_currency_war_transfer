import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BrowserSessionPublisher } from "../src/publisher.mjs";
import { JsonTransferStore } from "../src/store.mjs";
import {
  GLOBAL_TEXT_LIMITS,
  transferStrategy,
} from "../src/transfer.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = process.argv[2];
if (!input || input.startsWith("--")) {
  throw new Error(
    "Usage: npm run transfer -- <China lineup URL or id> [--profile-dir PATH] [--state PATH]",
  );
}

const appHome = join(homedir(), ".hsr-currency-war-transfer");
const profileDir = resolve(
  option("--profile-dir") ??
    process.env.CURRENCY_WAR_PROFILE_DIR ??
    join(appHome, "browser-profile"),
);
const statePath = resolve(
  option("--state") ??
    process.env.CURRENCY_WAR_STATE_PATH ??
    join(appHome, "transfers.json"),
);

const publisher = new BrowserSessionPublisher({
  profileDir,
  headless: process.env.CURRENCY_WAR_HEADLESS === "1",
});
const store = new JsonTransferStore(statePath);
const attributionLimits = {
  title: Number(
    process.env.CURRENCY_WAR_TITLE_LIMIT ?? GLOBAL_TEXT_LIMITS.title,
  ),
  description: Number(
    process.env.CURRENCY_WAR_DESCRIPTION_LIMIT ??
      GLOBAL_TEXT_LIMITS.description,
  ),
};

try {
  const result = await transferStrategy(input, {
    publisher,
    store,
    attributionLimits,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await publisher.close();
}
