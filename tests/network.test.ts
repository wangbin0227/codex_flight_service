import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedHost, assertUrl, isPublicAddress } from '../src/browser/proxy.js';
test('browser cannot target localhost, metadata, private networks or disguised hosts', () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.2.3', '192.168.1.1', '169.254.169.254', '100.100.100.200', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(allowedHost('sub.emirates.com', ['emirates.com']), true);
  assert.equal(allowedHost('emirates.com.attacker.test', ['emirates.com']), false);
  for (const url of ['http://emirates.com/', 'file:///etc/passwd', 'https://emirates.com:444/', 'https://name:password@emirates.com/', 'https://127.0.0.1/', 'https://emirates.com.attacker.test/']) assert.throws(() => assertUrl(url, ['emirates.com']));
});
