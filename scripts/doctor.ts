import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { BrowserSession } from '../src/browser/session.js';
import { DIRECTORY_URL } from '../src/domain.js';
const config = readConfig(process.env, false);
const cli = spawnSync(config.codexBin, ['--version'], { encoding: 'utf8', timeout: 10000 });
const checks: Record<string, unknown> = { node: process.version, codex: cli.status === 0 ? cli.stdout.trim() : 'unavailable',
  modelConfigured: Boolean(config.modelApiKey), provider: config.modelBaseUrl ? new URL(config.modelBaseUrl).origin : 'OpenAI default' };
const dir = await mkdtemp(join(tmpdir(), 'flight-doctor-'));
const browser = new BrowserSession({ jobId: randomUUID(), attempt: 1, mawb: '176-00000000', evidenceDir: dir,
  signingKey: 'doctor-only', allowedHosts: config.allowedHosts, resourceHosts: config.resourceHosts, executablePath: config.browserExecutable });
try {
  await browser.start(); checks.browser = 'started';
  if (process.argv.includes('--network')) { const page = await browser.open(DIRECTORY_URL); checks.trackingDirectory = page.url; checks.evidenceCaptured = Boolean(page.evidenceId); }
} catch { checks.browser = 'failed: verify installed Chromium, OS dependencies and outbound HTTPS/DNS'; }
finally { await browser.close(); await rm(dir, { recursive: true, force: true }); }
console.log(JSON.stringify(checks, null, 2));
if (cli.status !== 0 || checks.browser !== 'started') process.exitCode = 1;
