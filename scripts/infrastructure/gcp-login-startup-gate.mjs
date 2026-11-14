import { createServer } from 'node:http';
import { connect } from 'node:net';

// Starts closed before Chrome exists. No request bodies, paths or credentials
// are inspected or logged. Only exact HTTPS destinations may be tunnelled.
export async function createLoginStartupGate({ hosts, connectFn = connect }) {
  const approved = new Set(hosts);
  let admitted = false;
  const sockets = new Set();
  const server = createServer((_, response) => response.writeHead(403).end());
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  server.on('connection', track);
  server.on('connect', (request, client, head) => {
    const match = /^([a-z0-9.-]+):443$/.exec(request.url ?? '');
    if (!admitted || !match || !approved.has(match[1])) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = track(connectFn({ host: match[1], port: 443 }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    }));
    upstream.setTimeout(20000, () => upstream.destroy());
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    admit() { admitted = true; },
    async close() { admitted = false; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
