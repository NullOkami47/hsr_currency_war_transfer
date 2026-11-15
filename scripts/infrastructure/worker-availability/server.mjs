import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCredentials, parseCredentials } from './credentials.mjs';
import { createProbe, readWorkerHealth } from './probe.mjs';

export const AVAILABILITY_PATH = '/_hsr/availability';
const hash = value => createHash('sha256').update(value).digest();
const unavailable = '{"status":"unavailable"}';

function authenticate(request, expected) {
  const raw = request.rawHeaders;
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === 'authorization') count++;
  if (count !== 1) return false;
  const value = request.headers.authorization;
  if (typeof value !== 'string' || value.length > 512) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.toString('base64') !== match[1]) return false;
  // Hash both complete credentials to fixed lengths before constant-time compare.
  return timingSafeEqual(hash(decoded), expected);
}

export async function startAvailability({ credentials, port = 8790, readUnit, readHealth,
  nowUs = () => process.hrtime.bigint() / 1000n } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid availability configuration');
  // Validate even programmatic callers; production has no host/port/env override.
  const secret = credentials ?? await loadCredentials();
  parseCredentials(secret);
  const expected = hash(`${secret.username}:${secret.password}`);
  const probe = createProbe({ readUnit, readHealth: readHealth ?? readWorkerHealth, nowUs });
  await probe.check();
  let active = 0, budget = 24, lastBudget = nowUs();
  const server = http.createServer({ maxHeaderSize: 4096, headersTimeout: 3000,
    requestTimeout: 3000, keepAliveTimeout: 1000 }, async (req, res) => {
    const reply = healthy => {
      if (res.destroyed) return;
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', connection: 'close', ...(healthy ? {} : { 'retry-after': '5' }) });
      res.end(healthy ? '{"status":"ok"}' : unavailable);
    };
    if (req.rawHeaders.length > 64 || req.method !== 'GET' || req.url !== AVAILABILITY_PATH || !authenticate(req, expected)
        || req.headers['transfer-encoding'] !== undefined
        || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) { reply(false); return; }
    const now = nowUs();
    budget = Math.min(24, budget + Math.max(0, Number(now - lastBudget) / 1000000) * 12);
    lastBudget = now;
    if (budget < 1) { reply(false); return; }
    budget--;
    if (active >= 8) { reply(false); return; }
    active++;
    try { reply(await probe.check()); }
    catch { reply(false); }
    finally { active--; }
  });
  server.maxConnections = 32;
  // Preserve all headers within maxHeaderSize so authentication/framing cannot
  // be hidden by Node's silent count truncation. Reject over 32 pairs above.
  server.maxHeadersCount = 0;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(3000, socket => socket.destroy());
  // Parse failures do not echo Node's parser error or any request contents.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(unavailable)}\r\n\r\n${unavailable}`);
    else socket.destroy();
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, backlog: 32 }, () => { server.off('error', reject); done(); });
  });
  // Observe worker starts even between native Google checks. This timer neither
  // depends on nor requests backup metrics, cloud credentials or HoYoLAB.
  const timer = setInterval(() => { void probe.check(); }, 5000);
  timer.unref();
  server.once('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Invalid availability configuration');
    const server = await startAvailability();
    const stop = () => { server.closeAllConnections(); server.close(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    // Never print credentials, subprocess stderr, environment or HTTP payloads.
    process.stderr.write('Worker availability service could not start.\n');
    process.exitCode = 1;
  }
}
