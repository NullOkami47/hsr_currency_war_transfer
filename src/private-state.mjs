import { chmod, mkdir } from "node:fs/promises";
import { posix, win32 } from "node:path";

export const PRIVATE_STATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_STATE_FILE_MODE = 0o600;

export async function preparePrivateStatePath(path, {
  platform = process.platform,
  mkdirFn = mkdir,
  chmodFn = chmod,
} = {}) {
  const directory = (platform === "win32" ? win32 : posix).dirname(path);
  await mkdirFn(directory, {
    recursive: true,
    mode: PRIVATE_STATE_DIRECTORY_MODE,
  });
  if (platform !== "win32") {
    await chmodFn(directory, PRIVATE_STATE_DIRECTORY_MODE);
  }
}

export async function hardenPrivateFile(path, {
  platform = process.platform,
  chmodFn = chmod,
} = {}) {
  if (platform !== "win32") {
    await chmodFn(path, PRIVATE_STATE_FILE_MODE);
  }
}
