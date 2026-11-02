import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { z } from 'zod';
import { SCAN_WIDTHS, VIEWPORT_HEIGHT } from './scan-schema.js';
import { validateLocalUrl } from './scan-project.js';

export const REPAIR_CONTENT_LIMITS = { elements: 300, textNodes: 500, textCharacters: 32768, images: 100, paintCharacters: 262144 } as const;
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TextMeasurementSchema = z.object({
  hash: HashSchema, paintHash: HashSchema, characters: z.number().int().positive(), visible: z.boolean(),
  withinViewportX: z.boolean(), unclipped: z.boolean(), fontSize: z.number().finite().nonnegative(),
}).strict();
const ImageMeasurementSchema = z.object({ hash: HashSchema, visible: z.boolean(), withinViewportX: z.boolean(), unclipped: z.boolean() }).strict();
const TargetSchema = z.object({
  fingerprint: HashSchema, elementCount: z.number().int().positive().max(REPAIR_CONTENT_LIMITS.elements),
  visible: z.boolean(), withinViewportX: z.boolean(), width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(),
  text: z.array(TextMeasurementSchema).max(REPAIR_CONTENT_LIMITS.textNodes),
  images: z.array(ImageMeasurementSchema).max(REPAIR_CONTENT_LIMITS.images),
  htmlOverflowX: z.string().max(30), bodyOverflowX: z.string().max(30),
}).strict();
const InteractionSchema = z.object({
  configured: z.boolean(), visible: z.boolean(), enabled: z.boolean(), clickReceived: z.boolean(),
  dialogExpected: z.boolean(), dialogMatched: z.boolean(), passed: z.boolean(),
  networkBlocked: z.boolean(),
}).strict();
const ResultSchema = z.object({
  width: z.number().int().positive(), status: z.enum(['complete', 'failed']), target: TargetSchema.nullable(),
  evidenceBinding: z.object({ required: z.boolean(), matched: z.boolean() }).strict(),
  interaction: InteractionSchema, screenshot: z.string().regex(/^content-screenshots\/(320|375|390|768|1440)\.png$/).nullable(),
  errors: z.array(z.string().max(100)).max(20),
}).strict();
export const RepairContentResultSchema = z.object({ results: z.array(ResultSchema).length(SCAN_WIDTHS.length), errors: z.array(z.string().max(100)).max(20) }).strict()
  .superRefine((value, context) => {
    if (value.results.some((result, index) => result.width !== SCAN_WIDTHS[index])) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repair content viewports must match the Phase 1 order.' });
    if (value.results.some((result) => result.status === 'complete' && (!result.target || !result.screenshot || result.errors.length > 0))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Complete content checks require target, screenshot and no check errors.' });
  });
export type RepairContentResult = z.infer<typeof RepairContentResultSchema>;
export interface RepairContentOptions {
  url: string; outputDirectory: string; targetSelector: string;
  interaction?: { selector: string; expectedDialog?: string };
  evidenceBinding?: { viewportWidth: number; selectors: string[] };
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const emptyInteraction = (): z.infer<typeof InteractionSchema> => ({
  configured: false, visible: false, enabled: false, clickReceived: false, dialogExpected: false, dialogMatched: false, passed: true, networkBlocked: false,
});
const NAVIGATION_MS = 10000;
const MOTION_STYLE = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';

async function ready(page: Page): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) });
      await page.addStyleTag({ content: MOTION_STYLE });
      const fonts = await page.evaluate(async (timeout) => Promise.race([
        document.fonts.ready.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeout)),
      ]), Math.max(1, deadline - Date.now()));
      if (!fonts) throw new Error('READINESS_FAILED');
      await page.waitForTimeout(100);
      await page.evaluate(() => document.getAnimations().forEach((animation) => animation.cancel()));
      if (Date.now() < deadline) return;
    } catch (error) {
      if (!(error instanceof Error) || !/execution context was destroyed|cannot find context with specified id/i.test(error.message)) throw error;
    }
  }
  throw new Error('READINESS_FAILED');
}

async function measureTarget(page: Page, selector: string): Promise<z.infer<typeof TargetSchema>> {
  const measured = await page.evaluate(({ selector, limits }) => {
    const targets = document.querySelectorAll(selector);
    if (targets.length !== 1) throw new Error('TARGET_NOT_UNIQUE');
    const target = targets[0];
    const elements = [target, ...target.querySelectorAll('*')];
    if (elements.length > limits.elements) throw new Error('CONTENT_LIMIT');
    const viewportWidth = document.documentElement.clientWidth;
    const horizontal = (rect: DOMRect): boolean => rect.left >= -1 && rect.right <= viewportWidth + 1;
    const colorAlpha = (value: string): number => {
      const color = value.trim().toLowerCase();
      if (color === 'transparent') return 0;
      // Chromium may serialize alpha using legacy rgba() or modern rgb()/color() slash syntax.
      const alpha = /\/\s*([\d.]+)(%)?\s*\)$/.exec(color)
        ?? /^rgba\([^)]*,\s*([\d.]+)(%)?\s*\)$/.exec(color);
      return alpha ? Number(alpha[1]) / (alpha[2] ? 100 : 1) : 1;
    };
    // This layout-only MVP preserves paint rather than guessing whether a new
    // color, filter, blend or overlay leaves text readable. Raw paint values
    // remain transient browser data; the saved report contains only hashes.
    const paintProperties = ['color', '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
      'background-color', 'background-image', 'filter', 'backdrop-filter', 'mix-blend-mode', 'text-shadow', 'opacity', 'isolation'];
    const styleValues = (style: CSSStyleDeclaration, properties: string[]): string[] => properties.map((property) => {
      const value = style.getPropertyValue(property);
      if (value.length > 2048) throw new Error('CONTENT_LIMIT');
      return value;
    });
    const ancestors: Element[] = [];
    for (let element: Element | null = target.parentElement; element; element = element.parentElement) ancestors.push(element);
    const pseudoPaint: Array<{ element: number; pseudo: string; values: string[] }> = [];
    for (const [index, element] of [...elements, ...ancestors].entries()) {
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (!['none', 'normal'].includes(style.content) && style.display !== 'none') pseudoPaint.push({ element: index, pseudo,
          values: styleValues(style, [...paintProperties, 'content', 'position', 'z-index', 'width', 'height', 'top', 'right', 'bottom', 'left', 'transform', 'clip-path']) });
      }
    }
    const paintDescriptors: string[] = [];
    const paintIndices = new Map<string, number>();
    let paintCharacters = 0;
    const paintIndex = (element: Element): number => {
      const chain: string[][] = [];
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) chain.push(styleValues(getComputedStyle(ancestor), paintProperties));
      const value = JSON.stringify({ chain, pseudoPaint });
      const existing = paintIndices.get(value);
      if (existing !== undefined) return existing;
      paintCharacters += value.length;
      if (paintCharacters > limits.paintCharacters) throw new Error('CONTENT_LIMIT');
      const index = paintDescriptors.length; paintDescriptors.push(value); paintIndices.set(value, index); return index;
    };
    const opaqueRgb = (value: string): number[] | undefined => {
      const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/.exec(value.trim());
      if (!match || (match[4] !== undefined && Number(match[4]) / (match[5] ? 100 : 1) < 0.999)) return undefined;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const zeroContrast = (element: Element, style: CSSStyleDeclaration): boolean => {
      const foreground = opaqueRgb(style.webkitTextFillColor || style.color);
      // Outlines or shadows can make otherwise equal foreground/background
      // colors readable; leave those to the unchanged-paint assertion.
      if (!foreground || style.textShadow !== 'none' || Number.parseFloat(style.webkitTextStrokeWidth) > 0) return false;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const background = getComputedStyle(ancestor);
        if (background.backgroundImage !== 'none') return false;
        if (colorAlpha(background.backgroundColor) === 0) continue;
        const rgb = opaqueRgb(background.backgroundColor);
        return Boolean(rgb && rgb.every((channel, index) => Math.abs(channel - foreground[index]) < 0.1));
      }
      // Transparent computed ancestors do not imply a black canvas.
      return false;
    };
    const paint = (element: Element, rect: DOMRect, textAlpha = 1): boolean => {
      if (rect.width < 1 || rect.height < 1) return false;
      let opacity = textAlpha;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        opacity *= Number(style.opacity);
        for (const filter of style.filter.matchAll(/opacity\(\s*([\d.]+)(%)?\s*\)/g)) opacity *= Number(filter[1]) / (filter[2] ? 100 : 1);
        if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
          || opacity < 0.05 || style.contentVisibility === 'hidden' || style.clipPath !== 'none'
          || (style.clip !== 'auto' && style.clip !== '')) return false;
      }
      return true;
    };
    const unclipped = (element: Element, rect: DOMRect): boolean => {
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor); const boundary = ancestor.getBoundingClientRect();
        if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX)
          && (rect.left < boundary.left - 1 || rect.right > boundary.right + 1)) return false;
        // The viewport's vertical edge is not a clip: content below the fold is allowed.
        if (ancestor !== document.documentElement && ancestor !== document.body
          && ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY)
          && (rect.top < boundary.top - 1 || rect.bottom > boundary.bottom + 1)) return false;
      }
      return true;
    };
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const text: Array<{ value: string; paint: number; characters: number; visible: boolean; withinViewportX: boolean; unclipped: boolean; fontSize: number }> = [];
    let characters = 0; let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.parentElement || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.parentElement.tagName)) continue;
      const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!value) continue;
      characters += value.length;
      if (characters > limits.textCharacters || text.length >= limits.textNodes) throw new Error('CONTENT_LIMIT');
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0.25 && rect.height > 0.25);
      const textStyle = getComputedStyle(node.parentElement);
      const fontSize = Number.parseFloat(textStyle.fontSize) || 0;
      const textAlpha = colorAlpha(textStyle.webkitTextFillColor || textStyle.color);
      text.push({ value, paint: paintIndex(node.parentElement), characters: value.length,
        visible: !zeroContrast(node.parentElement, textStyle) && fontSize > 0 && rects.length > 0 && rects.every((rect) => paint(node!.parentElement!, rect, textAlpha)),
        withinViewportX: rects.length > 0 && rects.every(horizontal), unclipped: rects.length > 0 && rects.every((rect) => unclipped(node!.parentElement!, rect)), fontSize });
    }
    const imageElements = elements.filter((element): element is HTMLImageElement => element instanceof HTMLImageElement);
    if (imageElements.length > limits.images) throw new Error('CONTENT_LIMIT');
    const images = imageElements.map((image) => {
      const rect = image.getBoundingClientRect();
      return { value: `${image.getAttribute('src') ?? ''}\n${image.getAttribute('alt') ?? ''}`, visible: image.complete && image.naturalWidth > 0 && paint(image, rect), withinViewportX: horizontal(rect), unclipped: unclipped(image, rect) };
    });
    const rect = target.getBoundingClientRect();
    return { tagNames: elements.map((element) => element.tagName), elementCount: elements.length, visible: paint(target, rect),
      withinViewportX: horizontal(rect), width: rect.width, height: rect.height, text, images, paintDescriptors,
      htmlOverflowX: getComputedStyle(document.documentElement).overflowX, bodyOverflowX: getComputedStyle(document.body).overflowX };
  }, { selector, limits: REPAIR_CONTENT_LIMITS });
  const { tagNames, text, images, paintDescriptors, ...geometry } = measured;
  return TargetSchema.parse({ ...geometry,
    fingerprint: hash(JSON.stringify({ tags: tagNames, text: text.map((item) => item.value), images: images.map((item) => item.value) })),
    text: text.map(({ value, paint, ...item }) => ({ ...item, hash: hash(value), paintHash: hash(paintDescriptors[paint]) })),
    images: images.map(({ value, ...item }) => ({ ...item, hash: hash(value) })),
  });
}

/** Executes only a developer-specified DOM click. Network is blocked during the click; this is not a purchase/payment assertion. */
async function interactionCheck(page: Page, configured: NonNullable<RepairContentOptions['interaction']>, blockNetwork: () => void): Promise<z.infer<typeof InteractionSchema>> {
  const result = { ...emptyInteraction(), configured: true, passed: false, dialogExpected: configured.expectedDialog !== undefined, networkBlocked: true };
  const locator = page.locator(configured.selector);
  if (await locator.count() !== 1) return result;
  result.visible = await locator.isVisible(); result.enabled = await locator.isEnabled();
  if (!result.visible || !result.enabled) return result;
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
  await locator.evaluate((element) => {
    const state = { received: false };
    Object.defineProperty(element, '__visionfixClickState', { value: state, configurable: true });
    element.addEventListener('click', (event) => { state.received = true; event.preventDefault(); }, { capture: true, once: true });
    // Cancel native form submission even if the application explicitly asks for it.
    document.addEventListener('submit', (event) => { event.preventDefault(); }, { capture: true });
  });
  const dialog = async (observed: import('playwright').Dialog) => {
    if (configured.expectedDialog !== undefined && observed.message() === configured.expectedDialog) result.dialogMatched = true;
    await observed.dismiss().catch(() => undefined);
  };
  page.on('dialog', dialog);
  blockNetwork();
  try {
    await locator.click({ timeout: 3000 });
    await page.waitForTimeout(50);
    result.clickReceived = await locator.evaluate((element) => Boolean((element as Element & { __visionfixClickState?: { received: boolean } }).__visionfixClickState?.received));
    result.passed = result.visible && result.enabled && result.clickReceived && (!result.dialogExpected || result.dialogMatched);
  } catch { /* Failure is recorded as an interaction assertion, without copying page exception text. */ }
  finally { page.off('dialog', dialog); }
  return result;
}

export async function captureRepairContent(options: RepairContentOptions): Promise<RepairContentResult> {
  const targetUrl = validateLocalUrl(options.url);
  if (!options.targetSelector || options.targetSelector.length > 1000
    || (options.interaction && (!options.interaction.selector || options.interaction.selector.length > 1000 || (options.interaction.expectedDialog?.length ?? 0) > 1000))
    || (options.evidenceBinding && (!(SCAN_WIDTHS as readonly number[]).includes(options.evidenceBinding.viewportWidth)
      || options.evidenceBinding.selectors.length < 1 || options.evidenceBinding.selectors.length > 5
      || options.evidenceBinding.selectors.some((selector) => !selector || selector.length > 1000)))) throw new Error('INVALID_REPAIR_CONTENT_OPTIONS');
  const result: RepairContentResult = { results: SCAN_WIDTHS.map((width) => ({ width, status: 'failed', target: null,
    evidenceBinding: { required: options.evidenceBinding?.viewportWidth === width, matched: options.evidenceBinding?.viewportWidth !== width },
    interaction: emptyInteraction(), screenshot: null, errors: [] })), errors: [] };
  let browser: Browser | undefined;
  try {
    await mkdir(path.join(options.outputDirectory, 'content-screenshots'), { recursive: true });
    browser = await chromium.launch({ headless: true, timeout: NAVIGATION_MS });
    for (const viewport of result.results) {
      let context: BrowserContext | undefined; let page: Page | undefined; let guard: CDPSession | undefined; let closing = false; let clickPhase = false;
      const fail = (code: string) => { if (!viewport.errors.includes(code) && viewport.errors.length < 20) viewport.errors.push(code); };
      try {
        context = await browser.newContext({ viewport: { width: viewport.width, height: VIEWPORT_HEIGHT }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce' });
        context.setDefaultTimeout(NAVIGATION_MS);
        await context.route('**/*', async (route) => {
          if (clickPhase) { await route.abort('blockedbyclient').catch(() => undefined); return; }
          const request = route.request();
          if (!['GET', 'HEAD'].includes(request.method())) { fail('UNSUPPORTED_NETWORK_WRITE'); await route.abort('blockedbyclient').catch(() => undefined); return; }
          if (request.isNavigationRequest()) {
            try {
              if (!page || request.frame() !== page.mainFrame()) throw new Error();
              validateLocalUrl(request.url());
            } catch { fail('UNSUPPORTED_NAVIGATION'); await route.abort('blockedbyclient').catch(() => undefined); return; }
          }
          await route.continue().catch(() => undefined);
        });
        // Closing websocket routes before a click avoids an existing socket bypassing request blocking.
        await context.routeWebSocket('**/*', (socket) => socket.close());
        page = await context.newPage();
        page.on('pageerror', () => fail('BROWSER_EXCEPTION'));
        page.on('crash', () => fail('PAGE_CRASH'));
        page.on('console', (message) => { if (!clickPhase && message.type() === 'error') fail('BROWSER_CONSOLE_ERROR'); });
        context.on('page', (additional) => { if (additional !== page) { fail('UNEXPECTED_POPUP'); void additional.close().catch(() => undefined); } });
        guard = await context.newCDPSession(page); const responseGuard = guard;
        guard.on('Fetch.requestPaused', (event) => {
          void (async () => {
            const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === 'location')?.value;
            if (clickPhase) { await responseGuard.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return; }
            if (event.responseStatusCode && event.responseStatusCode >= 300 && event.responseStatusCode < 400 && location) {
              try { validateLocalUrl(new URL(location, event.request.url).href); }
              catch { fail('NON_LOCAL_REDIRECT'); await responseGuard.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); return; }
            }
            await responseGuard.send('Fetch.continueRequest', { requestId: event.requestId });
          })().catch(() => { if (!closing) fail('NAVIGATION_GUARD_FAILED'); });
        });
        await guard.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
        const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_MS });
        if (!response || response.status() >= 400) throw new Error('HTTP_ERROR');
        await ready(page);
        if (viewport.evidenceBinding.required && options.evidenceBinding) {
          viewport.evidenceBinding.matched = await page.evaluate(({ targetSelector, selectors }) => {
            const targets = document.querySelectorAll(targetSelector);
            return targets.length === 1 && selectors.every((selector) => {
              const candidates = document.querySelectorAll(selector);
              return candidates.length === 1 && targets[0].contains(candidates[0]);
            });
          }, { targetSelector: options.targetSelector, selectors: options.evidenceBinding.selectors });
        }
        viewport.target = await measureTarget(page, options.targetSelector);
        viewport.screenshot = `content-screenshots/${viewport.width}.png`;
        await page.screenshot({ path: path.join(options.outputDirectory, viewport.screenshot), fullPage: false, animations: 'disabled', caret: 'hide', scale: 'css', timeout: 10000 });
        if (options.interaction) viewport.interaction = await interactionCheck(page, options.interaction, () => { clickPhase = true; });
        if (!viewport.interaction.passed) fail('INTERACTION_ASSERTION_FAILED');
      } catch { fail('CONTENT_CHECK_FAILED'); viewport.screenshot = null; }
      finally {
        closing = true;
        await guard?.detach().catch(() => undefined);
        await context?.close().catch(() => fail('CONTEXT_CLEANUP_FAILED'));
        viewport.status = viewport.target && viewport.screenshot && viewport.errors.length === 0 ? 'complete' : 'failed';
      }
    }
  } catch { result.errors.push('CONTENT_BROWSER_UNAVAILABLE'); }
  finally { await browser?.close().catch(() => result.errors.push('BROWSER_CLEANUP_FAILED')); }
  return RepairContentResultSchema.parse(result);
}

export function compareRepairContent(baseline: RepairContentResult, after: RepairContentResult): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const beforeParsed = RepairContentResultSchema.safeParse(baseline); const afterParsed = RepairContentResultSchema.safeParse(after);
  if (!beforeParsed.success || !afterParsed.success) return { passed: false, reasons: ['CONTENT_REPORT_INVALID'] };
  if (baseline.errors.length || after.errors.length) reasons.push('CONTENT_BROWSER_CHECK_FAILED');
  for (let index = 0; index < SCAN_WIDTHS.length; index++) {
    const before = baseline.results[index]; const current = after.results[index]; const width = SCAN_WIDTHS[index];
    if (before.evidenceBinding.required !== current.evidenceBinding.required
      || (before.evidenceBinding.required && (!before.evidenceBinding.matched || !current.evidenceBinding.matched))) reasons.push(`${width}:EVIDENCE_TARGET_MISMATCH`);
    if (before.status !== 'complete' || current.status !== 'complete' || !before.target || !current.target) { reasons.push(`${width}:CONTENT_CHECK_INCOMPLETE`); continue; }
    const old = before.target; const next = current.target;
    if (old.fingerprint !== next.fingerprint || old.elementCount !== next.elementCount) reasons.push(`${width}:TARGET_CONTENT_CHANGED`);
    if (next.text.some((item, position) => old.text[position]?.paintHash !== item.paintHash)) reasons.push(`${width}:TARGET_PAINT_CHANGED`);
    if (!next.visible || !next.withinViewportX || next.text.some((item) => !item.visible || !item.withinViewportX || !item.unclipped)
      || next.images.some((item) => !item.visible || !item.withinViewportX || !item.unclipped)) reasons.push(`${width}:TARGET_CONTENT_HIDDEN_OR_CLIPPED`);
    if (next.text.some((item, position) => {
      const previous = old.text[position];
      return previous && (item.fontSize < Math.min(8, previous.fontSize) || item.fontSize < previous.fontSize * 0.65);
    })) reasons.push(`${width}:TARGET_TEXT_SHRUNK`);
    if ((['hidden', 'clip'].includes(next.htmlOverflowX) && next.htmlOverflowX !== old.htmlOverflowX)
      || (['hidden', 'clip'].includes(next.bodyOverflowX) && next.bodyOverflowX !== old.bodyOverflowX)) reasons.push(`${width}:DOCUMENT_OVERFLOW_MASKED`);
    if (before.interaction.configured !== current.interaction.configured || !current.interaction.passed) reasons.push(`${width}:INTERACTION_REGRESSION`);
  }
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
