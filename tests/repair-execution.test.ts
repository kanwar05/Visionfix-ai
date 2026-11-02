import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkRepairPort, repairEnvironment, runRepairBuild, startRepairServer } from '../packages/core/dist/repair-execution.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture() {
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  const run = await mkdtemp(path.join(root, 'artifacts', 'repair-execution-test-'));
  const workspace = path.join(run, 'workspace'); const original = path.join(run, 'original'); const logs = path.join(run, 'logs');
  for (const dir of [workspace, original, path.join(workspace, 'dist'), path.join(workspace, 'node_modules/vite/bin')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(workspace, '.visionfix-workspace.json'), JSON.stringify({ schemaVersion: '3.0.0', runId: randomUUID(), originalProject: original }));
  return { run, workspace, original, logs };
}
const command = (args: string[], timeoutMs = 10_000) => ({ executable: process.execPath, args, timeoutMs });
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('infrastructure: reviewed build executes in copied cwd with credential-free environment and sanitized bounded logs', async () => {
  const f = await fixture();
  const saved = process.env.META_API_KEY; process.env.META_API_KEY = 'synthetic-parent-secret';
  try {
    const environment = repairEnvironment(); assert.equal(environment.META_API_KEY, undefined); assert.equal(environment.NODE_OPTIONS, undefined);
    await writeFile(path.join(f.workspace, 'build.cjs'), "const fs=require('node:fs');fs.writeFileSync('build-check.json',JSON.stringify({cwd:process.cwd(),meta:process.env.META_API_KEY??null}));console.log('api_key=unit-test-secret');console.log('x'.repeat(70000));");
    const result = await runRepairBuild({ workspace: f.workspace, command: command(['build.cjs']), logDirectory: f.logs });
    assert.equal(result.success, true, await readFile(result.logPath, 'utf8')); assert.equal(result.exitCode, 0);
    const report = JSON.parse(await readFile(path.join(f.workspace, 'build-check.json'), 'utf8'));
    assert.equal(report.cwd.toLowerCase(), f.workspace.toLowerCase()); assert.equal(report.meta, null);
    const log = await readFile(result.logPath, 'utf8'); assert(!log.includes('unit-test-secret')); assert(log.includes('[REDACTED]')); assert(log.includes('[LOG TRUNCATED]')); assert(Buffer.byteLength(log) < 66_000);
  } finally { if (saved === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = saved; }
}, { timeout: 30_000 });

test('infrastructure: failed builds and timeouts are explicit and descendants are terminated', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'failure.cjs'), 'process.exit(7)');
  const failed = await runRepairBuild({ workspace: f.workspace, command: command(['failure.cjs']), logDirectory: f.logs });
  assert.equal(failed.success, false); assert.equal(failed.exitCode, 7); assert.equal(failed.timedOut, false);
  await writeFile(path.join(f.workspace, 'worker.cjs'), 'setInterval(()=>{},1000)');
  await writeFile(path.join(f.workspace, 'tree.cjs'), "const fs=require('node:fs'); const p=require('node:child_process').spawn(process.execPath,['worker.cjs'],{stdio:'ignore'});fs.writeFileSync('worker-pid.txt',String(p.pid));setInterval(()=>{},1000);");
  const timeout = await runRepairBuild({ workspace: f.workspace, command: command(['tree.cjs'], 2000), logDirectory: f.logs });
  assert.equal(timeout.success, false); assert.equal(timeout.timedOut, true);
  const pid = Number(await readFile(path.join(f.workspace, 'worker-pid.txt'), 'utf8'));
  for (let i = 0; i < 20 && alive(pid); i++) await wait(50);
  assert.equal(alive(pid), false, 'Only the run-owned descendant must be terminated');
}, { timeout: 30_000 });

test('infrastructure: descendants cannot outlive a completed root build', async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace, 'worker.cjs'), 'setInterval(()=>{},1000)');
  await writeFile(path.join(f.workspace, 'root.cjs'), "const fs=require('node:fs'); const p=require('node:child_process').spawn(process.execPath,['worker.cjs'],{stdio:'ignore'});fs.writeFileSync('orphan-pid.txt',String(p.pid));process.exit(0);");
  const result = await runRepairBuild({ workspace: f.workspace, command: command(['root.cjs']), logDirectory: f.logs });
  assert.equal(result.success, true);
  const pid = Number(await readFile(path.join(f.workspace, 'orphan-pid.txt'), 'utf8'));
  for (let i = 0; i < 20 && alive(pid); i++) await wait(50);
  assert.equal(alive(pid), false);
}, { timeout: 30_000 });

test('infrastructure: occupied loopback ports are rejected without using or terminating their owner', async () => {
  const f = await fixture(); const existing = createServer().listen(0, '127.0.0.1'); await once(existing, 'listening');
  const address = existing.address(); assert(address && typeof address === 'object');
  try {
    await assert.rejects(checkRepairPort(address.port), { code: 'PORT_OCCUPIED' });
    await assert.rejects(startRepairServer({ workspace: f.workspace, command: command(['node_modules/vite/bin/vite.js', 'preview']), port: address.port, logDirectory: f.logs }), { code: 'PORT_OCCUPIED' });
    assert(existing.listening);
  } finally { await new Promise<void>((resolve) => existing.close(() => resolve())); }
});

test('infrastructure: run-owned preview proves nonce readiness and stop cleans its process tree', async () => {
  const f = await fixture(); const port = await freePort();
  // Deterministic fake Vite entrypoint tests execution ownership, not an AI repair.
  await writeFile(path.join(f.workspace, 'node_modules/vite/bin/vite.js'), "const fs=require('node:fs'),http=require('node:http'),path=require('node:path');const args=process.argv;const port=Number(args[args.indexOf('--port')+1]);http.createServer((q,r)=>{try{r.end(fs.readFileSync(path.join(process.cwd(),'dist',decodeURIComponent(q.url).slice(1))));}catch{r.statusCode=404;r.end('missing')}}).listen(port,'127.0.0.1');");
  const server = await startRepairServer({ workspace: f.workspace, command: command(['node_modules/vite/bin/vite.js', 'preview']), port, logDirectory: f.logs });
  assert.equal(server.url, `http://127.0.0.1:${port}/`); assert(server.pid > 0); assert(alive(server.pid));
  await server.stop(); await server.stop();
  assert.equal(alive(server.pid), false); await checkRepairPort(port);
}, { timeout: 30_000 });

test('infrastructure: reject unowned execution and unsupported command/server options', async () => {
  const f = await fixture();
  await assert.rejects(runRepairBuild({ workspace: f.original, command: command([]), logDirectory: f.logs }), { code: 'INVALID_WORKSPACE' });
  await assert.rejects(runRepairBuild({ workspace: f.workspace, command: { executable: 'node', args: [], timeoutMs: 1000 }, logDirectory: f.logs }), { code: 'UNSUPPORTED_COMMAND' });
  await assert.rejects(startRepairServer({ workspace: f.workspace, command: command(['node_modules/vite/bin/vite.js', 'preview', '--host', '0.0.0.0']), port: await freePort(), logDirectory: f.logs }), { code: 'UNSUPPORTED_SERVER' });
});

test('infrastructure: server readiness timeout cleans the process it started and frees the requested port', async () => {
  const f = await fixture(); const port = await freePort();
  await writeFile(path.join(f.workspace, 'node_modules/vite/bin/vite.js'), "require('node:fs').writeFileSync('server-pid.txt',String(process.pid));setInterval(()=>{},1000);");
  await assert.rejects(startRepairServer({ workspace: f.workspace, command: command(['node_modules/vite/bin/vite.js', 'preview'], 2500), port, logDirectory: f.logs }), { code: 'SERVER_NOT_READY' });
  const pid = Number(await readFile(path.join(f.workspace, 'server-pid.txt'), 'utf8'));
  assert.equal(alive(pid), false); await checkRepairPort(port);
}, { timeout: 15_000 });

test('infrastructure: deeply nested artifact paths work with a short isolated execution directory', async () => {
  const f = await fixture();
  const segments = ['workspace-depth-'.repeat(5), 'nested-artifact-'.repeat(5), 'project-content-'.repeat(5)];
  const workspace = f.workspace;
  const logs = path.join(f.logs, ...segments);
  assert(workspace.length < 180); assert(logs.length > 300);
  await mkdir(path.join(workspace, 'dist'), { recursive: true });
  await mkdir(path.join(workspace, 'node_modules/vite/bin'), { recursive: true });
  await writeFile(path.join(workspace, '.visionfix-workspace.json'), JSON.stringify({ schemaVersion: '3.0.0', runId: randomUUID(), originalProject: f.original }));
  await writeFile(path.join(workspace, 'build.cjs'), "require('node:fs').writeFileSync('build-completed.txt','yes');");
  const built = await runRepairBuild({ workspace, command: command(['build.cjs']), logDirectory: logs });
  assert.equal(built.success, true, await readFile(built.logPath, 'utf8'));
  assert.equal(await readFile(path.join(workspace, 'build-completed.txt'), 'utf8'), 'yes');
  await writeFile(path.join(workspace, 'node_modules/vite/bin/vite.js'), "const fs=require('node:fs'),http=require('node:http'),path=require('node:path');const args=process.argv;const port=Number(args[args.indexOf('--port')+1]);http.createServer((q,r)=>{try{r.end(fs.readFileSync(path.join(process.cwd(),'dist',decodeURIComponent(q.url).slice(1))));}catch{r.statusCode=404;r.end('missing')}}).listen(port,'127.0.0.1');");
  const port = await freePort();
  const server = await startRepairServer({ workspace, command: command(['node_modules/vite/bin/vite.js', 'preview']), port, logDirectory: logs });
  await server.stop(); await checkRepairPort(port);
}, { timeout: 30_000 });
