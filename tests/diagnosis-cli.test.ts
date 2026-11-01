import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { scanProject } from '../packages/core/dist/scan.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let run: string;
let project: string;
let report: string;
let server: ViteDevServer;
let sourceHash: string;
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');

function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [path.join(root, 'packages/cli/bin/visionfix.js'), ...args], {
      cwd: root, timeout: 60_000,
      env: { ...process.env, META_API_KEY: '', META_BASE_URL: '', META_MODEL: '' },
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return; }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

before(async () => {
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  run = await mkdtemp(path.join(root, 'artifacts', 'phase2-cli-'));
  project = path.join(run, 'broken-shop');
  await cp(path.join(root, 'fixtures/broken-shop'), project, {
    recursive: true, filter: (entry) => !['node_modules', 'dist'].includes(path.basename(entry)),
  });
  sourceHash = hash(await readFile(path.join(project, 'src/styles.css')));
  server = await createServer({ root: project, server: { port: 0, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  const address = server.httpServer!.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  await fetch(url);
  const result = await scanProject({ project, url, output: path.join(run, 'scans') });
  assert.equal(result.report.status, 'complete');
  assert(result.report.results.some((viewport) => viewport.candidates.length > 0));
  report = path.join(result.reportDirectory, 'report.json');
}, { timeout: 90_000 });

after(async () => { await server?.close(); });

test('real scan to CLI evidence preview, explicit upload refusal and missing credentials; target unchanged', async () => {
  const scanHash = hash(await readFile(report));
  const prepared = await cli(['diagnose', '--project', project, '--report', report, '--prepare']);
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.match(prepared.stdout, /SUCCESS: prepared/);
  assert.match(prepared.stdout, /No API request made/);
  const scanDir = path.dirname(report);
  const child = (await readdir(scanDir)).find((entry) => entry.startsWith('diagnosis-'));
  assert(child);
  const evidence = path.join(scanDir, child, 'manifest.json');
  const denied = await cli(['diagnose', '--evidence', evidence]);
  assert.equal(denied.code, 3);
  assert.match(denied.stdout, /BLOCKED/);
  const blocked = await cli(['diagnose', '--evidence', evidence, '--allow-model-upload']);
  assert.equal(blocked.code, 3);
  assert.match(blocked.stdout, /BLOCKED/);
  assert.equal(hash(await readFile(report)), scanHash);
  assert.equal(hash(await readFile(path.join(project, 'src/styles.css'))), sourceHash);
}, { timeout: 90_000 });

test('CLI rejects mixed, duplicate and missing diagnosis options without echoing input', async () => {
  for (const args of [
    ['--prepare'], ['--project', project, '--report', report],
    ['--evidence', 'private-input-sentinel', '--prepare'],
    ['--evidence', 'private-input-sentinel', '--evidence', report],
    ['--evidence', 'private-input-sentinel', '--project', project],
    ['--project', project, '--report', report, '--prepare', '--allow-model-upload'],
  ]) {
    const result = await cli(['diagnose', ...args]);
    assert.equal(result.code, 2);
    assert(!`${result.stdout}${result.stderr}`.includes('private-input-sentinel'));
  }
});
