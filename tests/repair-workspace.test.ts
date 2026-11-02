import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRepairWorkspace } from '../packages/core/dist/repair-workspace.js';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture() {
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  const run = await mkdtemp(path.join(root, 'artifacts', 'repair-isolation-test-'));
  const project = path.join(run, 'original'); const output = path.join(run, 'run'); const dependencies = path.join(run, 'dependencies');
  for (const directory of [project, output, path.join(project, 'src'), path.join(dependencies, 'react'), path.join(dependencies, 'vite/bin')]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ dependencies: { react: '1', vite: '1' } }));
  await writeFile(path.join(project, 'src/styles.css'), '.wide { width: 600px; }\n');
  await writeFile(path.join(project, 'src/current-untracked.tsx'), 'export default () => <div>Current unsaved-in-Git state</div>;\n');
  await writeFile(path.join(dependencies, 'react/package.json'), '{}');
  await writeFile(path.join(dependencies, 'vite/package.json'), '{}');
  await writeFile(path.join(dependencies, 'vite/bin/vite.js'), '// Deterministic dependency-copy infrastructure fixture, not a real Vite invocation.');
  return { run, project, output, dependencies };
}

test('infrastructure: copy current disk state and dependency bytes, exclude secret/generated inputs, preserve original', async () => {
  const f = await fixture();
  // These are test-owned synthetic credential sentinels, never developer credentials.
  await writeFile(path.join(f.project, '.env'), 'test-only-sentinel');
  await mkdir(path.join(f.project, 'dist')); await writeFile(path.join(f.project, 'dist/generated.js'), 'generated');
  await mkdir(path.join(f.project, 'artifacts')); await writeFile(path.join(f.project, 'artifacts/report.json'), '{}');
  await writeFile(path.join(f.project, 'src/credentials.ts'), 'test-only-sentinel');
  await mkdir(path.join(f.dependencies, 'js-tokens'));
  await writeFile(path.join(f.dependencies, 'js-tokens/index.js'), 'module.exports = [];');
  const before = await readFile(path.join(f.project, 'src/styles.css'));
  const result = await createRepairWorkspace({ project: f.project, runDirectory: f.output, dependencyDirectory: f.dependencies, runId: randomUUID() });
  assert(path.basename(result.directory).startsWith('vfx-'));
  assert(!result.directory.startsWith(f.project + path.sep));
  assert.equal(JSON.parse(await readFile(path.join(f.output, 'workspace-location.json'), 'utf8')).directory, result.directory);
  assert(result.sourceHashes.some((source) => source.path === 'src/current-untracked.tsx'));
  assert(!result.sourceHashes.some((source) => /env|credentials|generated|report/.test(source.path)));
  assert.equal(result.sourceHashes.find((source) => source.path === 'src/styles.css')?.sha256, createHash('sha256').update(before).digest('hex'));
  assert.equal(result.dependencyFiles, 4);
  assert.equal(await readFile(path.join(result.directory, 'node_modules/js-tokens/index.js'), 'utf8'), 'module.exports = [];');
  assert(!(await readdir(result.directory)).includes('.env'));
  assert(!(await lstat(path.join(result.directory, 'node_modules/react/package.json'))).isSymbolicLink());
  await writeFile(path.join(result.directory, 'src/styles.css'), 'copy changed');
  assert.deepEqual(await readFile(path.join(f.project, 'src/styles.css')), before);
  assert.equal(await readFile(path.join(f.project, '.env'), 'utf8'), 'test-only-sentinel');
  await writeFile(path.join(result.directory, 'node_modules/react/package.json'), 'copy dependency changed');
  assert.equal(await readFile(path.join(f.dependencies, 'react/package.json'), 'utf8'), '{}');
});

test('infrastructure: missing dependencies and inside-target output are explicit blockers, never install', async () => {
  const f = await fixture();
  await assert.rejects(createRepairWorkspace({ project: f.project, runDirectory: f.output, dependencyDirectory: path.join(f.run, 'missing'), runId: randomUUID() }), { code: 'DEPENDENCIES_UNAVAILABLE' });
  await assert.rejects(createRepairWorkspace({ project: f.project, runDirectory: f.project, dependencyDirectory: f.dependencies, runId: randomUUID() }), { code: 'UNSAFE_WORKSPACE' });
  assert.deepEqual(await readdir(f.output), []);
});

test('infrastructure: reject source junction escape and exclude dependency workspace aliases', async () => {
  const f = await fixture();
  const external = path.join(f.run, 'outside'); await mkdir(external); await writeFile(path.join(external, 'secret.css'), 'test sentinel');
  await symlink(external, path.join(f.project, 'src/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createRepairWorkspace({ project: f.project, runDirectory: f.output, dependencyDirectory: f.dependencies, runId: randomUUID() }), { code: 'SYMLINK_ESCAPE' });
  const second = await fixture();
  await symlink(second.project, path.join(second.dependencies, 'workspace-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const copied = await createRepairWorkspace({ project: second.project, runDirectory: second.output, dependencyDirectory: second.dependencies, runId: randomUUID() });
  assert(!(await readdir(path.join(copied.directory, 'node_modules'))).includes('workspace-alias'));
});

test('infrastructure: reject oversized copy and refuse to reuse an existing run workspace', async () => {
  const f = await fixture();
  await writeFile(path.join(f.project, 'src/oversized.css'), Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(createRepairWorkspace({ project: f.project, runDirectory: f.output, dependencyDirectory: f.dependencies, runId: randomUUID() }), { code: 'COPY_LIMIT' });
  await assert.rejects(createRepairWorkspace({ project: f.project, runDirectory: f.output, dependencyDirectory: f.dependencies, runId: randomUUID() }), { code: 'WORKSPACE_EXISTS' });
});

test('infrastructure: symlinked required dependencies block before copying instead of producing a broken install', async () => {
  const f = await fixture(); const linkedDependencies = path.join(f.run, 'linked-dependencies');
  await mkdir(linkedDependencies);
  await symlink(path.join(f.dependencies, 'react'), path.join(linkedDependencies, 'react'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.join(f.dependencies, 'vite'), path.join(linkedDependencies, 'vite'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createRepairWorkspace({ project: f.project, runDirectory: f.output, dependencyDirectory: linkedDependencies, runId: randomUUID() }), { code: 'DEPENDENCIES_UNAVAILABLE' });
  assert.deepEqual(await readdir(f.output), []);
});
