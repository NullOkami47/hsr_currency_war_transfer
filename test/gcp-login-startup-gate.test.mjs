import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { createLoginStartupGate } from '../scripts/infrastructure/gcp-login-startup-gate.mjs';

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
