import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { BrowserSessionPublisher } from "../src/publisher.mjs";
import { JsonTransferStore } from "../src/store.mjs";
import {
  GLOBAL_TEXT_LIMITS,
  transferStrategy,
} from "../src/transfer.mjs";
import {
  createWorkerHandler,
  JsonWorkerJobStore,
  TransferJobQueue,
} from "../src/worker.mjs";

const appHome = join(homedir(), ".hsr-currency-war-transfer");
const profileDir = resolve(
  process.env.CURRENCY_WAR_PROFILE_DIR ?? join(appHome, "browser-profile"),
);
const transferStatePath = resolve(
  process.env.CURRENCY_WAR_STATE_PATH ?? join(appHome, "transfers.json"),
);
const jobStatePath = resolve(
  process.env.CURRENCY_WAR_JOB_STATE_PATH ?? join(appHome, "jobs.json"),
);
const token = process.env.CURRENCY_WAR_WORKER_TOKEN;
const host = process.env.CURRENCY_WAR_WORKER_HOST ?? "127.0.0.1";
const port = Number(process.env.CURRENCY_WAR_WORKER_PORT ?? 8787);

if (!token || token.length < 24) {
  throw new Error(
    "CURRENCY_WAR_WORKER_TOKEN must be configured with at least 24 characters",
  );
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CURRENCY_WAR_WORKER_PORT must be a valid TCP port");
}

const publisher = new BrowserSessionPublisher({
  profileDir,
  headless: process.env.CURRENCY_WAR_HEADLESS === "1",
});
const transferStore = new JsonTransferStore(transferStatePath);
const jobStore = new JsonWorkerJobStore(jobStatePath);
const attributionLimits = {
  title: Number(
    process.env.CURRENCY_WAR_TITLE_LIMIT ?? GLOBAL_TEXT_LIMITS.title,
  ),
  description: Number(
    process.env.CURRENCY_WAR_DESCRIPTION_LIMIT
      ?? GLOBAL_TEXT_LIMITS.description,
  ),
};
const queue = new TransferJobQueue({
  store: jobStore,
  transferFn: (sourceId) => transferStrategy(sourceId, {
    publisher,
    store: transferStore,
    attributionLimits,
  }),
});

await queue.start();
const server = createServer(createWorkerHandler({ queue, token }));

server.listen(port, host, () => {
  console.log(`Currency War worker listening on http://${host}:${port}`);
  console.log(`Persistent profile: ${profileDir}`);
  console.log(`Transfer state: ${transferStatePath}`);
  console.log(`Job state: ${jobStatePath}`);
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolveClose) => server.close(resolveClose));
  await publisher.close();
}

process.once("SIGINT", async () => {
  await close();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await close();
  process.exit(0);
});
