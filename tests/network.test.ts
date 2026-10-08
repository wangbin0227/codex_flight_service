import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { connect } from 'node:net';
import { request } from 'node:http';
import { assertUrl, isPublicAddress, startProxy, upgradeToHttps } from '../src/browser/proxy.js';
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

test('legacy HTTP URLs upgrade without changing shipment paths or query values', () => {
  const path = '/skychain/app;jsessionid=old?service=page/nwp:Trackshipmt&awb=656%2D42988186#details';
  assert.equal(upgradeToHttps(`http://airline.example${path}`).href, `https://airline.example${path}`);
  assert.equal(upgradeToHttps('http://airline.example:80/').href, 'https://airline.example/');
  assert.equal(upgradeToHttps('https://airline.example/').href, 'https://airline.example/');
  for (const url of ['http://airline.example:8080/', 'http://airline.example:443/', 'http://user:secret@airline.example/',
    'http://localhost/', 'http://foo.localhost./', 'http://127.0.0.1/', 'http://2130706433/',
    'http://169.254.169.254/', 'http://100.100.100.200/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd']) {
    assert.throws(() => upgradeToHttps(url), /public HTTPS/, url);
  }
});

test('proxy upgrades legacy redirect hops with a method-preserving redirect and no HTTP upstream', async () => {
  const lookup = mock.method(dns, 'lookup', async () => { throw new Error('HTTP must never connect to the site'); });
  syncBuiltinESMExports();
  const proxy = await startProxy();
  const send = (url: string, method = 'GET') => new Promise<{ status: number | undefined; location: string | undefined }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: new URL(proxy.url).port, path: url, method }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('Proxy did not respond')));
    req.on('error', reject);
    req.end(method === 'POST' ? 'awb=656-42988186' : undefined);
  });
  try {
    for (const method of ['GET', 'POST']) {
      assert.deepEqual(await send('http://airline.example/skychain/app?service=restart', method), {
        status: 307, location: 'https://airline.example/skychain/app?service=restart',
      });
    }
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'http://100.100.100.200/',
      'http://airline.example:8080/', 'http://user:secret@airline.example/', 'https://airline.example/', '/relative']) {
      assert.deepEqual(await send(url), { status: 403, location: undefined }, url);
    }
    assert.equal(lookup.mock.callCount(), 0);
  } finally { await proxy.close(); lookup.mock.restore(); syncBuiltinESMExports(); }
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
