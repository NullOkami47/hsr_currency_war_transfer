import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

export const CREDENTIALS_DIRECTORY = '/run/credentials/hsr-worker-availability.service';
const invalid = () => { throw new Error('Invalid availability credentials'); };

export function assertPrivateMetadata(stat, { uid, maxBytes, directory = false, credentialDirectory }) {
  const privateOwner = [0, uid].includes(stat.uid) && !(stat.mode & 0o077);
  // systemd's private credential projection may use root:root with an ACL for
  // DynamicUser. Its group need not equal the process group. Accept only the
  // observed read-only shape in this service's fixed credential namespace.
  const systemdProjection = credentialDirectory === CREDENTIALS_DIRECTORY
    && stat.uid === 0 && stat.gid === 0 && (stat.mode & 0o7777) === (directory ? 0o550 : 0o440);
  if (!Number.isSafeInteger(uid) || (!privateOwner && !systemdProjection)
      || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1
        || stat.size < 1 || stat.size > maxBytes)) invalid();
}

export function validateBasicCredentials(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username)
      || typeof password !== 'string' || !/^[A-Za-z0-9._~+/-]{32,128}={0,2}$/.test(password)) invalid();
  return { username, password };
}

export function parseCredentials(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'password,username'
      || ![value.username, value.password].every(item => typeof item === 'string')) invalid();
  return validateBasicCredentials(value.username.replace(/\r?\n$/, ''), value.password.replace(/\r?\n$/, ''));
}

// systemd supplies a private, read-only credential projection to DynamicUser.
// Only the dedicated read-only probe credential is loaded.
export async function loadCredentials(directory = process.env.CREDENTIALS_DIRECTORY) {
  if (process.platform !== 'linux' || directory !== CREDENTIALS_DIRECTORY) invalid();
  try {
    const uid = process.getuid();
    assertPrivateMetadata(await lstat(directory), { uid, directory: true, credentialDirectory: directory });
    async function read(name, maxBytes) {
      const path = join(directory, name);
      const before = await lstat(path);
      assertPrivateMetadata(before, { uid, maxBytes, credentialDirectory: directory });
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const bytes = Buffer.alloc(maxBytes + 1);
      try {
        const stat = await handle.stat();
        assertPrivateMetadata(stat, { uid, maxBytes, credentialDirectory: directory });
        if (stat.ino !== before.ino || stat.dev !== before.dev) invalid();
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== stat.size || bytesRead > maxBytes) invalid();
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
      } finally { bytes.fill(0); await handle.close(); }
    }
    const [username, password] = await Promise.all([
      read('probe-username', 128), read('probe-password', 256),
    ]);
    return parseCredentials({ username, password });
  } catch { invalid(); }
}
