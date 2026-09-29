import { randomUUID, createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import { z } from 'zod';

const point = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict();
export const captchaActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fill'), ref: z.string(), value: z.string().min(1).max(16) }).strict(),
  z.object({ type: z.literal('click'), point }).strict(),
  z.object({ type: z.literal('drag'), from: point, to: point }).strict(),
]);
export type CaptchaAction = z.infer<typeof captchaActionSchema>;
export interface ElementInfo {
  tag: string; type: string; label: string; identity: string; context: string; autocomplete: string;
}
export function captchaRole(info: ElementInfo): 'input' | 'region' | undefined {
  const own = `${info.identity} ${info.label}`;
  if (/password|one.?time|\botp\b|\btotp\b|sms|e-?mail|phone|mobile|短信|手机|邮箱|动态口令/i.test(`${own} ${info.type} ${info.autocomplete} ${info.context}`)) return;
  const marker = /captcha|geetest|yidun|turnstile|verify|verification|vcode|check.?code|验证码|图形校验|滑动验证|安全验证/i;
  if (info.tag === 'input') return ['text', 'tel', 'number', ''].includes(info.type) && marker.test(own) ? 'input' : undefined;
  if (!['textarea', 'select', 'a', 'button'].includes(info.tag) && marker.test(`${own} ${info.context}`)) return 'region';
}
export function assertCaptchaText(value: string) {
  // Visual text/math answers only; never an unrestricted input channel.
  if (!/^[\p{L}\p{N}+-]{1,16}$/u.test(value)) throw new Error('CAPTCHA answer must be 1–16 letters, digits or +/- signs.');
}
export function assertPoint(p: { x: number; y: number }, width: number, height: number) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) {
    throw new Error('CAPTCHA coordinates must be inside the inspected image.');
  }
}
export class CaptchaBudget {
  private used = { inspect: 0, fill: 0, click: 0, drag: 0 };
  readonly limits = { inspect: 24, fill: 3, click: 12, drag: 3 };
  take(kind: keyof CaptchaBudget['limits']) {
    if (this.used[kind] >= this.limits[kind]) throw new Error(`CAPTCHA ${kind} budget exhausted. Try another official entrance or report captcha_unsolved.`);
    this.used[kind]++;
  }
}
type Candidate = { locator: Locator; frame: number; role: 'input' | 'region' };
type Rect = { x: number; y: number; width: number; height: number };
const digest = (image: Buffer) => createHash('sha256').update(image).digest('hex');
const shot = (locator: Locator) => locator.screenshot({ timeout: 5000, animations: 'disabled', caret: 'hide', scale: 'css' });

// No CSS selectors, JS, cookies, provider tokens or arbitrary page coordinates are accepted from the model.
export class CaptchaController {
  private candidates = new Map<string, Candidate>();
  private active?: { id: string; page: Page; url: string; region: Candidate; box: Rect; hash: string; inputs: Map<string, Candidate>; expires: number };
  readonly budget = new CaptchaBudget();
  reset() { this.candidates.clear(); this.active = undefined; }
  add(ref: string, locator: Locator, frame: number, role: 'input' | 'region') { this.candidates.set(ref, { locator, frame, role }); }
  async inspect(page: Page, ref: string) {
    this.active = undefined;
    this.budget.take('inspect');
    const region = this.candidates.get(ref);
    if (!region || region.role !== 'region') throw new Error('CAPTCHA region reference required. Read a new snapshot.');
    await region.locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    const box = await region.locator.boundingBox();
    if (!box || box.width < 10 || box.height < 10 || box.width > 1200 || box.height > 850 || box.width * box.height > 650000) {
      throw new Error('CAPTCHA region is too large or not visible. Choose the image or a smaller widget reference.');
    }
    const inputs = new Map<string, Candidate>();
    for (const [id, candidate] of this.candidates) {
      if (candidate.frame !== region.frame || candidate.role !== 'input') continue;
      const b = await candidate.locator.boundingBox();
      if (b && Math.max(box.x - b.x - b.width, b.x - box.x - box.width, box.y - b.y - b.height, b.y - box.y - box.height) <= 400) inputs.set(id, candidate);
    }
    const image = await shot(region.locator);
    // PNG header dimensions are the exact CSS-pixel coordinate space sent to the model.
    const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
    const id = randomUUID();
    this.active = { id, page, url: page.url(), region, box, hash: digest(image), inputs, expires: Date.now() + 90_000 };
    return { challengeId: id, image, width, height, inputRefs: [...inputs.keys()],
      instructions: 'Coordinates are CSS pixels relative to THIS cropped image. Token permits one action, expires after 90 seconds, and becomes stale after any snapshot/navigation/action. Inspect again after each action. A disappearing widget is not shipment evidence.' };
  }
  async act(page: Page, challengeId: string, raw: CaptchaAction) {
    const active = this.active;
    this.active = undefined; // Single-use, including rejected actions.
    if (!active || active.id !== challengeId || active.page !== page || active.url !== page.url() || Date.now() > active.expires) {
      throw new Error('CAPTCHA challenge is stale. Inspect again.');
    }
    const action = captchaActionSchema.parse(raw);
    const box = await active.region.locator.boundingBox();
    if (!box || (['x', 'y', 'width', 'height'] as const).some(k => Math.abs(box[k] - active.box[k]) > 1)
      || digest(await shot(active.region.locator)) !== active.hash) throw new Error('CAPTCHA image changed. Inspect again.');
    if (action.type === 'fill') {
      assertCaptchaText(action.value);
      const input = active.inputs.get(action.ref);
      if (!input || captchaRole(await describeElement(input.locator)) !== 'input') throw new Error('CAPTCHA input reference is not an approved visual verification field.');
      this.budget.take('fill');
      await input.locator.fill(action.value, { timeout: 5000 });
    } else {
      const points = action.type === 'click' ? [action.point] : [action.from, action.to];
      for (const p of points) assertPoint(p, box.width, box.height);
      this.budget.take(action.type);
      // Actionability checks reject overlays; the actual pointer coordinates use the screenshot's
      // border-box origin rather than Locator.click's padding-box origin.
      const start = action.type === 'click' ? action.point : action.from;
      const border = await active.region.locator.evaluate(el => ({ x: el.clientLeft, y: el.clientTop }));
      await active.region.locator.click({ position: { x: Math.max(0, start.x - border.x), y: Math.max(0, start.y - border.y) }, trial: true, timeout: 5000 });
      const latest = await active.region.locator.boundingBox();
      if (!latest || Math.abs(latest.x - box.x) > 1 || Math.abs(latest.y - box.y) > 1) throw new Error('CAPTCHA region moved. Inspect again.');
      if (action.type === 'click') await page.mouse.click(box.x + action.point.x, box.y + action.point.y);
      else {
        await page.mouse.move(box.x + action.from.x, box.y + action.from.y);
        await page.mouse.down();
        try {
          for (let step = 1; step <= 20; step++) {
            await page.mouse.move(box.x + action.from.x + (action.to.x - action.from.x) * step / 20,
              box.y + action.from.y + (action.to.y - action.from.y) * step / 20);
            await page.waitForTimeout(15);
          }
        }
        finally { await page.mouse.up(); }
      }
    }
    return action.type;
  }
}

export async function describeElement(locator: Locator): Promise<ElementInfo> {
  return (await locator.evaluate(describeElementsInPage))[0]!.description;
}

// Self-contained page function shared by batch discovery and action-time checks.
// Preserve locator ordering (including shadow DOM) so returned indexes remain actionable.
export function describeElementsInPage(input: Element | Element[]) {
  const elements = Array.isArray(input) ? input : [input];
  return elements.slice(0, 360).map((el, index) => {
    const attributes = (node: Element) => ['id', 'class', 'name', 'alt', 'title', 'aria-label', 'placeholder', 'src']
      .map(a => node.getAttribute(a) ?? '').join(' ').slice(0, 1800);
    let context = '', parent = el.parentElement;
    for (let depth = 0; parent && depth < 3 && !['BODY', 'HTML'].includes(parent.tagName); depth++, parent = parent.parentElement) context += ` ${attributes(parent)}`;
    const form = el.closest('form');
    if (form?.querySelector('input[type=password],input[autocomplete=one-time-code]')) context += ' password';
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || (el instanceof HTMLInputElement ? [...(el.labels ?? [])].map(l => l.textContent).join(' ') : '') || el.textContent?.trim().slice(0, 140) || '';
    const description: ElementInfo = { tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') ?? '').toLowerCase(), label: label.slice(0, 140),
      identity: attributes(el), context, autocomplete: el.getAttribute('autocomplete') ?? '' };
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    return { index, description, href: el.getAttribute('href'),
      value: el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.value : '',
      visible: style.visibility !== 'hidden' && style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0 };
  });
}

export const CAPTCHA_SELECTOR = ['img', 'canvas', 'iframe', '[role=slider]', '[onclick]',
  ...['captcha', 'verify', 'verification', 'geetest', 'yidun', 'turnstile', 'vcode'].flatMap(s => [`[id*="${s}" i]`, `[class*="${s}" i]`])].join(',');
