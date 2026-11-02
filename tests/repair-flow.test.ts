import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as createPortServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { scanProject } from '../packages/core/dist/scan.js';
import { prepareDiagnosisEvidence } from '../packages/core/dist/diagnosis-evidence.js';
import { loadRepairPlan, prepareRepairPlan } from '../packages/core/dist/repair-plan.js';
import { runRepair, RepairReportSchema } from '../packages/core/dist/repair.js';
import type { PatchProposal } from '../packages/core/dist/repair-patch.js';
import type { RepairExecutionConfig } from '../packages/core/dist/repair-schema.js';

// Every proposal/diagnosis in this file is DETERMINISTIC INFRASTRUCTURE TEST DATA.
// Real Vite builds, real processes and real Chromium checks run; no live AI repair is claimed.
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let directory: string;
let project: string;
let dependencies: string;
let evidence: string;
let diagnosisPath: string;
let originalCss: Buffer;
let originalCredential: Buffer;
let sourceServer: ViteDevServer;

async function availablePort(): Promise<number> {
  const server = createPortServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
before(async () => {
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  directory = await mkdtemp(path.join(root, 'artifacts', 'phase3-infrastructure-'));
  project = path.join(directory, 'original-shop');
  await cp(path.join(root, 'fixtures/broken-shop'), project, { recursive: true,
    filter: (entry) => !['node_modules', 'dist'].includes(path.basename(entry)) });
  originalCss = await readFile(path.join(project, 'src/styles.css'));
  originalCredential = Buffer.from('PRIVATE_TEST_VALUE=infrastructure-secret-sentinel\n');
  await writeFile(path.join(project, '.env'), originalCredential, { flag: 'wx' });
  // Dependency setup belongs to the test harness, never the repair implementation.
  // Copy a sufficient already-installed dependency set, without npm/install hooks.
  dependencies = path.join(directory, 'installed-dependencies');
  await mkdir(dependencies);
  for (const name of ['vite', 'esbuild', '@esbuild', 'rollup', '@rollup', 'postcss', 'picocolors', 'nanoid',
    'source-map-js', 'fdir', 'picomatch', 'tinyglobby', 'react', 'react-dom', 'scheduler', 'loose-envify', 'js-tokens']) {
    await cp(path.join(root, 'node_modules', name), path.join(dependencies, name), { recursive: true, dereference: true });
  }
  // Plain reviewed Vite config lets the test use only the listed installed dependencies.
  await writeFile(path.join(project, 'vite.config.ts'), 'export default {};\n');
  sourceServer = await createViteServer({ root: project, server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await sourceServer.listen();
  const address = sourceServer.httpServer!.address(); assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/`;
  await fetch(url);
  const scan = await scanProject({ project, url, output: path.join(directory, 'scans') });
  assert.equal(scan.report.status, 'complete');
  const prepared = await prepareDiagnosisEvidence({ project, report: path.join(scan.reportDirectory, 'report.json') });
  evidence = prepared.manifestPath;
  const source = prepared.manifest.snippets.find((snippet) => snippet.path.endsWith('.css'))!;
  assert(source);
  diagnosisPath = path.join(directory, 'deterministic-diagnosis.json');
  await writeFile(diagnosisPath, JSON.stringify({ schemaVersion: '2.0.0', createdAt: new Date().toISOString(),
    status: 'success', code: 'DIAGNOSIS_VALIDATED', message: 'DETERMINISTIC INFRASTRUCTURE TEST diagnosis, not live AI output.',
    diagnosis: { issueId: prepared.manifest.issueId, viewportWidth: 320, status: 'uncertain',
      explanation: 'Infrastructure fixture: reviewed rigid CSS width is a candidate contributor.', browserEvidenceIds: ['candidate-1', 'document', 'screenshot'],
      sources: [{ snippetId: source.id, path: source.path, startLine: source.startLine, endLine: source.endLine, quote: source.content }],
      repairApproach: 'Test a responsive width and wrapping while preserving content.', uncertainties: ['Deterministic test diagnosis; not a real model response.'], missingEvidence: [],
    }, limitations: ['Infrastructure verification only; no live AI repair.'],
  }, null, 2));
}, { timeout: 90_000 });
after(async () => { await sourceServer?.close(); });

async function plan(overrides: Partial<RepairExecutionConfig> = {}) {
  const config: RepairExecutionConfig = { schemaVersion: '3.0.0', allowedCssFiles: ['src/styles.css'], dependencyDirectory: dependencies,
    build: { executable: process.execPath, args: ['node_modules/vite/bin/vite.js', 'build'], timeoutMs: 60_000 },
    server: { executable: process.execPath, args: ['node_modules/vite/bin/vite.js', 'preview'], timeoutMs: 30_000 },
    port: await availablePort(), targetSelector: '.product-specs-banner',
    interaction: { selector: '.checkout-btn', expectedDialog: 'Proceeding to checkout...' }, ...overrides };
  const configPath = path.join(directory, `execution-${randomUUID()}.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return prepareRepairPlan({ project, evidence, diagnosis: diagnosisPath, config: configPath });
}
function proposal(issueId: string, changes: Array<[string, string[]]>): PatchProposal {
  const lines = originalCss.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  const ordered = changes.map(([old, replacement]) => ({ line: lines.indexOf(old) + 1, old, replacement })).sort((a, b) => a.line - b.line);
  assert(ordered.every((change) => change.line > 0));
  let offset = 0;
  const hunks = ordered.map((change) => {
    const hunk = `@@ -${change.line},1 +${change.line + offset},${change.replacement.length} @@\n-${change.old}\n${change.replacement.map((line) => '+' + line).join('\n')}\n`;
    offset += change.replacement.length - 1; return hunk;
  }).join('');
  return { issueId, explanation: 'DETERMINISTIC INFRASTRUCTURE TEST proposal, not generated by Meta.',
    unifiedDiff: '--- a/src/styles.css\n+++ b/src/styles.css\n' + hunks, uncertainties: ['Only the configured test checks establish acceptance.'] };
}
const widthLine = '  width: 480px; /* <--- INTENTIONAL DEFECT: rigid width exceeds 320px viewport */';
function goodProposal(issueId: string, extra: Array<[string, string[]]> = []): PatchProposal {
  return proposal(issueId, [[widthLine, ['  width: 100%;']], ['  gap: 1.5rem;', ['  gap: 1.5rem;', '  flex-wrap: wrap;']], ...extra]);
}
async function execute(prepared: Awaited<ReturnType<typeof plan>>, patch: PatchProposal) {
  const result = await runRepair({ plan: prepared.planPath, allowModelUpload: true, allowProjectExecution: true,
    testProposal: { kind: 'deterministic-infrastructure-test', proposal: patch } });
  assert(result.report, `${result.status} ${result.code}: ${result.message}`);
  RepairReportSchema.parse(result.report);
  assert.equal(result.report.model.kind, 'deterministic-test');
  assert.equal(result.report.model.requestMade, false);
  assert.equal(result.report.originalSourcesUnchanged, true);
  assert.equal(result.report.cleanup.serverStopped, true);
  assert.equal(hash(await readFile(path.join(project, 'src/styles.css'))), hash(originalCss));
  assert.equal(hash(await readFile(path.join(project, '.env'))), hash(originalCredential));
  return result;
}

test('infrastructure: successful isolated shop repair builds and verifies all five viewports/content/checkout, original preserved', async () => {
  const prepared = await plan();
  const result = await execute(prepared, goodProposal(prepared.plan.issueId));
  assert.equal(result.status, 'verified', result.message);
  assert.equal(result.report!.builds.length, 2);
  assert(result.report!.verification!.report.results.every((viewport) => !viewport.document!.hasOverflow && viewport.candidates.length === 0));
  assert(result.report!.verification!.content.results.every((viewport) => viewport.interaction.clickReceived && viewport.interaction.dialogMatched));
  assert.equal(result.report!.patch!.changedFiles[0].path, 'src/styles.css');
  console.log(`DETERMINISTIC_SUCCESS_REPORT ${result.reportPath}`);
  const again = await runRepair({ plan: prepared.planPath, allowModelUpload: true, allowProjectExecution: true,
    testProposal: { kind: 'deterministic-infrastructure-test', proposal: goodProposal(prepared.plan.issueId) } });
  assert.equal(again.code, 'ATTEMPT_ALREADY_USED');
}, { timeout: 150_000 });

test('infrastructure: ineffective CSS patch is rejected and only copied CSS is reverted', async () => {
  const prepared = await plan();
  const result = await execute(prepared, proposal(prepared.plan.issueId, [[widthLine, ['  width: 479px;']]]));
  assert.equal(result.status, 'rejected'); assert.equal(result.code, 'VERIFICATION_REJECTED');
  assert.equal(result.report!.cleanup.workspacePatchReverted, true);
  assert.equal(hash(await readFile(path.join(result.report!.workspace!, 'src/styles.css'))), hash(originalCss));
  console.log(`DETERMINISTIC_REJECTED_REPORT ${result.reportPath}`);
}, { timeout: 150_000 });

test('infrastructure: hiding affected content and masking document overflow are rejected', async () => {
  for (const [label, patch] of [
    ['hidden', (issueId: string) => proposal(issueId, [[widthLine, ['  display: none;']]])],
    ['mask', (issueId: string) => goodProposal(issueId, [['  font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif;',
      ['  overflow-x: hidden;', '  font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif;']]])],
  ] as const) {
    const prepared = await plan(); const result = await execute(prepared, patch(prepared.plan.issueId));
    assert.equal(result.status, 'rejected', `${label}: ${result.message}`);
    assert.equal(result.report!.cleanup.workspacePatchReverted, true);
  }
}, { timeout: 240_000 });

test('infrastructure: checkout interaction regression rejects a geometry-clean repair', async () => {
  const prepared = await plan();
  const result = await execute(prepared, goodProposal(prepared.plan.issueId, [['  cursor: pointer;', ['  cursor: pointer;', '  pointer-events: none;']]]));
  assert.equal(result.status, 'rejected');
  assert(result.report!.verification!.content.results.some((viewport) => !viewport.interaction.passed));
}, { timeout: 150_000 });

test('infrastructure: nonreproducible baseline stops before patch, and post-patch build failure rejects', async () => {
  const repairCss = "const fs=require('node:fs');let s=fs.readFileSync('src/styles.css','utf8');s=s.replace('width: 480px;','width: 100%;').replace('gap: 1.5rem;','gap: 1.5rem; flex-wrap: wrap;');fs.writeFileSync('src/styles.css',s);";
  const buildVite = "const r=require('node:child_process').spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build'],{stdio:'inherit'});process.exit(r.status??1);";
  const fixed = await plan({ build: { executable: process.execPath, args: ['-e', repairCss + buildVite], timeoutMs: 60_000 } });
  const inconclusive = await execute(fixed, goodProposal(fixed.plan.issueId));
  assert.equal(inconclusive.status, 'inconclusive'); assert.equal(inconclusive.code, 'BASELINE_NOT_REPRODUCIBLE');
  assert.equal(inconclusive.report!.patch, null);
  const unrelated = await plan({ targetSelector: '.product-price' });
  const mismatch = await execute(unrelated, goodProposal(unrelated.plan.issueId));
  assert.equal(mismatch.status, 'inconclusive'); assert.equal(mismatch.code, 'BASELINE_NOT_REPRODUCIBLE');
  assert.equal(mismatch.report!.patch, null);
  const failSecond = "const fs=require('node:fs');if(fs.existsSync('build.once'))process.exit(7);fs.writeFileSync('build.once','1');" + buildVite;
  const failing = await plan({ build: { executable: process.execPath, args: ['-e', failSecond], timeoutMs: 60_000 } });
  const rejected = await execute(failing, goodProposal(failing.plan.issueId));
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.code, 'BUILD_FAILED');
  assert.equal(rejected.report!.cleanup.workspacePatchReverted, true);
}, { timeout: 240_000 });

test('infrastructure: baseline build failure, occupied port and missing dependencies preserve the original', async () => {
  const failed = await plan({ build: { executable: process.execPath, args: ['-e', 'process.exit(9)'], timeoutMs: 10_000 } });
  assert.equal((await execute(failed, goodProposal(failed.plan.issueId))).code, 'BUILD_FAILED');
  const server = createPortServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  try {
    const occupied = await plan({ port: address.port });
    const result = await execute(occupied, goodProposal(occupied.plan.issueId));
    assert.equal(result.code, 'PORT_OCCUPIED'); assert.equal(result.report!.workspace, null); assert(server.listening);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  const missing = await plan({ dependencyDirectory: path.join(directory, 'not-installed') });
  const blocked = await execute(missing, goodProposal(missing.plan.issueId));
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.code, 'DEPENDENCIES_UNAVAILABLE');
}, { timeout: 120_000 });

test('infrastructure: explicit permissions precede input access; stale source, changed plan/config and blocked diagnosis fail safely', async () => {
  assert.equal((await runRepair({ plan: 'missing-private-input', allowModelUpload: true, allowProjectExecution: false })).code, 'AUTHORIZATION_REQUIRED');
  assert.equal((await runRepair({ plan: 'missing-private-input', allowModelUpload: false, allowProjectExecution: true })).code, 'AUTHORIZATION_REQUIRED');
  const prepared = await plan();
  await writeFile(prepared.planPath, (await readFile(prepared.planPath, 'utf8')) + ' ');
  assert.equal((await runRepair({ plan: prepared.planPath, allowModelUpload: true, allowProjectExecution: true })).code, 'CHANGED_PLAN');
  const configChanged = await plan();
  await writeFile(configChanged.plan.configPath, '{}');
  assert.equal((await runRepair({ plan: configChanged.planPath, allowModelUpload: true, allowProjectExecution: true })).code, 'CHANGED_INPUT');
  const stale = await plan();
  try {
    await writeFile(path.join(project, 'src/styles.css'), Buffer.concat([originalCss, Buffer.from('\n/* concurrent developer edit */\n')]));
    assert.equal((await runRepair({ plan: stale.planPath, allowModelUpload: true, allowProjectExecution: true })).code, 'STALE_SOURCE');
  } finally { await writeFile(path.join(project, 'src/styles.css'), originalCss); }
  try {
    await writeFile(path.join(project, 'src/styles.css'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), originalCss]));
    const bom = await plan();
    assert.equal((await loadRepairPlan(bom.planPath)).plan.sources[0].content.charCodeAt(0), 0xfeff);
  } finally { await writeFile(path.join(project, 'src/styles.css'), originalCss); }
  const blockedPath = path.join(directory, 'blocked-diagnosis.json'); await writeFile(blockedPath, JSON.stringify({ status: 'blocked', code: 'MISSING_CONFIG' }));
  const config = await plan();
  await assert.rejects(prepareRepairPlan({ project, evidence, diagnosis: blockedPath, config: config.plan.configPath }), /successful validated Phase 2 diagnosis/);
}, { timeout: 30_000 });

function cli(args: string[]) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    execFile(process.execPath, [path.join(root, 'packages/cli/bin/visionfix.js'), ...args], { cwd: root, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return; }
      resolve({ code: error ? Number(error.code) : 0, output: stdout + stderr });
    });
  });
}
test('infrastructure: public repair CLI prepares local review and rejects invalid or unauthorized options', async () => {
  const prepared = await plan();
  const result = await cli(['repair', '--project', project, '--evidence', evidence, '--diagnosis', diagnosisPath, '--config', prepared.plan.configPath, '--prepare']);
  assert.equal(result.code, 0, result.output); assert.match(result.output, /prepared locally/);
  assert.equal((await cli(['repair', '--plan', 'missing-private-input'])).code, 3);
  for (const args of [['--prepare'], ['--plan', 'private-sentinel', '--prepare'], ['--plan', 'private-sentinel', '--plan', 'duplicate'], ['--proposal', 'private-sentinel']]) {
    const invalid = await cli(['repair', ...args]); assert.equal(invalid.code, 2); assert(!invalid.output.includes('private-sentinel'));
  }
  assert.equal((await cli(['repair', '--help'])).code, 0);
  assert((await readdir(path.dirname(evidence))).some((name) => name.startsWith('repair-')));
});
