import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIRECTORY_URL, type Evidence } from '../domain.js';
import { signEvidence } from '../evidence.js';
import { assertUrl, startProxy } from './proxy.js';

export interface BrowserSettings {
  jobId: string; attempt: number; mawb: string; evidenceDir: string; signingKey: string;
  allowedHosts: string[]; executablePath?: string;
}
export class BrowserSession {
  private browser?: Browser; private context?: BrowserContext; private page?: Page;
  private proxy?: Awaited<ReturnType<typeof startProxy>>;
  private refs = new Map<string, Locator>(); private sequence = 0; private operations = 0;
  constructor(readonly settings: BrowserSettings) {}
  async start() {
    this.proxy = await startProxy(this.settings.allowedHosts);
    this.browser = await chromium.launch({ headless: true, executablePath: this.settings.executablePath,
      proxy: { server: this.proxy.url }, args: ['--disable-quic', '--proxy-bypass-list=<-loopback>'],
      env: { PATH: process.env.PATH ?? '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    });
    this.context = await this.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1440, height: 1100 } });
    await this.context.route('**/*', async route => {
      try { assertUrl(route.request().url(), this.settings.allowedHosts); await route.continue(); }
      catch { await route.abort('blockedbyclient'); }
    });
    this.page = await this.context.newPage();
    this.context.on('page', page => { this.page = page; this.refs.clear(); page.on('dialog', d => void d.dismiss()); });
    this.page.on('dialog', d => void d.dismiss());
    await mkdir(this.settings.evidenceDir, { recursive: true, mode: 0o700 });
  }
  private current(): Page {
    if (!this.page || ++this.operations > 80) throw new Error('Browser operation budget exhausted.');
    return this.page;
  }
  async open(url: string) {
    assertUrl(url, this.settings.allowedHosts);
    if (this.sequence === 0 && url.replace(/\/$/, '') !== DIRECTORY_URL) throw new Error('Open track-trace first.');
    const text = `Attempted browser navigation to ${url}. This is an action record, not shipment evidence.`;
    const attempt: Evidence = { id: randomUUID(), jobId: this.settings.jobId, attempt: this.settings.attempt,
      capturedAt: new Date().toISOString(), url, text, kind: 'navigation_attempt',
      sha256: createHash('sha256').update(text).digest('hex'), screenshot: false, sequence: ++this.sequence };
    await this.save(attempt);
    await this.current().goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    return this.snapshot();
  }
  private async save(evidence: Evidence) {
    await writeFile(join(this.settings.evidenceDir, `${evidence.id}.json`), JSON.stringify({ evidence, signature: signEvidence(evidence, this.settings.signingKey) }), { mode: 0o600 });
  }
  async snapshot(screenshot = false) {
    const page = this.current();
    if (page.url() === 'about:blank') throw new Error('Open the tracking directory first.');
    assertUrl(page.url(), this.settings.allowedHosts);
    this.refs.clear();
    let text = '', controls = '';
    for (const [frameIndex, frame] of page.frames().entries()) {
      try {
        const body = await frame.locator('body').innerText({ timeout: 3000 });
        text += `\n[Frame ${frameIndex}]\n${body.slice(0, 300000)}`;
        const locators = await frame.locator('input:not([type=hidden]),button,a,select,textarea,[role=button],[role=combobox]').all();
        for (let i = 0; i < Math.min(locators.length, 180); i++) {
          const locator = locators[i]!;
          if (!await locator.isVisible().catch(() => false)) continue;
          const info = await locator.evaluate(el => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type'),
            label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().slice(0, 140) || '',
            href: el.getAttribute('href'), value: el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.value : '' }));
          const ref = `${this.sequence + 1}-${frameIndex}-${i}`;
          this.refs.set(ref, locator);
          controls += `\n[${ref}] ${JSON.stringify(info)}`;
        }
      } catch { /* An inaccessible ad frame must not discard the shipment page. */ }
    }
    text = `${await page.title()}\n${text}\nINTERACTIVE ELEMENTS (current input values included):${controls}`.slice(0, 490000);
    const evidence: Evidence = { id: randomUUID(), jobId: this.settings.jobId, attempt: this.settings.attempt,
      capturedAt: new Date().toISOString(), url: page.url(), text, sha256: createHash('sha256').update(text).digest('hex'),
      screenshot: false, sequence: ++this.sequence, kind: 'page' };
    let image: Buffer | undefined;
    if (screenshot) {
      image = await page.screenshot({ fullPage: false, timeout: 5000 });
      await writeFile(join(this.settings.evidenceDir, `${evidence.id}.png`), image, { mode: 0o600 });
      evidence.screenshot = true;
    }
    await this.save(evidence);
    return { evidenceId: evidence.id, url: evidence.url, text: text.slice(0, 65000), truncated: text.length > 65000, image };
  }
  private ref(id: string) { const locator = this.refs.get(id); if (!locator) throw new Error('Stale element reference. Read a new snapshot.'); return locator; }
  async click(ref: string) {
    this.current();
    await this.ref(ref).click({ timeout: 10_000 });
    await this.page!.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    return this.snapshot();
  }
  async fill(ref: string, value: string) {
    this.current();
    const digits = this.settings.mawb.replace('-', '');
    if (![this.settings.mawb, digits, digits.slice(0, 3), digits.slice(3)].includes(value)) {
      throw new Error('Only the current AWB or its prefix/number may be entered.');
    }
    await this.ref(ref).fill(value, { timeout: 5000 });
    return this.snapshot();
  }
  async press(ref: string, key: string) {
    this.current();
    if (!['Enter', 'Tab', 'ArrowDown', 'Escape'].includes(key)) throw new Error('Unsupported key');
    await this.ref(ref).press(key, { timeout: 5000 }); return this.snapshot();
  }
  async select(ref: string, value: string) {
    this.current(); await this.ref(ref).selectOption(value, { timeout: 5000 }); return this.snapshot();
  }
  async wait(text: string) {
    const page = this.current();
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 });
    return this.snapshot();
  }
  async read(start: number) {
    const snapshot = await this.snapshot();
    // Read the complete just-recorded text, without allowing filesystem paths from the model.
    const { readFile } = await import('node:fs/promises');
    const stored = JSON.parse(await readFile(join(this.settings.evidenceDir, `${snapshot.evidenceId}.json`), 'utf8'));
    return { ...snapshot, text: stored.evidence.text.slice(start, start + 60000), truncated: stored.evidence.text.length > start + 60000 };
  }
  async close() {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    await this.proxy?.close().catch(() => undefined);
  }
}
