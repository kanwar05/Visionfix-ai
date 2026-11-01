import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { APPROVED_SOURCE_DIRECTORIES, isApprovedSourcePath, locateSources, SOURCE_LIMITS } from '../packages/core/dist/source-locator.js';
import { filterSecrets } from '../packages/core/dist/privacy.js';

async function withProject(run: (project: string) => Promise<void>): Promise<void> {
  const project = await mkdtemp(path.join(os.tmpdir(), 'visionfix-locator-test-'));
  try { await run(project); }
  finally {
    const resolved = await realpath(project);
    assert.equal(path.dirname(resolved).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
    assert(path.basename(resolved).startsWith('visionfix-locator-test-'));
    await rm(project, { recursive: true, force: true });
  }
}
async function source(project: string, relative: string, content: string | Buffer): Promise<void> {
  const destination = path.join(project, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}
const candidate = (selector: string) => [{ id: 'candidate-1', selector, tagName: 'div' }];

test('literal selector matching finds CSS and JSX with exact relative lines and leaves the project unchanged', async () => {
  await withProject(async (project) => {
    const css = '/* layout */\n.card {\n  width: 650px;\n}\n';
    await source(project, 'src/layout.css', css);
    await source(project, 'src/Panel.tsx', 'export const Panel = () => <div className="card">Content</div>;\n');
    const result = await locateSources(project, candidate('main > div.card'));
    assert.equal(result.mappings[0].status, 'mapped');
    assert.deepEqual(new Set(result.snippets.map((snippet) => snippet.path)), new Set(['src/layout.css', 'src/Panel.tsx']));
    for (const snippet of result.snippets) {
      assert.equal(snippet.content.split('\n').length, snippet.endLine - snippet.startLine + 1);
      assert.equal(snippet.sha256, createHash('sha256').update(snippet.content).digest('hex'));
      assert(snippet.startLine >= 1);
    }
    assert.equal(await readFile(path.join(project, 'src/layout.css'), 'utf8'), css);
    assert.equal(result.truncated, false);
  });
});

test('duplicate selector definitions and absent selectors preserve ambiguity or missing mappings', async () => {
  await withProject(async (project) => {
    await source(project, 'src/a.css', '.shared { width: 700px; }');
    await source(project, 'src/b.css', '.shared { width: 800px; }');
    await source(project, 'src/Other.tsx', 'export const Other = () => <div className="other" />;');
    const result = await locateSources(project, [
      ...candidate('div.shared'), { id: 'missing', selector: 'div.absent', tagName: 'div' },
      { id: 'tag-only', selector: 'div', tagName: 'div' },
    ]);
    assert.equal(result.mappings[0].status, 'ambiguous');
    assert.equal(result.mappings[1].status, 'unmapped');
    assert.equal(result.mappings[2].status, 'unmapped');
    assert.equal(result.mappings[1].snippetIds.length, 0);
  });
});

test('Phase 1 structural ancestry finds supported JSX and CSS while retaining uncertainty', async () => {
  await withProject(async (project) => {
    await source(project, 'src/Content.tsx', 'export function Content() { return <div><main><section><p>Intro</p><div className="wide-panel" /></section></main></div>; }');
    await source(project, 'src/layout.css', '.wide-panel {\n  min-width: 630px;\n}');
    const selector = 'html:nth-of-type(1) > body:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > main:nth-of-type(1) > section:nth-of-type(1) > div:nth-of-type(1)';
    const result = await locateSources(project, candidate(selector));
    assert.equal(result.mappings[0].status, 'ambiguous');
    assert(result.snippets.some((snippet) => snippet.path === 'src/layout.css' && snippet.content.includes('min-width: 630px')));
    assert(result.snippets.some((snippet) => snippet.path === 'src/Content.tsx'));
    assert(result.mappings[0].reasons.some((reason) => reason.includes('runtime rendering')));
  });
});

test('CSS modules accept exact local selectors and mark generated-name inference ambiguous', async () => {
  await withProject(async (project) => {
    await source(project, 'src/Panel.module.css', '.panel {\n  width: 700px;\n}');
    assert.equal((await locateSources(project, candidate('div.panel'))).mappings[0].status, 'mapped');
    const generated = await locateSources(project, candidate('div._panel_a1b2c3_1'));
    assert.equal(generated.mappings[0].status, 'ambiguous');
    assert.equal(generated.snippets[0].path, 'src/Panel.module.css');
  });
});

test('comments and ancestor class matches do not become arbitrary candidate matches', async () => {
  await withProject(async (project) => {
    await source(project, 'src/layout.css', '/* .target { width: 600px; } */\n.ancestor { color: red; }\n.other { content: ".target"; }');
    await source(project, 'src/Other.tsx', '// className="target"\nexport const Other = () => <div className="other" />;');
    const result = await locateSources(project, candidate('div.ancestor > span.target'));
    assert.equal(result.mappings[0].status, 'unmapped');
    assert.equal(result.snippets.length, 0);
  });
});

test('path policy excludes traversal, credentials, generated files, output directories and unsupported types', () => {
  for (const directory of APPROVED_SOURCE_DIRECTORIES) assert.equal(isApprovedSourcePath(`${directory}/layout.css`), true);
  for (const relative of [
    '../src/layout.css', 'src/../layout.css', '/src/layout.css', 'src\\layout.css', 'C:/src/layout.css',
    'src/.env.tsx', 'src/credentials.tsx', 'src/private-key.css', 'src/secrets/layout.css',
    'src/node_modules/a.css', 'src/.git/a.css', 'src/dist/layout.css', 'src/build/layout.css',
    'src/artifacts/layout.css', 'src/reports/layout.css', 'src/layout.generated.css', 'src/layout.min.css',
    'src/layout.png', 'public/layout.css',
  ]) assert.equal(isApprovedSourcePath(relative), false, relative);
});

test('secret/generated/binary sources are excluded and snippets filter sensitive assignments without changing line numbers', async () => {
  await withProject(async (project) => {
    const sensitive = 'this-is-a-synthetic-value-for-unit-testing';
    await source(project, 'src/credentials.tsx', `<div className="target">${sensitive}</div>`);
    await source(project, 'src/dist/layout.css', `.target { content: "${sensitive}"; }`);
    await source(project, 'src/generated.css', `/* @generated */\n.target { content: "${sensitive}"; }`);
    await source(project, 'src/binary.css', Buffer.from([0, 1, 2, 3, 4, 5]));
    await source(project, 'src/Panel.tsx', `const API_KEY = "${sensitive}";\nexport const Panel = () => <div className="target" />;\n`);
    const result = await locateSources(project, candidate('.target'));
    assert.deepEqual(result.snippets.map((snippet) => snippet.path), ['src/Panel.tsx']);
    assert(!JSON.stringify(result).includes(sensitive));
    assert(result.snippets[0].content.includes('[REDACTED]'));
    assert.equal(result.snippets[0].content.split('\n').length, 3);
  });
});

test('symlinks outside the project or approved directory are rejected without inspecting the destination', async () => {
  await withProject(async (project) => {
    await withProject(async (outside) => {
      await source(outside, 'escape.css', '.target { width: 700px; }');
      await mkdir(path.join(project, 'src'));
      await symlink(outside, path.join(project, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(locateSources(project, candidate('.target')), /escapes/);
      // Remove only the synthetic junction itself; never recurse through its target.
      await rm(path.join(project, 'src', 'escape'), { force: true });
      await source(project, 'unapproved/layout.css', '.target { width: 700px; }');
      await symlink(path.join(project, 'unapproved'), path.join(project, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(locateSources(project, candidate('.target')), /approved/);
      await rm(path.join(project, 'src', 'escape'), { force: true });
    });
  });
});

test('evidence and input candidates remain bounded', async () => {
  await withProject(async (project) => {
    const rules = Array.from({ length: SOURCE_LIMITS.snippets + 10 }, (_, index) => `.target {\n  margin-left: ${index}px;\n}\n`).join('\n');
    await source(project, 'src/layout.css', rules);
    await source(project, 'src/oversized.css', '.target {' + 'x'.repeat(SOURCE_LIMITS.fileBytes) + '}');
    const result = await locateSources(project, candidate('.target'));
    assert.equal(result.truncated, true);
    assert(result.snippets.length <= SOURCE_LIMITS.snippets);
    assert(result.snippets.every((snippet) => Buffer.byteLength(snippet.content) <= SOURCE_LIMITS.snippetBytes));
    assert(result.snippets.every((snippet) => snippet.content.split('\n').length <= SOURCE_LIMITS.snippetLines));
    assert(result.snippets.reduce((sum, snippet) => sum + Buffer.byteLength(snippet.content), 0) <= SOURCE_LIMITS.totalSnippetBytes);
    await assert.rejects(locateSources(project, Array.from({ length: SOURCE_LIMITS.candidates + 1 }, (_, index) => ({ id: `${index}`, selector: '.target', tagName: 'div' }))), /bounds/);
  });
});

test('secret filtering covers token formats, URL credentials and multiline private key material', () => {
  const text = 'Authorization: Bearer synthetic-unit-test-token\npassword="synthetic-password"\nhttps://demo:unit-password@example.test/path?token=synthetic-token\n-----BEGIN PRIVATE KEY-----\nsynthetic-unit-key\n-----END PRIVATE KEY-----';
  const filtered = filterSecrets(text);
  assert.equal(filtered.split('\n').length, text.split('\n').length);
  for (const value of ['synthetic-unit-test-token', 'synthetic-password', 'unit-password', 'synthetic-token', 'synthetic-unit-key']) assert(!filtered.includes(value));
});
