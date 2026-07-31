import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = Object.freeze({
  version: 1,
  transfers: {},
});

export class JsonTransferStore {
  constructor(path) {
    if (!path) {
      throw new TypeError("A transfer-state path is required");
    }
    this.path = path;
  }

  async readState() {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      return {
        version: 1,
        transfers: state?.transfers ?? {},
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  async get(sourceId) {
    const state = await this.readState();
    return state.transfers[sourceId] ?? null;
  }

  async set(sourceId, record) {
    const state = await this.readState();
    state.transfers[sourceId] = record;

    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.path);
  }

  async withTransferLock(callback, {
    timeoutMs = 30_000,
    retryDelayMs = 100,
  } = {}) {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + timeoutMs;
    let handle;

    while (!handle) {
      try {
        handle = await open(lockPath, "wx");
        await handle.writeFile(String(process.pid), "utf8");
      } catch (error) {
        if (error.code !== "EEXIST" || Date.now() >= deadline) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    try {
      return await callback();
    } finally {
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }
}
