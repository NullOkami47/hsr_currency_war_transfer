import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { createLoginStartupGate } from '../scripts/infrastructure/gcp-login-startup-gate.mjs';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('startup gate denies all pre-admission connections and unknown hosts without upstream traffic', async () => {
  let calls = 0;
  const echo = createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  const gate = await createLoginStartupGate({ hosts: ['official.example.invalid'], connectFn: (_, ready) => {
    calls++; return connect({ host: '127.0.0.1', port: echo.address().port }, ready);
  } });
  const tunnel = async authority => {
    const socket = connect({ host: '127.0.0.1', port: new URL(gate.server).port });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const response = await new Promise((resolve, reject) => { socket.once('data', data => resolve(data.toString())); socket.once('error', reject); });
    socket.destroy(); return response;
  };
  try {
    assert.match(await tunnel('official.example.invalid:443'), /403/); assert.equal(calls, 0);
    gate.admit();
    for (const host of ['evil.invalid:443', 'official.example.invalid:80', 'official.example.invalid.evil:443', '127.0.0.1:443']) assert.match(await tunnel(host), /403/);
    assert.equal(calls, 0);
    assert.match(await tunnel('official.example.invalid:443'), /200/); assert.equal(calls, 1);
  } finally { await gate.close(); await new Promise(resolve => echo.close(resolve)); }
});

test('real Chrome can start and reopen a persistent profile behind a closed startup gate', { skip: process.env.HSR_READONLY_BROWSER_GUARD_TEST !== '1' }, async () => {
  const { chromium } = await import('playwright-core');
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'gcp-startup-chrome-')));
  let connects = 0, context;
  const gate = await createLoginStartupGate({ hosts: ['official.example.invalid'], connectFn: () => { connects++; throw new Error('Upstream must stay closed'); } });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      context = await chromium.launchPersistentContext(join(parent, 'profile'), { channel: 'chrome', headless: true, chromiumSandbox: true,
        serviceWorkers: 'block', proxy: { server: gate.server }, timeout: 10000, args: ['--disable-extensions', '--disable-background-networking'] });
      const page = await context.newPage();
      await assert.rejects(page.goto('https://official.example.invalid/', { timeout: 3000 }));
      assert.equal(connects, 0);
      await context.close(); context = undefined;
    }
  } finally { await context?.close(); await gate.close(); await rm(parent, { recursive: true, force: true }); }
});
