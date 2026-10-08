import { mock } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import type { RequestListener } from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, createPublicKey } from 'node:crypto';
import { chromium, type LaunchOptions } from 'playwright';

// Exercise Chromium redirects through the real proxy without external traffic.
// Only the test origin's public DNS answer and pinned connection are substituted.
export async function httpsFixture(handler: RequestListener) {
  const dir = await mkdtemp(join(tmpdir(), 'https-fixture-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=airline.example', '-addext', 'subjectAltName=DNS:airline.example',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'cert.pem'));
  const server = createServer({ key: await readFile(join(dir, 'key.pem')), cert }, handler);
  const sockets = new Set<Duplex>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as net.AddressInfo).port;
  const originalLookup = dns.lookup, originalConnect = net.connect;
  const lookup = mock.method(dns, 'lookup', (...args: unknown[]) => args[0] === 'airline.example'
    ? Promise.resolve([{ address: '1.1.1.1', family: 4 }]) : Reflect.apply(originalLookup, dns, args));
  const connect = mock.method(net, 'connect', (...args: unknown[]) => {
    const options = args[0] as { host?: string; port?: number };
    return options?.host === '1.1.1.1' && options.port === 443
      ? originalConnect({ host: '127.0.0.1', port }) : Reflect.apply(originalConnect, net, args);
  });
  // Trust only this temporary test certificate, including the first popup load.
  const pin = createHash('sha256').update(createPublicKey(cert).export({ type: 'spki', format: 'der' })).digest('base64');
  const originalLaunch = chromium.launch.bind(chromium);
  const launch = mock.method(chromium, 'launch', (options: LaunchOptions = {}) => originalLaunch({
    ...options, args: [...(options.args ?? []), `--ignore-certificate-errors-spki-list=${pin}`],
  }));
  syncBuiltinESMExports();
  return {
    origin: 'https://airline.example',
    close: async () => {
      lookup.mock.restore(); connect.mock.restore(); launch.mock.restore(); syncBuiltinESMExports();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
