import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { DEFAULT_TIMEOUTS } from '../timeouts.js';

export function isPublicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === 'unicast';
  } catch { return false; }
}
export function assertUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || host === 'localhost' || host.endsWith('.localhost') || (ipaddr.isValid(host) && !isPublicAddress(host))) {
    throw new Error('Destination must be a public HTTPS address on port 443 without credentials.');
  }
  return url;
}
// Every Chromium network connection uses this proxy. DNS is resolved and checked before
// connecting to a pinned address; redirects and subresources cannot reach ECS metadata or LANs.
export async function startProxy(idleTimeoutMs = DEFAULT_TIMEOUTS.proxyIdleMs): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((_req, res) => { res.writeHead(403); res.end('HTTPS only'); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', async (req, client, head) => {
    let upstream: import('node:net').Socket | undefined;
    client.on('error', () => upstream?.destroy());
    client.on('close', () => upstream?.destroy());
    try {
      const authority = req.url ?? '';
      if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):443$/i.test(authority)) throw new Error('Invalid tunnel');
      const host = assertUrl(`https://${authority}`).hostname.replace(/^\[|\]$/g, '');
      const addresses = await lookup(host, { all: true });
      if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Address blocked');
      const address = addresses[0]!;
      if (client.destroyed) return;
      upstream = connect({ host: address.address, port: 443, family: address.family });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream!));
      upstream.setTimeout(idleTimeoutMs, () => { upstream?.destroy(); client.destroy(); });
      upstream.on('error', () => client.destroy());
      upstream.on('connect', () => {
        if (client.destroyed) { upstream?.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream!.write(head);
        upstream!.pipe(client); client.pipe(upstream!);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy startup failed');
  return { server, url: `http://127.0.0.1:${address.port}`, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
