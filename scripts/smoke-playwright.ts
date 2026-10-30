import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { chromium, type Browser } from 'playwright';

const PORT = 5180;
const TARGET_URL = `http://127.0.0.1:${PORT}`;
const VIEWPORT_WIDTH = 320;
const VIEWPORT_HEIGHT = 640;
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts');
const SCREENSHOT_PATH = path.join(ARTIFACTS_DIR, 'broken-shop-320px.png');

async function waitForServer(url: string, timeoutMs: number = 20000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200 || res.status === 304) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function terminateProcess(proc: ChildProcess): void {
  if (!proc || proc.killed || proc.pid === undefined) return;

  try {
    proc.kill('SIGTERM');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Process already terminated
    }
  }
}

async function runPlaywrightSmokeTest(): Promise<void> {
  console.log('========================================================');
  console.log('   VisionFix AI — Playwright Smoke Test (Phase 0)       ');
  console.log('========================================================\n');

  let fixtureProcess: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    // 1. Ensure artifacts directory exists
    if (!fs.existsSync(ARTIFACTS_DIR)) {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    }

    // 2. Start the broken-shop fixture directly using Vite binary
    console.log(`[1/5] Starting broken-shop fixture on ${TARGET_URL}...`);
    const viteBin = path.resolve(process.cwd(), 'node_modules/vite/bin/vite.js');
    const fixtureCwd = path.resolve(process.cwd(), 'fixtures/broken-shop');

    fixtureProcess = spawn(
      process.execPath,
      [viteBin, '--host', '127.0.0.1', '--port', PORT.toString()],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: fixtureCwd,
      }
    );

    fixtureProcess.stderr?.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error(`[Fixture Error]: ${msg}`);
      }
    });

    // 3. Wait for Vite server readiness
    console.log(`[2/5] Waiting for fixture readiness at ${TARGET_URL}...`);
    const isReady = await waitForServer(TARGET_URL, 20000);
    if (!isReady) {
      throw new Error(`Fixture server did not respond at ${TARGET_URL} within 20 seconds.`);
    }
    console.log(`✓ Fixture is online at ${TARGET_URL}`);

    // 4. Launch Playwright Chromium
    console.log(`[3/5] Launching headless Chromium with viewport ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}...`);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });
    const page = await context.newPage();

    await page.goto(TARGET_URL, { waitUntil: 'networkidle' });

    // 5. Inspect viewport width and document scroll width
    console.log('[4/5] Measuring document metrics...');
    const metrics = await page.evaluate(() => {
      const clientWidth = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      const bodyScrollWidth = document.body.scrollWidth;
      return {
        clientWidth,
        scrollWidth: Math.max(scrollWidth, bodyScrollWidth),
      };
    });

    console.log(`      Viewport width (clientWidth):  ${metrics.clientWidth}px`);
    console.log(`      Document scroll width:         ${metrics.scrollWidth}px`);

    // Deterministic assertion
    const isOverflowing = metrics.scrollWidth > metrics.clientWidth;
    const overflowDiff = metrics.scrollWidth - metrics.clientWidth;

    console.log(`      Horizontal overflow detected:  ${overflowDiff}px`);

    if (!isOverflowing) {
      throw new Error(
        `Assertion FAILED: Expected document scrollWidth (${metrics.scrollWidth}px) to exceed clientWidth (${metrics.clientWidth}px), but no overflow was observed.`
      );
    }

    if (metrics.scrollWidth < 480) {
      throw new Error(
        `Assertion FAILED: Expected scrollWidth to be at least 480px due to fixed width defect, but got ${metrics.scrollWidth}px.`
      );
    }

    console.log('✓ Deterministic overflow assertion PASSED.');

    // 6. Capture screenshot
    console.log(`[5/5] Saving screenshot evidence to ${SCREENSHOT_PATH}...`);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    console.log(`✓ Screenshot successfully saved (${fs.statSync(SCREENSHOT_PATH).size} bytes).`);

    console.log('\n========================================================');
    console.log('   Playwright Smoke Test Result: PASSED                 ');
    console.log('========================================================\n');
  } catch (error: unknown) {
    console.error('\n❌ Playwright Smoke Test FAILED:');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  } finally {
    // Teardown browser
    if (browser) {
      console.log('Closing Chromium browser...');
      await browser.close().catch(() => {});
    }
    // Teardown fixture process
    if (fixtureProcess) {
      console.log('Terminating fixture process...');
      terminateProcess(fixtureProcess);
    }
  }
}

runPlaywrightSmokeTest();
