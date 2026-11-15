import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMonitorSnapshot } from './azure-blob-backup.mjs';
import {
  PINNED_CONFIG_PATH,
  PINNED_CONTROL_DIR,
  PINNED_SERVICE,
  PINNED_SPOOL_DIR,
  createGcpNativeBackupClient,
  validateGcpNativeBackupConfig,
} from './gcp-native-backup.mjs';

/**
 * Exports only allowlisted failure metadata from the local recovery journal to
 * the GCP-specific monitor/events prefix. Never restarts the worker or alters admission.
 */
export async function notifyGcpBackupFailure({ config, recordStatus, readMonitor = readMonitorSnapshot }) {
  const service = config?.service;
  if (typeof service !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(service)) {
    throw new Error('Valid systemd service name required.');
  }
  const unknown = () => ({ status: 'skipped', transportVerified: false, restoreVerified: false });
  const snapshot = await readMonitor({ directory: PINNED_CONTROL_DIR, service, recovered: false });
  return recordStatus({
    result: 'failure',
    stage: 'coordinator',
    mode: 'scheduled',
    perDest: { azure: unknown(), gcs: unknown() },
    snapshot,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const configPath = args.length === 0 ? PINNED_CONFIG_PATH : args.length === 1 ? args[0] : null;
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || configPath !== PINNED_CONFIG_PATH) {
    throw new Error('Root and pinned GCP backup configuration required.');
  }
  const st = await lstat(configPath);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o077)) {
    throw new Error('Protected root-owned configuration required.');
  }
  const config = validateGcpNativeBackupConfig(JSON.parse(await readFile(configPath, 'utf8')));
  if (config.service !== PINNED_SERVICE || config.backupDirectory !== PINNED_SPOOL_DIR) {
    throw new Error('Pinned GCP production backup service and spool required.');
  }
  const client = createGcpNativeBackupClient({ config, timeoutMs: 30000 });
  console.log(JSON.stringify(await notifyGcpBackupFailure({ config, recordStatus: client.recordStatus })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('GCP failure notification could not be exported; independent missed-schedule monitoring remains required.');
    process.exitCode = 1;
  });
}
