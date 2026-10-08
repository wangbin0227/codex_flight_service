import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIRECTORY_URL, type Evidence } from '../domain.js';
import { signEvidence } from '../evidence.js';
import { assertUrl, startProxy, upgradeToHttps } from './proxy.js';
import { CAPTCHA_SELECTOR, CaptchaController, captchaRole, describeElementsInPage, type CaptchaAction } from './captcha.js';
import { DEFAULT_TIMEOUTS, type Timeouts } from '../timeouts.js';

const CONTROL_SELECTOR = `input:not([type=hidden]),button,a,select,textarea,[role=button],[role=combobox],${CAPTCHA_SELECTOR}`;
export interface WaitCondition { text: string; state?: 'visible' | 'hidden' }

export interface BrowserSettings {
  jobId: string; attempt: number; mawb: string; evidenceDir: string; signingKey: string;
  executablePath?: string; timeouts?: Timeouts;
}
export class BrowserSession {
  private browser?: Browser; private context?: BrowserContext; private page?: Page;
  private proxy?: Awaited<ReturnType<typeof startProxy>>;
  private refs = new Map<string, Locator>(); private sequence = 0; private operations = 0;
  private captcha = new CaptchaController();
  private busy = false; private closed = false; private closing?: Promise<void>;
  private get timeouts() { return this.settings.timeouts ?? DEFAULT_TIMEOUTS; }
  get isClosed() { return this.closed; }
  constructor(readonly settings: BrowserSettings) {}
  async start() {
    this.proxy = await startProxy(this.timeouts.proxyIdleMs);
    this.browser = await chromium.launch({ headless: true, executablePath: this.settings.executablePath,
      timeout: this.timeouts.browserLaunchMs,
      proxy: { server: this.proxy.url }, args: ['--disable-quic', '--proxy-bypass-list=<-loopback>'],
      env: { PATH: process.env.PATH ?? '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    });
    this.context = await this.browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1440, height: 1100 } });
    await this.context.route('**/*', async route => {
      try {
        // Navigation and resources share the same public HTTPS policy. In
        // particular, a popup's first request does not require a Frame yet.
        const destination = upgradeToHttps(route.request().url());
        if (destination.href !== route.request().url()) {
          await route.fulfill({ status: 307, headers: { Location: destination.href, 'Cache-Control': 'no-store' }, body: '' });
        } else await route.continue();
      }
      catch { await route.abort('blockedbyclient'); }
    });
    this.page = await this.context.newPage();
    this.context.on('page', page => { this.page = page; this.refs.clear(); this.captcha.reset(); page.on('dialog', d => void d.dismiss()); });
    this.page.on('dialog', d => void d.dismiss());
    await mkdir(this.settings.evidenceDir, { recursive: true, mode: 0o700 });
  }
  private current(): Page {
    this.assertActive();
    if (!this.page || ++this.operations > 80) throw new Error('Browser operation budget exhausted.');
    return this.page;
  }
  private assertActive() { if (this.closed) throw new Error('Browser session closed after cancellation or timeout.'); }
  private async deadline<T>(ms: number, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertActive();
    let timer: NodeJS.Timeout | undefined;
    let cancel: () => void = () => {};
    const expired = new Promise<never>((_, reject) => {
      const stop = (message: string) => { void this.close(); reject(new Error(message)); };
      cancel = () => stop('Browser session closed after cancellation.');
      timer = setTimeout(() => stop(`Timeout ${ms}ms exceeded; browser session closed.`), ms);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    try {
      return await Promise.race([expired, Promise.resolve().then(() => { this.assertActive(); return operation(); })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  async runTool<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.busy) throw new Error('Browser operation already in progress; wait before retrying.');
    this.busy = true;
    try { return await this.deadline(this.timeouts.mcpToolMs - 5000, operation, signal); }
    finally { this.busy = false; }
  }
  async open(url: string) {
    this.captcha.reset(); this.refs.clear();
    url = upgradeToHttps(url).href;
    if (this.sequence === 0 && url.replace(/\/$/, '') !== DIRECTORY_URL) throw new Error('Open track-trace first.');
    const text = `Attempted browser navigation to ${url}. This is an action record, not shipment evidence.`;
    const attempt: Evidence = { id: randomUUID(), jobId: this.settings.jobId, attempt: this.settings.attempt,
      capturedAt: new Date().toISOString(), url, text, kind: 'navigation_attempt',
      sha256: createHash('sha256').update(text).digest('hex'), screenshot: false, sequence: ++this.sequence };
    await this.save(attempt);
    await this.current().goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
    return this.snapshot();
  }
  private async save(evidence: Evidence) {
    this.assertActive();
    await writeFile(join(this.settings.evidenceDir, `${evidence.id}.json`), JSON.stringify({ evidence, signature: signEvidence(evidence, this.settings.signingKey) }), { mode: 0o600 });
  }
  async snapshot(screenshot = false) {
    return this.deadline(this.timeouts.snapshotMs, () => this.capture(screenshot));
  }
  private async capture(screenshot: boolean) {
    const page = this.current();
    if (page.url() === 'about:blank') throw new Error('Open the tracking directory first.');
    assertUrl(page.url());
    this.refs.clear(); this.captcha.reset();
    let text = '', controls = '', title = '';
    const refs = new Map<string, Locator>();
    for (const [frameIndex, frame] of page.frames().entries()) {
      this.assertActive();
      try {
        // Two batch reads per frame, preserving Playwright's shadow-DOM locator order.
        const data = await frame.locator('body').evaluate(body => ({
          text: (body as HTMLElement).innerText.slice(0, 300000), title: body.ownerDocument.title,
        }), undefined, { timeout: 3000 });
        this.assertActive();
        const elements = await frame.locator(CONTROL_SELECTOR).evaluateAll(describeElementsInPage);
        this.assertActive();
        if (frame === page.mainFrame()) title = data.title;
        text += `\n[Frame ${frameIndex}]\n${data.text}`;
        for (const { index, description, href, value, visible } of elements) {
          if (!visible) continue;
          const role = captchaRole(description);
          if (!role && ['img', 'canvas', 'iframe'].includes(description.tag)) continue;
          const ref = `${this.sequence + 1}-${frameIndex}-${index}`;
          const locator = frame.locator(CONTROL_SELECTOR).nth(index);
          refs.set(ref, locator);
          if (role) this.captcha.add(ref, locator, frameIndex, role);
          controls += `\n[${ref}] ${JSON.stringify({ tag: description.tag, type: description.type, label: description.label,
            href, value, ...(role ? { captcha: role } : {}) })}`;
        }
      } catch (error) {
        this.assertActive();
        // A missing main document must not look like a successful empty shipment page.
        if (frame === page.mainFrame()) throw error;
      }
    }
    this.assertActive();
    text = `${title}\n${text}\nINTERACTIVE ELEMENTS (current input values included):${controls}`.slice(0, 490000);
    const evidence: Evidence = { id: randomUUID(), jobId: this.settings.jobId, attempt: this.settings.attempt,
      capturedAt: new Date().toISOString(), url: page.url(), text, sha256: createHash('sha256').update(text).digest('hex'),
      screenshot: false, sequence: ++this.sequence, kind: 'page' };
    let image: Buffer | undefined;
    if (screenshot) {
      image = await page.screenshot({ fullPage: false, timeout: 5000 });
      this.assertActive();
      await writeFile(join(this.settings.evidenceDir, `${evidence.id}.png`), image, { mode: 0o600 });
      evidence.screenshot = true;
    }
    await this.save(evidence);
    this.assertActive(); this.refs = refs;
    return { evidenceId: evidence.id, url: evidence.url, text: text.slice(0, 65000), truncated: text.length > 65000, image };
  }
  private ref(id: string) { const locator = this.refs.get(id); if (!locator) throw new Error('Stale element reference. Read a new snapshot.'); return locator; }
  private async actionSnapshot(action: () => Promise<void>, waitFor?: WaitCondition, newPage = false) {
    const source = this.current(); this.captcha.reset();
    // Navigation and any result wait share the action budget used by readTimeouts,
    // leaving the configured snapshot budget inside the outer MCP deadline.
    const actionDeadline = Date.now() + Math.max(this.timeouts.navigationMs, 20_000 + (waitFor ? this.timeouts.waitMs : 0));
    const remaining = () => Math.max(1, actionDeadline - Date.now());
    // Listen before the action: Track direct opens its popup after an AJAX response.
    const [popup] = await Promise.all([
      newPage ? source.waitForEvent('popup', { timeout: Math.min(this.timeouts.navigationMs, remaining()) }) : undefined,
      action(),
    ]);
    if (popup) {
      this.page = popup;
      // Some sites open about:blank first, then navigate it asynchronously.
      await popup.waitForURL(url => url.protocol !== 'about:', { waitUntil: 'domcontentloaded', timeout: remaining() });
    } else {
      await this.page!.waitForLoadState('domcontentloaded', { timeout: 10_000 });
    }
    if (waitFor) await this.waitForCondition(waitFor, Math.min(this.timeouts.waitMs, remaining()));
    return this.snapshot();
  }
  async click(ref: string, waitFor?: WaitCondition, newPage = false) {
    const locator = this.ref(ref);
    return this.actionSnapshot(() => locator.click({ timeout: 10_000 }), waitFor, newPage);
  }
  async fill(ref: string, value: string) {
    this.current(); this.captcha.reset();
    const digits = this.settings.mawb.replace('-', '');
    if (![this.settings.mawb, digits, digits.slice(0, 3), digits.slice(3)].includes(value)) {
      throw new Error('Only the current AWB or its prefix/number may be entered.');
    }
    await this.ref(ref).fill(value, { timeout: 5000 });
    return this.snapshot();
  }
  async press(ref: string, key: string, waitFor?: WaitCondition, newPage = false) {
    if (!['Enter', 'Tab', 'ArrowDown', 'Escape'].includes(key)) throw new Error('Unsupported key');
    const locator = this.ref(ref);
    return this.actionSnapshot(() => locator.press(key, { timeout: 5000 }), waitFor, newPage);
  }
  async select(ref: string, value: string) {
    this.current(); this.captcha.reset(); await this.ref(ref).selectOption(value, { timeout: 5000 }); return this.snapshot();
  }
  private async waitForCondition(condition: WaitCondition, timeout = this.timeouts.waitMs) {
    const page = this.current(); this.captcha.reset();
    const matches = page.getByText(condition.text, { exact: false });
    // Filtering visible matches also handles duplicated hidden templates.
    await matches.filter({ visible: true }).first().waitFor({ state: condition.state ?? 'visible', timeout });
  }
  async wait(text: string, state: 'visible' | 'hidden' = 'visible') {
    await this.waitForCondition({ text, state });
    return this.snapshot();
  }
  async read(start: number) {
    const snapshot = await this.snapshot();
    // Read the complete just-recorded text, without allowing filesystem paths from the model.
    const { readFile } = await import('node:fs/promises');
    const stored = JSON.parse(await readFile(join(this.settings.evidenceDir, `${snapshot.evidenceId}.json`), 'utf8'));
    return { ...snapshot, text: stored.evidence.text.slice(start, start + 60000), truncated: stored.evidence.text.length > start + 60000 };
  }
  async captchaInspect(ref: string) {
    const page = this.current();
    assertUrl(page.url());
    const capture = await this.captcha.inspect(page, ref);
    this.assertActive();
    const { image, ...metadata } = capture;
    const text = `CAPTCHA inspection only; not shipment evidence. ${JSON.stringify(metadata)} Image SHA256: ${createHash('sha256').update(image).digest('hex')}`;
    const evidence: Evidence = { id: randomUUID(), jobId: this.settings.jobId, attempt: this.settings.attempt,
      capturedAt: new Date().toISOString(), url: page.url(), text, kind: 'captcha',
      sha256: createHash('sha256').update(text).digest('hex'), screenshot: true, sequence: ++this.sequence };
    await writeFile(join(this.settings.evidenceDir, `${evidence.id}.png`), image, { mode: 0o600 });
    await this.save(evidence);
    return { ...capture, evidenceId: evidence.id, url: page.url(), text, truncated: false };
  }
  async captchaAct(challengeId: string, action: CaptchaAction) {
    const page = this.current();
    assertUrl(page.url());
    await this.captcha.act(page, challengeId, action);
    return this.snapshot(true);
  }
  close(): Promise<void> {
    this.closed = true; this.refs.clear(); this.captcha.reset();
    return this.closing ??= Promise.allSettled([this.browser?.close(), this.proxy?.close()]).then(() => {});
  }
}
