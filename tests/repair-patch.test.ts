import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateAndApplyCssPatch, PatchValidationError, PATCH_LIMITS, type PatchProposal } from '../packages/core/dist/repair-patch.js';
import type { SourceReview } from '../packages/core/dist/repair-schema.js';

// Deterministic infrastructure proposals only. No model-generated repair is claimed.
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const originalCss = '.card {\n  width: 640px;\n  color: navy;\n}\n';
function sourceReview(content = originalCss, file = 'src/styles.css'): SourceReview {
  const normalized = content.replace(/\r\n/g, '\n');
  return { path: file, sha256: hash(content), bytes: Buffer.byteLength(content), content: normalized,
    contentSha256: hash(normalized), startLine: 1, endLine: normalized.split('\n').length };
}
function proposal(diff = '--- a/src/styles.css\n+++ b/src/styles.css\n@@ -1,4 +1,4 @@\n .card {\n-  width: 640px;\n+  width: 100%;\n   color: navy;\n }\n'): PatchProposal {
  return { issueId: 'infrastructure-issue', explanation: 'Deterministic CSS patch for infrastructure verification.', unifiedDiff: diff, uncertainties: [] };
}
async function fixture(content = originalCss) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'visionfix-patch-test-')));
  const workspace = path.join(directory, 'workspace'); const original = path.join(directory, 'original');
  await mkdir(path.join(workspace, 'src'), { recursive: true }); await mkdir(path.join(original, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src/styles.css'), content); await writeFile(path.join(original, 'src/styles.css'), content);
  const runId = randomUUID();
  await writeFile(path.join(workspace, '.visionfix-workspace.json'), JSON.stringify({ schemaVersion: '3.0.0', runId, originalProject: original }));
  return { directory, workspace, original, runId, sources: [sourceReview(content)], proposal: proposal(), issueId: 'infrastructure-issue' };
}
async function rejected(options: Parameters<typeof validateAndApplyCssPatch>[0], code?: string) {
  await assert.rejects(validateAndApplyCssPatch(options), (error: unknown) => error instanceof PatchValidationError && (!code || error.code === code));
}

test('infrastructure: allowed exact CSS patch modifies only the owned copy and preserves original bytes', async () => {
  const context = await fixture();
  const result = await validateAndApplyCssPatch(context);
  assert.equal(result.changedFiles.length, 1); assert.equal(result.changedFiles[0].addedLines, 1); assert.equal(result.changedFiles[0].removedLines, 1);
  assert.equal(await readFile(path.join(context.workspace, 'src/styles.css'), 'utf8'), originalCss.replace('640px', '100%'));
  assert.equal(await readFile(path.join(context.original, 'src/styles.css'), 'utf8'), originalCss);
  assert.equal(result.changedFiles[0].beforeSha256, hash(originalCss));
});

test('infrastructure: existing CRLF and non-terminated CSS use exact line/newline semantics', async () => {
  const windows = await fixture(originalCss.replace(/\n/g, '\r\n'));
  await validateAndApplyCssPatch(windows);
  assert.equal(await readFile(path.join(windows.workspace, 'src/styles.css'), 'utf8'), originalCss.replace('640px', '100%').replace(/\n/g, '\r\n'));
  const context = await fixture('.card { width: 640px; }');
  context.proposal = proposal('--- a/src/styles.css\n+++ b/src/styles.css\n@@ -1 +1 @@\n-.card { width: 640px; }\n\\ No newline at end of file\n+.card { width: 100%; }\n\\ No newline at end of file\n');
  await validateAndApplyCssPatch(context);
  assert.equal(await readFile(path.join(context.workspace, 'src/styles.css'), 'utf8'), '.card { width: 100%; }');
});

test('infrastructure: invented, absolute, traversal, credential, generated and non-CSS paths are rejected', async (t) => {
  for (const file of ['src/invented.css', '../outside.css', '/absolute.css', 'C:/outside.css', 'src\\styles.css', '.env',
    'package.json', 'src/component.tsx', 'tests/styles.css', 'src/secrets.css', 'src/generated/styles.css']) {
    await t.test(file, async () => {
      const context = await fixture();
      context.proposal = proposal(context.proposal.unifiedDiff.replaceAll('src/styles.css', file));
      await rejected(context); assert.equal(await readFile(path.join(context.workspace, 'src/styles.css'), 'utf8'), originalCss);
    });
  }
});

test('infrastructure: creation, deletion, rename, mode, binary and duplicate file sections are rejected', async (t) => {
  for (const [name, diff] of [
    ['creation', '--- /dev/null\n+++ b/src/styles.css\n@@ -0,0 +1 @@\n+.card {}\n'],
    ['deletion', '--- a/src/styles.css\n+++ /dev/null\n@@ -1 +0,0 @@\n-.card {}\n'],
    ['rename', 'diff --git a/src/styles.css b/src/renamed.css\nsimilarity index 100%\nrename from src/styles.css\nrename to src/renamed.css\n'],
    ['mode', 'diff --git a/src/styles.css b/src/styles.css\nold mode 100644\nnew mode 100755\n'],
    ['binary', 'diff --git a/src/styles.css b/src/styles.css\nGIT binary patch\nliteral 10\nabc\n'],
    ['duplicate', proposal().unifiedDiff + proposal().unifiedDiff],
  ]) await t.test(name, async () => { const context = await fixture(); context.proposal = proposal(diff); await rejected(context); });
});

test('infrastructure: source hashes, issue identity and exact hunk positions/content cannot be bypassed', async (t) => {
  await t.test('stale source', async () => { const context = await fixture(); await writeFile(path.join(context.workspace, 'src/styles.css'), originalCss + '/* changed */\n'); await rejected(context, 'STALE_SOURCE'); });
  await t.test('unchanged-by-diff approved source became stale', async () => {
    const context = await fixture(); context.sources.push(sourceReview(originalCss, 'src/other.css'));
    await writeFile(path.join(context.workspace, 'src/other.css'), originalCss + '/* changed */\n');
    await rejected(context, 'STALE_SOURCE'); assert.equal(await readFile(path.join(context.workspace, 'src/styles.css'), 'utf8'), originalCss);
  });
  await t.test('wrong issue', async () => { const context = await fixture(); context.proposal.issueId = 'invented'; await rejected(context, 'INVALID_PROPOSAL'); });
  await t.test('shifted hunk', async () => { const context = await fixture(); context.proposal.unifiedDiff = context.proposal.unifiedDiff.replace('@@ -1,4 +1,4 @@', '@@ -2,4 +2,4 @@'); await rejected(context, 'EXACT_APPLY_FAILED'); });
  await t.test('wrong context', async () => { const context = await fixture(); context.proposal.unifiedDiff = context.proposal.unifiedDiff.replace('color: navy', 'color: red'); await rejected(context, 'EXACT_APPLY_FAILED'); });
  await t.test('wrong line counts', async () => { const context = await fixture(); context.proposal.unifiedDiff = context.proposal.unifiedDiff.replace('@@ -1,4 +1,4 @@', '@@ -1,3 +1,3 @@'); await rejected(context); });
});

test('infrastructure: workspace ownership, symlink escapes and writable hardlinks are rejected', async (t) => {
  await t.test('wrong run', async () => { const context = await fixture(); context.runId = randomUUID(); await rejected(context, 'UNOWNED_WORKSPACE'); });
  await t.test('original destination', async () => { const context = await fixture(); await writeFile(path.join(context.workspace, '.visionfix-workspace.json'), JSON.stringify({ schemaVersion: '3.0.0', runId: context.runId, originalProject: context.workspace })); await rejected(context, 'UNOWNED_WORKSPACE'); });
  await t.test('directory symlink', async () => {
    const context = await fixture();
    await symlink(path.join(context.original, 'src'), path.join(context.workspace, 'linked'), 'junction');
    context.sources = [sourceReview(originalCss, 'src/styles.css')];
    // An allowed source directory can itself be an escaping junction.
    const second = path.join(context.directory, 'second'); await mkdir(second);
    await writeFile(path.join(second, '.visionfix-workspace.json'), JSON.stringify({ schemaVersion: '3.0.0', runId: context.runId, originalProject: context.original }));
    await symlink(path.join(context.original, 'src'), path.join(second, 'src'), 'junction');
    await rejected({ ...context, workspace: second }, 'SYMLINK_ESCAPE');
  });
  await t.test('hardlink', async () => {
    const context = await fixture(); await link(path.join(context.workspace, 'src/styles.css'), path.join(context.directory, 'shared.css'));
    await rejected(context, 'UNAPPROVED_PATH');
  });
});

test('infrastructure: changes are bounded, unsafe CSS is refused and all files validate before writing', async (t) => {
  await t.test('changed lines', async () => {
    const content = Array.from({ length: 45 }, (_, index) => `.c${index} { width: 640px; }`).join('\n') + '\n';
    const context = await fixture(content);
    context.proposal = proposal(`--- a/src/styles.css\n+++ b/src/styles.css\n@@ -1,45 +1,45 @@\n${content.trimEnd().split('\n').map((line) => '-' + line).join('\n')}\n${content.trimEnd().replaceAll('640px', '100%').split('\n').map((line) => '+' + line).join('\n')}\n`);
    await rejected(context, 'PATCH_LIMIT');
  });
  await t.test('diff bytes', async () => { const context = await fixture(); context.proposal.unifiedDiff += ' '.repeat(PATCH_LIMITS.diffBytes); await rejected(context, 'INVALID_PROPOSAL'); });
  for (const addition of ['  background: url(https://example.invalid/tracker);', '@import "remote.css";', '  width: expression(alert(1));', '  behavior: something;', '  \\77 idth: 100%;']) {
    await t.test('resource/executable CSS', async () => { const context = await fixture(); context.proposal.unifiedDiff = context.proposal.unifiedDiff.replace('+  width: 100%;', '+' + addition); await rejected(context, 'UNSAFE_CSS'); });
  }
  await t.test('second file invalid prevents first write', async () => {
    const context = await fixture(); context.sources.push(sourceReview(originalCss, 'src/other.css'));
    await writeFile(path.join(context.workspace, 'src/other.css'), originalCss);
    context.proposal.unifiedDiff += context.proposal.unifiedDiff.replaceAll('src/styles.css', 'src/other.css').replace('color: navy', 'color: red');
    await rejected(context, 'EXACT_APPLY_FAILED'); assert.equal(await readFile(path.join(context.workspace, 'src/styles.css'), 'utf8'), originalCss);
  });
});

test('infrastructure: multiline resource arguments cannot bypass full CSS resource validation', async (t) => {
  await t.test('changing only a multiline url argument', async () => {
    const content = '.card {\n  background-image: url(\n    "/local.png"\n  );\n}\n';
    const context = await fixture(content);
    context.proposal = proposal('--- a/src/styles.css\n+++ b/src/styles.css\n@@ -3 +3 @@\n-    "/local.png"\n+    "https://example.invalid/remote.png"\n');
    await rejected(context, 'UNSAFE_CSS');
  });
  await t.test('quoted closing parenthesis does not end URL comparison early', async () => {
    const content = '.card { background-image: url("/local).png"); }\n'; const context = await fixture(content);
    context.proposal = proposal('--- a/src/styles.css\n+++ b/src/styles.css\n@@ -1 +1 @@\n-.card { background-image: url("/local).png"); }\n+.card { background-image: url("/local)changed.png"); }\n');
    await rejected(context, 'UNSAFE_CSS');
  });
  await t.test('unchanged resource permits an unrelated supported width repair', async () => {
    const content = originalCss + '.image { background-image: url("/local.png"); }\n';
    const context = await fixture(content); await validateAndApplyCssPatch(context);
    assert.equal(await readFile(path.join(context.workspace, 'src/styles.css'), 'utf8'), content.replace('640px', '100%'));
  });
  await t.test('image-set loading is not an allowed new capability', async () => {
    const context = await fixture(); context.proposal.unifiedDiff = context.proposal.unifiedDiff.replace('+  width: 100%;', '+  background: image-set("https://example.invalid/image" 1x);');
    await rejected(context, 'UNSAFE_CSS');
  });
  await t.test('renaming the declaration cannot activate an unchanged multiline URL', async () => {
    const content = '.card {\n  --unused-image:\n    url("https://example.invalid/image");\n}\n';
    const context = await fixture(content);
    context.proposal = proposal('--- a/src/styles.css\n+++ b/src/styles.css\n@@ -2 +2 @@\n-  --unused-image:\n+  background-image:\n');
    await rejected(context, 'UNSAFE_CSS');
  });
});
