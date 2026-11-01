import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { scanProject } from '../packages/core/dist/scan.js';
import { validateLocalUrl, validateProject } from '../packages/core/dist/scan-project.js';
import { inspectOverflow } from '../packages/core/dist/overflow.js';
import { SCAN_WIDTHS, ScanReportSchema, ViewportResultSchema, ScreenshotPathSchema, type ScanReport } from '../packages/core/dist/scan-schema.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const healthyPath = path.join(root, 'tests', 'healthy.html');
let runDirectory: string;
let project: string;
let server: Server;
let forbiddenServer: Server;
let forbiddenUrl: string;
let forbiddenRequests = 0;
let vite: ViteDevServer;
let targetUrl: string;
let brokenUrl: string;
let unreachableUrl: string;
const pageShell = (contents: string, css = '') => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0}${css}</style></head><body>${contents}</body></html>`;

before(async () => {
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  runDirectory = await mkdtemp(path.join(root, 'artifacts', 'phase1-tests-'));
  project = path.join(runDirectory, 'target-project');
  await mkdir(project);
  await writeFile(path.join(project, 'package.json'), JSON.stringify({
    private: true, dependencies: { react: '^18.0.0' }, devDependencies: { vite: '^6.0.0' },
    scripts: { dev: 'THIS_SCRIPT_MUST_NEVER_BE_EXECUTED', build: 'THIS_SCRIPT_MUST_NEVER_BE_EXECUTED' },
  }));
  await writeFile(path.join(project, 'source.tsx'), '/* Source preservation sentinel: the scanner must not open or change this file. */');
  const healthyHtml = await readFile(healthyPath, 'utf8');
  // Observe forbidden redirects entirely on loopback; no public internet is used.
  forbiddenServer = createServer((_request, response) => {
    forbiddenRequests++;
    response.setHeader('Content-Type', 'text/html');
    response.end(pageShell('<h1>This forbidden destination must never be requested</h1>'));
  });
  forbiddenServer.listen(0, '0.0.0.0');
  await once(forbiddenServer, 'listening');
  const forbiddenAddress = forbiddenServer.address();
  assert(forbiddenAddress && typeof forbiddenAddress === 'object');
  forbiddenUrl = `http://127.0.0.2:${forbiddenAddress.port}/external`;
  server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (requestPath === '/redirect') {
      response.writeHead(302, { location: forbiddenUrl }).end();
      return;
    }
    if (requestPath === '/redirect-chain') {
      response.writeHead(302, { location: '/redirect' }).end();
      return;
    }
    if (requestPath === '/local-redirect') {
      response.writeHead(302, { location: '/healthy' }).end();
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (requestPath === '/http-error') {
      response.writeHead(500).end(pageShell('<h1>Application failed</h1>'));
    } else if (requestPath === '/script-redirect') {
      response.end(pageShell(`<script>location.replace(${JSON.stringify(forbiddenUrl)})</script>`));
    } else if (requestPath === '/iframe') {
      const crossLocalOrigin = targetUrl.replace('127.0.0.1', 'localhost');
      response.end(pageShell(`<h1>Embedded navigation is unsupported</h1><iframe src="${crossLocalOrigin}/redirect-chain"></iframe>`));
    } else if (requestPath === '/fresh') {
      response.end(pageShell('<div id="state"></div><script>const reused=localStorage.getItem("seen")||document.cookie.includes("seen=1");localStorage.setItem("seen","1");document.cookie="seen=1;path=/";document.querySelector("#state").style.width=reused?"2000px":"100%";</script>'));
    } else if (requestPath === '/reload') {
      response.end(pageShell('<div style="width:100%;height:40px">Responsive after one reload</div><script>if(!sessionStorage.getItem("reloaded")){sessionStorage.setItem("reloaded","1");Object.defineProperty(document.fonts,"ready",{get:()=>new Promise(()=>{})});setTimeout(()=>location.reload(),50)}</script>'));
    } else if (requestPath === '/partial') {
      response.end(pageShell('<h1>One failing viewport</h1><script>if(innerWidth===375)throw new Error("private-browser-data-sentinel")</script>'));
    } else if (requestPath === '/browser-errors') {
      response.end(pageShell('<h1>Browser failures</h1><script>console.error("private-console-data-sentinel");throw new Error("private-browser-data-sentinel")</script>'));
    } else {
      response.end(healthyHtml);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  targetUrl = `http://127.0.0.1:${address.port}`;

  // The test harness starts an isolated copy; the scanner only receives a running URL.
  const brokenCopy = path.join(runDirectory, 'broken-shop');
  await cp(path.join(root, 'fixtures', 'broken-shop'), brokenCopy, {
    recursive: true,
    filter: (source) => !['node_modules', 'dist', '.env'].includes(path.basename(source)),
  });
  vite = await createViteServer({
    root: brokenCopy, configFile: false, cacheDir: path.join(runDirectory, 'vite-cache'),
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'], noDiscovery: true },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'silent',
  });
  await vite.listen();
  const viteAddress = vite.httpServer?.address();
  assert(viteAddress && typeof viteAddress === 'object');
  brokenUrl = `http://127.0.0.1:${viteAddress.port}`;
  // Ensure the separately started dev app has completed its first dependency
  // optimization. A cold Vite reload during scanner readiness is a real failure,
  // so establish the test input's readiness before asking the scanner to inspect it.
  const warmupBrowser = await chromium.launch({ headless: true });
  try {
    const warmupPage = await warmupBrowser.newPage();
    await warmupPage.goto(brokenUrl, { waitUntil: 'load', timeout: 15_000 });
    await warmupPage.locator('[data-testid="intentional-overflow-container"]').waitFor({ timeout: 15_000 });
    await vite.waitForRequestsIdle();
  } finally {
    await warmupBrowser.close();
  }
}, { timeout: 30_000 });

after(async () => {
  await vite?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  if (forbiddenServer) {
    forbiddenServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => forbiddenServer.close((error) => error ? reject(error) : resolve()));
  }
});

async function runScan(name: string, url: string, targetProject = project) {
  return scanProject({ project: targetProject, url, output: path.join(runDirectory, 'reports', name) });
}

async function assertRealReport(report: ScanReport, reportDirectory: string) {
  ScanReportSchema.parse(report);
  assert.deepEqual(report.results.map((result) => result.viewport.width), [...SCAN_WIDTHS]);
  const fromDisk = JSON.parse(await readFile(path.join(reportDirectory, 'report.json'), 'utf8'));
  assert.deepEqual(fromDisk, report);
  for (const result of report.results) {
    if (!result.screenshot) continue;
    const imagePath = path.join(reportDirectory, result.screenshot.path);
    assert.equal(path.isAbsolute(result.screenshot.path), false);
    const image = await readFile(imagePath);
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.readUInt32BE(16), result.viewport.width);
    assert.equal(image.readUInt32BE(20), 900);
    assert((await stat(imagePath)).size > 100);
  }
}

test('validation rejects unsupported paths/manifests and unsafe URLs', async () => {
  assert.equal(validateLocalUrl('http://localhost:5180/path?mode=test'), 'http://localhost:5180/path?mode=test');
  assert.equal(validateLocalUrl('http://127.0.0.1:5180'), 'http://127.0.0.1:5180/');
  assert.equal(validateLocalUrl('http://[::1]:5180/'), 'http://[::1]:5180/');
  for (const url of ['https://localhost/', 'file:///tmp/index.html', 'http://example.com/', 'http://localhost.evil.invalid/', 'http://user:password@127.0.0.1/', 'http://127.0.0.2/', 'http://0.0.0.0/']) {
    assert.throws(() => validateLocalUrl(url), undefined, url);
  }
  await assert.rejects(validateProject(path.join(runDirectory, 'does-not-exist')));
  await assert.rejects(validateProject(path.join(project, 'package.json')));
  const invalidProject = path.join(runDirectory, 'invalid-project');
  await mkdir(invalidProject);
  await assert.rejects(validateProject(invalidProject));
  await writeFile(path.join(invalidProject, 'package.json'), '{invalid JSON');
  await assert.rejects(validateProject(invalidProject));
  await writeFile(path.join(invalidProject, 'package.json'), JSON.stringify({ dependencies: { react: '*' } }));
  await assert.rejects(validateProject(invalidProject));
  await writeFile(path.join(invalidProject, 'package.json'), JSON.stringify({ devDependencies: { vite: '*' } }));
  await assert.rejects(validateProject(invalidProject));
  assert.equal((await validateProject(project)).framework, 'react-vite');
});

test('healthy responsive layout and contained carousel pass all five widths with real bounded screenshots', { timeout: 90_000 }, async () => {
  const beforeFiles = await readdir(project);
  const sourceBefore = await readFile(path.join(project, 'source.tsx'), 'utf8');
  const manifestBefore = await readFile(path.join(project, 'package.json'), 'utf8');
  const { report, reportDirectory } = await runScan('healthy', `${targetUrl}/healthy`);
  assert.equal(report.status, 'complete');
  assert.equal(report.errors.length, 0);
  for (const result of report.results) {
    assert.equal(result.status, 'complete');
    assert.equal(result.document?.hasOverflow, false);
    assert.equal(result.candidates.length, 0);
    assert(result.screenshot);
  }
  await assertRealReport(report, reportDirectory);
  assert.deepEqual(await readdir(project), beforeFiles);
  assert.equal(await readFile(path.join(project, 'source.tsx'), 'utf8'), sourceBefore);
  assert.equal(await readFile(path.join(project, 'package.json'), 'utf8'), manifestBefore);
  console.log(`HEALTHY_REPORT ${reportDirectory}`);
  console.log(`HEALTHY_SUMMARY ${JSON.stringify(report.results.map((result) => ({ width: result.viewport.width, status: result.status, overflowPx: result.document?.overflowPx, candidates: result.candidates.length })))}`);
});

test('actual broken-shop fixture reports document overflow and useful candidate evidence', { timeout: 90_000 }, async () => {
  const brokenProject = path.join(runDirectory, 'broken-shop');
  const { report, reportDirectory } = await runScan('broken-shop', brokenUrl, brokenProject);
  assert.equal(report.status, 'complete');
  const narrow = report.results[0];
  assert.equal(narrow.viewport.width, 320);
  assert.equal(narrow.document?.hasOverflow, true);
  assert((narrow.document?.overflowPx ?? 0) > 100);
  assert(narrow.candidates.length > 0);
  assert(narrow.candidates.some((candidate) => candidate.rect.width >= 480 && candidate.styles.width === '480px'));
  for (const candidate of narrow.candidates) {
    assert(candidate.selector.length > 0);
    assert(candidate.tagName.length > 0);
    assert.equal(candidate.viewportWidth, 320);
    assert.equal(candidate.documentWidth, narrow.document?.scrollWidth);
    assert(candidate.overflowPx > 1);
  }
  assert.equal(report.results.at(-1)?.document?.hasOverflow, false);
  await assertRealReport(report, reportDirectory);
  console.log(`BROKEN_REPORT ${reportDirectory}`);
  console.log(`BROKEN_SUMMARY ${JSON.stringify(report.results.map((result) => ({ width: result.viewport.width, status: result.status, overflowPx: result.document?.overflowPx, candidates: result.candidates.length })))}`);
});

test('real browser geometry excludes hidden/contained content and preserves independent overflowing containers', { timeout: 90_000 }, async (t) => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    const currentPage = page;
    const measure = async (html: string) => {
      await currentPage.setContent(html, { waitUntil: 'domcontentloaded' });
      return inspectOverflow(currentPage);
    };
    const candidateIds = async (candidates: Awaited<ReturnType<typeof inspectOverflow>>['candidates']) => Promise.all(
      candidates.map((candidate) => currentPage.locator(candidate.selector).getAttribute('id')),
    );

    await t.test('intentional scroll region and clipped descendants fit', async () => {
      const result = await measure(pageShell('<div id="carousel" style="width:100%;overflow-x:auto"><div id="track" style="width:1200px;height:40px">Items</div></div><div style="width:100%;overflow:hidden"><div style="width:900px;height:40px">Clipped</div></div>'));
      assert.equal(result.document.hasOverflow, false);
      assert.equal(result.candidates.length, 0);
    });
    await t.test('body can be an intentional scroll region without document overflow', async () => {
      const result = await measure(pageShell('<div style="width:1200px;height:40px">Contained body scroller</div>', 'html{overflow:auto}body{width:100%;height:100px;overflow-x:auto}'));
      assert.equal(result.document.hasOverflow, false);
      assert.equal(result.candidates.length, 0);
    });
    await t.test('oversized scroll container is reported once, its wide children are suppressed', async () => {
      const result = await measure(pageShell('<div id="oversized" style="width:600px;height:80px;overflow-x:auto"><div id="track" style="width:1400px;height:40px"><span>Wide slide content</span></div></div>'));
      assert.equal(result.document.hasOverflow, true);
      assert.deepEqual(await candidateIds(result.candidates), ['oversized']);
    });
    await t.test('hidden elements and hidden ancestors are ignored', async () => {
      const result = await measure(pageShell('<div hidden style="width:2000px;height:40px"></div><div style="display:none"><div style="width:2000px;height:40px"></div></div><div style="visibility:hidden;width:2000px;height:40px"><div style="width:2100px;height:40px"></div></div><div style="opacity:0;width:2000px;height:40px"><div style="width:2100px;height:40px"></div></div>'));
      assert.equal(result.candidates.length, 0);
    });
    await t.test('visibility can be restored by a child of a hidden ancestor', async () => {
      const result = await measure(pageShell('<div style="visibility:hidden"><div id="restored" style="visibility:visible;width:600px;height:40px">Visible child</div></div>'));
      assert.equal(result.document.hasOverflow, true);
      assert.deepEqual(await candidateIds(result.candidates), ['restored']);
    });
    await t.test('a fixed element escapes ordinary ancestor overflow clipping', async () => {
      const result = await measure(pageShell('<div style="width:100px;height:100px;overflow:hidden"><div id="fixed" style="position:fixed;left:300px;top:0;width:100px;height:40px">Fixed</div></div>'));
      assert.deepEqual(await candidateIds(result.candidates), ['fixed']);
    });
    await t.test('one overflowing branch is not repeated as independent descendant bugs', async () => {
      const result = await measure(pageShell('<section id="outer" style="width:700px"><div id="middle"><p id="inner" style="height:40px">Overflowing branch</p></div></section>'));
      assert.equal(result.document.hasOverflow, true);
      assert.deepEqual(await candidateIds(result.candidates), ['outer']);
    });
    await t.test('fractional overflow within documented one-pixel tolerance is ignored', async () => {
      const result = await measure(pageShell('<div style="width:calc(100vw + 0.5px);height:40px"></div>'));
      assert.equal(result.document.hasOverflow, false);
      assert.equal(result.candidates.length, 0);
    });
    await t.test('left-side overflow is a candidate even if scrollWidth does not increase', async () => {
      const result = await measure(pageShell('<div id="left" style="position:absolute;left:-40px;width:100px;height:40px"></div>'));
      assert.deepEqual(await candidateIds(result.candidates), ['left']);
      assert.equal(result.candidates[0].overflowPx, 40);
    });
    await t.test('independent candidate evidence is bounded and marks truncation', async () => {
      const result = await measure(pageShell(Array.from({ length: 30 }, (_, index) => `<div style="position:absolute;left:300px;top:${index * 25}px;width:80px;height:20px"></div>`).join('')));
      assert.equal(result.candidates.length, 20);
      assert.equal(result.candidatesTruncated, true);
    });
  } finally {
    await page?.close();
    await browser?.close();
  }
});

test('fresh context per viewport prevents localStorage and cookies from leaking between checks', { timeout: 90_000 }, async () => {
  const { report, reportDirectory } = await runScan('fresh-state', `${targetUrl}/fresh`);
  assert.equal(report.status, 'complete');
  assert(report.results.every((result) => !result.document?.hasOverflow && result.candidates.length === 0));
  await assertRealReport(report, reportDirectory);
});

test('navigation redirects between allowed local URLs remain supported', { timeout: 90_000 }, async () => {
  const { report, reportDirectory } = await runScan('local-redirect', `${targetUrl}/local-redirect`);
  assert.equal(report.status, 'complete');
  assert(report.results.every((result) => result.status === 'complete' && !result.document?.hasOverflow));
  await assertRealReport(report, reportDirectory);
});

test('a single reload during font readiness recovers within the bounded readiness budget', { timeout: 90_000 }, async () => {
  const { report, reportDirectory } = await runScan('reload', `${targetUrl}/reload`);
  assert.equal(report.status, 'complete');
  assert(report.results.every((result) => result.status === 'complete' && !result.document?.hasOverflow && result.candidates.length === 0));
  await assertRealReport(report, reportDirectory);
});

test('unreachable navigation, HTTP failures and external redirects never pass', { timeout: 180_000 }, async (t) => {
  const closedServer = createServer();
  closedServer.listen(0, '127.0.0.1');
  await once(closedServer, 'listening');
  const address = closedServer.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((resolve) => closedServer.close(() => resolve()));
  unreachableUrl = `http://127.0.0.1:${address.port}/`;
  const cases = [
    ['unreachable', unreachableUrl],
    ['http-error', `${targetUrl}/http-error`],
    ['redirect', `${targetUrl}/redirect`],
    ['redirect-chain', `${targetUrl}/redirect-chain`],
    ['script-redirect', `${targetUrl}/script-redirect`],
    ['iframe', `${targetUrl}/iframe`],
  ];
  for (const [name, url] of cases) {
    await t.test(name, async () => {
      forbiddenRequests = 0;
      const { report, reportDirectory } = await runScan(name, url);
      assert.equal(report.status, 'failed');
      assert.equal(report.results.length, 5);
      for (const result of report.results) {
        assert.equal(result.status, 'failed');
        assert(result.errors.length > 0);
      }
      await assertRealReport(report, reportDirectory);
      assert.equal(forbiddenRequests, 0, 'A forbidden navigation must be blocked before its destination receives a request');
    });
  }
});

test('browser errors are explicit failures and private exception details are omitted', { timeout: 90_000 }, async () => {
  const { report, reportDirectory } = await runScan('browser-errors', `${targetUrl}/browser-errors`);
  assert.equal(report.status, 'failed');
  assert(report.results.every((result) => result.status === 'failed' && result.errors.length > 0));
  const serialized = JSON.stringify(report);
  assert(!serialized.includes('private-console-data-sentinel'));
  assert(!serialized.includes('private-browser-data-sentinel'));
  await assertRealReport(report, reportDirectory);
});

test('one failed viewport produces partial status with four complete checks', { timeout: 90_000 }, async () => {
  const { report, reportDirectory } = await runScan('partial', `${targetUrl}/partial`);
  assert.equal(report.status, 'partial');
  assert.equal(report.results.filter((result) => result.status === 'complete').length, 4);
  assert.equal(report.results.find((result) => result.viewport.width === 375)?.status, 'failed');
  await assertRealReport(report, reportDirectory);
});

test('schemas reject unsafe screenshot paths and failed geometry masquerading as healthy', () => {
  for (const screenshotPath of ['../secret.png', '/absolute.png', 'C:/secret.png', 'shots/../../secret.png', 'shots\\image.png']) {
    assert.equal(ScreenshotPathSchema.safeParse(screenshotPath).success, false);
  }
  assert.equal(ViewportResultSchema.safeParse({
    viewport: { width: 320, height: 900, deviceScaleFactor: 1 },
    status: 'complete', document: null, candidates: [], candidatesTruncated: false, screenshot: null, errors: [],
  }).success, false);
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(root, 'packages', 'cli', 'bin', 'visionfix.js'), ...args], {
      cwd: root, timeout: 90_000,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return; }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

test('CLI preserves help/version and returns documented scan exit codes', { timeout: 180_000 }, async (t) => {
  for (const args of [['--help'], ['--version'], ['scan', '--help']]) {
    await t.test(args.join(' '), async () => {
      const result = await cli(args);
      assert.equal(result.code, 0);
      assert(result.stdout.length > 0);
    });
  }
  for (const [name, url, targetProject, expected] of [
    ['healthy', `${targetUrl}/healthy`, project, 0],
    ['broken', brokenUrl, path.join(runDirectory, 'broken-shop'), 1],
    ['unreachable', unreachableUrl, project, 2],
  ] as const) {
    await t.test(name, async () => {
      const result = await cli(['scan', '--project', targetProject, '--url', url, '--output', path.join(runDirectory, 'cli-reports')]);
      assert.equal(result.code, expected, `${result.stdout}\n${result.stderr}`);
      assert(result.stdout.includes('report.json'));
    });
  }
  await t.test('invalid project and credential URL', async () => {
    assert.equal((await cli(['scan', '--project', path.join(runDirectory, 'missing'), '--url', targetUrl])).code, 2);
    const result = await cli(['scan', '--project', project, '--url', 'http://user:private-credential-sentinel@localhost/']);
    assert.equal(result.code, 2);
    assert(!`${result.stdout}${result.stderr}`.includes('private-credential-sentinel'));
  });
});
