import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import { assertUrl, isPublicAddress, startProxy } from '../src/browser/proxy.js';
import { BrowserSession } from '../src/browser/session.js';

test('browser accepts public HTTPS domains without an airline or resource allowlist', () => {
  for (const url of ['https://freight.qantas.com/', 'https://www.airniugini.com.pg/cargo/',
    'https://eskycargo.emirates.com/tracking', 'https://www.sky-cargo.com/', 'https://resources.example/widget.js',
    'https://1.1.1.1/', 'https://[2606:4700:4700::1111]/']) assert.doesNotThrow(() => assertUrl(url));
});

test('browser still rejects localhost, metadata, private IPs, unsupported protocols and credentials', () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.2.3', '192.168.1.1', '169.254.169.254', '100.100.100.200', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  for (const url of ['http://emirates.com/', 'file:///etc/passwd', 'ftp://example.com/', 'https://emirates.com:444/',
    'https://name:password@emirates.com/', 'https://localhost/', 'https://foo.localhost./', 'https://127.0.0.1/',
    'https://2130706433/', 'https://0x7f000001/', 'https://169.254.169.254/', 'https://100.100.100.200/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/']) assert.throws(() => assertUrl(url), /public HTTPS/);
});

test('queries must still begin at track-trace', async () => {
  const session = new BrowserSession({ jobId: 'first-page-test', attempt: 1, mawb: '176-12345678',
    evidenceDir: '/unused-first-page-test', signingKey: 'test-only' });
  await assert.rejects(session.open('https://freight.qantas.com/'), /Open track-trace first/);
});

test('proxy rejects a domain when any DNS answer is private', async () => {
  const lookup = mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  syncBuiltinESMExports();
  const proxy = await startProxy();
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(proxy.url).port) });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      socket.setTimeout(2000, () => reject(new Error('Proxy did not reject private DNS')));
      socket.once('error', reject);
      socket.once('data', data => resolve(data.toString()));
      socket.once('connect', () => socket.write('CONNECT airline.example:443 HTTP/1.1\r\nHost: airline.example:443\r\n\r\n'));
    });
    assert.match(response, /^HTTP\/1.1 403/);
    assert.equal(lookup.mock.callCount(), 1);
  } finally {
    socket.destroy(); await proxy.close(); lookup.mock.restore(); syncBuiltinESMExports();
  }
});
