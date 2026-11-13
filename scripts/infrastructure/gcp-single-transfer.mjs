import { open, readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { contentHash } from '../../src/transform.mjs';
import { transferStrategy } from '../../src/transfer.mjs';
import { JsonTransferStore } from '../../src/store.mjs';
import { BrowserSessionPublisher } from '../../src/publisher.mjs';
import { runReadOnlyLogin, verifyReadOnlySession } from './gcp-login-readonly.mjs';

const CREATE = 'https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar/game/lineup/create_lineup_tourn';
const MINE = 'https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar/game/user/lineup';
const SOURCE = '6ae853e2267945d9413ab49e';

export function createSingleWriteGate({ sourceId, payloadHash, journalPath, expiresAt, now = Date.now }) {
  if (!/^[a-f0-9]{24}$/.test(sourceId) || !/^[a-f0-9]{64}$/.test(payloadHash) || !Number.isFinite(Date.parse(expiresAt))) throw new Error('Exact one-shot authority required');
  let armed = false, spent = false, aborted = false;
  return {
    arm() { armed = true; },
    disarm() { armed = false; },
    abort() { aborted = true; armed = false; },
    current() { return armed && !aborted && now() < Date.parse(expiresAt); },
    async admit(request) {
      if (!this.current() || spent || request.url !== CREATE || request.method !== 'POST') return false;
      let body; try { body = JSON.parse(request.postData); } catch { return false; }
      if (body?.game !== 'hkrpg' || contentHash(body) !== payloadHash) return false;
      // Consume synchronously, then persist BEFORE allowing any upstream call.
      spent = true;
      const file = await open(journalPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ sourceId, payloadHash, status: 'attempted-unconfirmed', attemptedAt: new Date().toISOString() })); await file.sync(); }
      finally { await file.close(); }
      if (process.platform !== 'win32') {
        const parent = await open(dirname(journalPath), 'r');
        try { await parent.sync(); } finally { await parent.close(); }
      }
      return this.current();
    },
  };
}

async function privateJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768 || (stat.mode & 0o077) !== 0) throw new Error('Private bounded configuration required');
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

async function singleTransfer(configPath) {
  const config = await privateJson(configPath), auth = config.singleTransfer;
  const root = `/var/lib/hsr-transfer-worker-staging/live-test-${SOURCE}`;
  if (process.platform !== 'linux' || process.getuid() === 0 || auth?.sourceId !== SOURCE || config.login?.resume !== true
    || config.login?.officialLogin !== true || config.login?.maxSeconds > 300
    || config.login?.profileDir !== '/var/lib/hsr-transfer-worker-staging/login/gcp-readonly-profile-login-20261112'
    || auth?.statePath !== `${root}/transfers.json` || auth?.journalPath !== `${root}/attempt.json`
    || auth?.resultPath !== `${root}/result.json` || Date.parse(auth?.expiresAt) - Date.now() > 15 * 60000
    || Object.keys(process.env).some(key => key.startsWith('CURRENCY_WAR_'))) throw new Error('Fixed authorised single-source GCP test required');
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077)) throw new Error('Private test directory required');
  const gate = createSingleWriteGate(auth);
  const store = new JsonTransferStore(auth.statePath);
  if (await store.get(SOURCE)) throw new Error('Existing test mapping requires read-only reconciliation, not another live attempt');
  const { chromium } = await import('playwright-core');
  let context, result;
  const checks = await runReadOnlyLogin({ config,
    launchPersistentContext: async (...args) => {
      context = await chromium.launchPersistentContext(...args);
      const install = context.route.bind(context);
      context.route = (pattern, strictHandler) => install(pattern, async route => {
        const r = route.request();
        const request = { url: r.url(), method: r.method(), postData: r.postData() };
        let allowed = false;
        // Fixed read used only to locate an acknowledged create if its response
        // omits the ID. It cannot create/edit/delete and is never logged.
        if (request.url === MINE && request.method === 'POST') {
          try {
            const b = JSON.parse(request.postData);
            allowed = contentHash(b) === contentHash({ game: 'hkrpg', page: '1', limit: '20', lineup_type: 'Tourn', order: 'CreatedTime' });
          } catch { /* deny */ }
        }
        if (!allowed && request.url === CREATE && request.method === 'OPTIONS' && Date.now() < Date.parse(auth.expiresAt)) allowed = true;
        if (!allowed) allowed = await gate.admit(request);
        if (!allowed) return strictHandler(route);
        if (request.url === CREATE && request.method === 'POST' && !gate.current()) { await route.abort('blockedbyclient'); return; }
        try {
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15000 });
          try {
            if (response.status() >= 300 && response.status() < 400) await route.abort('blockedbyclient');
            else await route.fulfill({ response });
          } finally { await response.dispose(); }
        } catch { await route.abort('blockedbyclient'); }
      });
      return context;
    },
    confirmReady: async ({ signal }) => {
      signal.addEventListener('abort', () => gate.abort(), { once: true });
      await delay(5000, undefined, { signal });
      const page = context.pages()[0];
      await verifyReadOnlySession(page);
      const publisher = new BrowserSessionPublisher({ profileDir: config.login.profileDir, headless: true, logger: {} });
      publisher.context = context; publisher.page = page;
      // Never run publisher's authentication write retry/rebuild path.
      const direct = publisher.requestUnlocked.bind(publisher);
      publisher.requestUnlocked = (path, payload) => direct(path, payload, { authRecoveryAttempt: 2 });
      publisher.edit = async () => { throw new Error('Editing is not authorised'); };
      const create = publisher.create.bind(publisher);
      publisher.create = async payload => {
        if (contentHash({ ...payload, game: 'hkrpg' }) !== auth.payloadHash) throw new Error('Source content changed after approved preparation');
        signal.throwIfAborted(); gate.arm();
        try { return await create(payload); } finally { gate.disarm(); }
      };
      result = await transferStrategy(SOURCE, { publisher, store });
      // Same source must return the stored publication without another write.
      const duplicate = await transferStrategy(SOURCE, { publisher: { create: async () => { throw new Error('Duplicate create blocked'); }, edit: async () => { throw new Error('Duplicate edit blocked'); } }, store });
      if (duplicate.status !== 'unchanged' || duplicate.globalId !== result.globalId) throw new Error('Duplicate suppression verification failed');
      result = { ...result, duplicateStatus: duplicate.status, authorisedSourceOnly: true, maximumCreateAttempts: 1 };
      await writeFile(auth.resultPath, JSON.stringify(result), { mode: 0o600 });
    },
  });
  console.log(JSON.stringify({ ...result, postWriteReadOnlyChecks: checks.authenticatedReadOnlyChecks, productionCutover: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path, flag, ...extra] = process.argv.slice(2);
  if (!path || flag !== '--authorise-one-live-create' || extra.length) throw new Error('Explicit single live create authority required');
  singleTransfer(path).catch(() => { console.error('Single transfer stopped; inspect private attempt/mapping receipts before any retry. Never resend an unconfirmed create.'); process.exitCode = 1; });
}
