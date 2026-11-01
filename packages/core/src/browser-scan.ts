import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { inspectOverflow } from './overflow.js';
import { validateLocalUrl } from './scan-project.js';
import {
  SCAN_WIDTHS,
  VIEWPORT_HEIGHT,
  type ScanError,
  type ViewportResult,
} from './scan-schema.js';

const NAVIGATION_TIMEOUT_MS = 10_000;
const READINESS_TIMEOUT_MS = 5_000;
const SCREENSHOT_TIMEOUT_MS = 10_000;
const MOTION_STYLE = '*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }';

class ScanStepError extends Error {
  constructor(readonly code: string, readonly stage: ScanError['stage'], message: string) {
    super(message);
  }
}

function emptyResult(width: number): ViewportResult {
  return {
    viewport: { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 },
    status: 'failed', document: null, candidates: [], candidatesTruncated: false,
    screenshot: null, errors: [],
  };
}

async function waitForReadiness(page: Page): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      try {
        page.setDefaultTimeout(Math.max(1, deadline - Date.now()));
        await page.waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) });
        // Reapply after any development-server reload replaces the document.
        await page.addStyleTag({ content: MOTION_STYLE });
        const fontsReady = await page.evaluate(async (timeoutMs) => Promise.race([
          document.fonts.ready.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]), Math.max(1, deadline - Date.now()));
        if (!fontsReady || deadline - Date.now() < 100) break;
        // A bounded settle period covers initial React effects without networkidle.
        await page.waitForTimeout(100);
        await page.evaluate(() => document.getAnimations().forEach((animation) => animation.cancel()));
        if (Date.now() < deadline) return;
      } catch (error) {
        const transientNavigation = error instanceof Error
          && /execution context was destroyed|cannot find context with specified id/i.test(error.message);
        // Only retry the recognized context replacement caused by navigation.
        // Font timeouts, CSP errors, page closure and browser errors stay failures.
        if (!transientNavigation || page.isClosed() || Date.now() >= deadline) throw error;
        await page.waitForTimeout(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
    throw new Error('Readiness budget expired');
  } catch {
    throw new ScanStepError('READINESS_FAILED', 'readiness', 'Page or font readiness failed within the 5 second readiness budget.');
  } finally {
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
  }
}

/** Does not read a project, execute scripts, load credentials, or start a server. */
export async function scanBrowser(targetUrl: string, reportDirectory: string): Promise<{
  results: ViewportResult[];
  errors: ScanError[];
}> {
  const results = SCAN_WIDTHS.map(emptyResult);
  const errors: ScanError[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: NAVIGATION_TIMEOUT_MS });
    await mkdir(path.join(reportDirectory, 'screenshots'), { recursive: true });
    for (const result of results) {
      const width = result.viewport.width;
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      let responseGuard: CDPSession | undefined;
      let closing = false;
      const addError = (code: string, stage: ScanError['stage'], message: string): void => {
        // One bounded error per category; arbitrary browser strings may contain private data.
        if (!result.errors.some((error) => error.code === code) && result.errors.length < 20) {
          result.errors.push({ code, stage, message, viewportWidth: width });
        }
      };
      try {
        context = await browser.newContext({
          viewport: { width, height: VIEWPORT_HEIGHT }, deviceScaleFactor: 1,
          serviceWorkers: 'block', acceptDownloads: false,
          reducedMotion: 'reduce',
        });
        context.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
        // Only the primary document is supported. Fail closed on navigated
        // frames/popups, whose separate renderer targets need their own guard.
        // Routing guards initial navigations and newly opened pages. Chromium
        // follows HTTP redirects without invoking Playwright routing again, so
        // a response-stage CDP guard below validates every redirect Location.
        // Subresources remain unrestricted: this policy is not a sandbox.
        await context.route('**/*', async (route) => {
          if (route.request().isNavigationRequest()) {
            try {
              const frame = route.request().frame();
              if (!page || frame !== page.mainFrame()) {
                const popup = page && frame.page() !== page;
                addError(popup ? 'UNEXPECTED_POPUP' : 'NESTED_NAVIGATION_UNSUPPORTED', 'navigation',
                  popup ? 'Additional page navigation is unsupported and was blocked.' : 'Nested document navigation is unsupported and was blocked.');
                await route.abort('blockedbyclient').catch(() => {});
                return;
              }
            } catch {
              addError('UNSUPPORTED_NAVIGATION', 'navigation', 'Could not identify navigation as the primary document; request blocked.');
              await route.abort('blockedbyclient').catch(() => {});
              return;
            }
            try {
              validateLocalUrl(route.request().url());
            } catch {
              addError('NON_LOCAL_NAVIGATION', 'navigation', 'Blocked navigation outside the allowed local HTTP hosts.');
              await route.abort('blockedbyclient').catch(() => {});
              return;
            }
          }
          await route.continue().catch(() => {});
        });
        context.on('page', (observedPage) => {
          observedPage.on('pageerror', () => addError('BROWSER_EXCEPTION', 'browser', 'Uncaught browser exception; page text omitted for privacy.'));
          observedPage.on('console', (message) => {
            if (message.type() === 'error') addError('BROWSER_CONSOLE_ERROR', 'browser', 'Browser logged an error; page text omitted for privacy.');
          });
          observedPage.on('crash', () => addError('PAGE_CRASH', 'browser', 'Browser page crashed.'));
          observedPage.on('framenavigated', (frame) => {
            if (frame.url() === 'about:blank' || frame.url() === 'about:srcdoc') return;
            try { validateLocalUrl(frame.url()); }
            catch { addError('NON_LOCAL_NAVIGATION', 'navigation', 'Detected navigation outside the allowed local HTTP hosts.'); }
          });
          if (page && observedPage !== page) {
            addError('UNEXPECTED_POPUP', 'browser', 'Target opened an additional page.');
            void observedPage.close().catch(() => {});
          }
        });
        page = await context.newPage();
        responseGuard = await context.newCDPSession(page);
        const guard = responseGuard;
        guard.on('Fetch.requestPaused', (event) => {
          void (async () => {
            const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === 'location')?.value;
            if (event.responseStatusCode && event.responseStatusCode >= 300
              && event.responseStatusCode < 400 && location) {
              try {
                validateLocalUrl(new URL(location, event.request.url).href);
              } catch {
                addError('NON_LOCAL_NAVIGATION', 'navigation', 'Blocked redirect outside the allowed local HTTP hosts.');
                await guard.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
                return;
              }
            }
            await guard.send('Fetch.continueRequest', { requestId: event.requestId });
          })().catch(() => {
            if (!closing) addError('NAVIGATION_GUARD_FAILED', 'navigation', 'Could not enforce local navigation redirect checks.');
          });
        });
        await guard.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
        let response;
        try {
          response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        } catch {
          throw new ScanStepError('NAVIGATION_FAILED', 'navigation', 'Target navigation failed or exceeded the 10 second timeout. Check that the local application is running.');
        }
        if (!response || response.status() >= 400) {
          throw new ScanStepError('HTTP_ERROR', 'navigation', `Target did not return a successful document${response ? ` (HTTP ${response.status()})` : ''}.`);
        }
        await waitForReadiness(page);
        try {
          const inspection = await inspectOverflow(page);
          result.document = inspection.document;
          result.candidates = inspection.candidates;
          result.candidatesTruncated = inspection.candidatesTruncated;
        } catch {
          throw new ScanStepError('MEASUREMENT_FAILED', 'measurement', 'Could not measure document and element geometry.');
        }
        try {
          const relativePath = `screenshots/${width}.png`;
          await page.screenshot({
            path: path.join(reportDirectory, relativePath), fullPage: false,
            animations: 'disabled', caret: 'hide', scale: 'css', timeout: SCREENSHOT_TIMEOUT_MS,
          });
          result.screenshot = { path: relativePath, width, height: VIEWPORT_HEIGHT, capture: 'viewport' };
        } catch {
          throw new ScanStepError('SCREENSHOT_FAILED', 'screenshot', 'Viewport screenshot failed or exceeded the 10 second timeout.');
        }
      } catch (error) {
        if (error instanceof ScanStepError) addError(error.code, error.stage, error.message);
        else addError('VIEWPORT_FAILED', 'browser', 'Could not complete this viewport scan.');
      } finally {
        closing = true;
        if (context) {
          for (const openPage of context.pages()) {
            await openPage.close().catch(() => addError('PAGE_CLEANUP_FAILED', 'cleanup', 'Could not close a browser page.'));
          }
          // Closing the page normally detaches CDP first; detach is idempotent here.
          if (responseGuard) await responseGuard.detach().catch(() => {});
          await context.close().catch(() => addError('CONTEXT_CLEANUP_FAILED', 'cleanup', 'Could not close the browser context.'));
        }
        result.status = result.document && result.screenshot && result.errors.length === 0 ? 'complete' : 'failed';
      }
    }
  } catch {
    errors.push({ code: 'BROWSER_START_FAILED', stage: 'browser', message: 'Could not initialize Chromium or screenshot output. Run npx playwright install chromium and verify output permissions.' });
    for (const result of results) {
      if (result.status === 'failed' && result.errors.length === 0) {
        result.errors.push({ code: 'BROWSER_UNAVAILABLE', stage: 'browser', message: 'Viewport could not run because Chromium or its output directory was unavailable.', viewportWidth: result.viewport.width });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => errors.push({ code: 'BROWSER_CLEANUP_FAILED', stage: 'cleanup', message: 'Could not close Chromium.' }));
  }
  return { results, errors };
}
