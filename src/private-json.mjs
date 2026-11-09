import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { hardenPrivateFile, preparePrivateStatePath, PRIVATE_STATE_FILE_MODE } from "./private-state.mjs";

// One worker process owns a state directory. Share serialisation across store objects
// in that process too; serverless callers must go through the authenticated worker.
const chains = new Map();
export function serialiseState(path, operation) {
  const key = resolve(path);
  const pending = (chains.get(key) ?? Promise.resolve()).then(operation);
  const settled = pending.catch(() => {});
  chains.set(key, settled);
  settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return pending;
}
export async function readPrivateJson(path) {
  await preparePrivateStatePath(path);
  try {
    await hardenPrivateFile(path);
    const state = JSON.parse(await readFile(path, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid private state");
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function writePrivateJson(path, state) {
  await preparePrivateStatePath(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: PRIVATE_STATE_FILE_MODE });
    await rename(temporaryPath, path);
    await hardenPrivateFile(path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
