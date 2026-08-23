import {
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  hardenPrivateFile,
  preparePrivateStatePath,
  PRIVATE_STATE_FILE_MODE,
} from "./private-state.mjs";

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
    await preparePrivateStatePath(this.path);
    await hardenPrivateFile(this.path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
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

    await preparePrivateStatePath(this.path);
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      { encoding: "utf8", mode: PRIVATE_STATE_FILE_MODE },
    );
    await rename(temporaryPath, this.path);
    await hardenPrivateFile(this.path);
  }

  async withTransferLock(callback, {
    timeoutMs = 30_000,
    retryDelayMs = 100,
  } = {}) {
    await preparePrivateStatePath(this.path);
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + timeoutMs;
    let handle;

    while (!handle) {
      try {
        handle = await open(lockPath, "wx", PRIVATE_STATE_FILE_MODE);
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
