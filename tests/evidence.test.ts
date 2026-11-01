import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { EVIDENCE_LIMITS, EvidenceManifestSchema, loadReviewedEvidence, prepareDiagnosisEvidence, validateEvidencePng } from '../packages/core/dist/diagnosis-evidence.js';
import { SCAN_WIDTHS, type ScanReport } from '../packages/core/dist/scan-schema.js';

// Synthetic PNG/report inputs are unit fixtures, not live browser/model acceptance evidence.
function crc(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const value = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const footer = Buffer.alloc(4); footer.writeUInt32BE(crc(value));
  return Buffer.concat([header, value, footer]);
}
function png(width = 320): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(900, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(900 * (width * 3 + 1)))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'visionfix-evidence-test-'));
  const project = path.join(directory, 'project'); const scans = path.join(directory, 'scan');
  await mkdir(path.join(project, 'src'), { recursive: true }); await mkdir(path.join(scans, 'screenshots'), { recursive: true });
  await writeFile(path.join(project, 'src', 'Panel.tsx'), 'export function Panel() { return <div className="wide-panel">Panel</div>; }\n');
  await writeFile(path.join(project, 'src', 'panel.css'), '.wide-panel {\n  min-width: 700px;\n}\n');
  await writeFile(path.join(scans, 'screenshots', '320.png'), png());
  const now = new Date().toISOString();
  const report: ScanReport = {
    schemaVersion: '1.0.0', scanId: randomUUID(), startedAt: now, finishedAt: now, targetUrl: 'http://127.0.0.1:5180/?token=never-upload-this',
    project: { directory: project, framework: 'react-vite' }, testedViewports: SCAN_WIDTHS.map((width) => ({ width, height: 900, deviceScaleFactor: 1 })),
    tolerancePx: 1, candidateLimit: 20, status: 'complete', errors: [],
    results: SCAN_WIDTHS.map((width) => ({ viewport: { width, height: 900, deviceScaleFactor: 1 }, status: 'complete',
      document: { clientWidth: width, scrollWidth: width === 320 ? 700 : width, overflowPx: width === 320 ? 380 : 0, hasOverflow: width === 320 },
      candidates: width === 320 ? [{ kind: 'candidate-contributor', selector: '.wide-panel', tagName: 'div',
        rect: { x: 0, y: 0, top: 0, right: 700, bottom: 20, left: 0, width: 700, height: 20 },
        styles: { display: 'block', position: 'static', boxSizing: 'border-box', width: '700px', minWidth: '700px', maxWidth: 'none',
          overflowX: 'visible', overflowY: 'visible', whiteSpace: 'normal', flexWrap: 'nowrap', transform: 'none', marginLeft: '0px', marginRight: '0px' },
        viewportWidth: 320, documentWidth: 700, overflowPx: 380 }] : [],
      candidatesTruncated: false, screenshot: { path: `screenshots/${width}.png`, width, height: 900, capture: 'viewport' }, errors: [] })),
  };
  const reportPath = path.join(scans, 'report.json');
  const save = () => writeFile(reportPath, `${JSON.stringify(report)}\n`);
  await save();
  return { directory, project, scans, report, reportPath, save };
}

test('prepare produces reviewed bounded source/browser/image evidence without modifying project/report', async () => {
  const f = await fixture(); const before = await readFile(f.reportPath);
  const result = await prepareDiagnosisEvidence({ project: f.project, report: f.reportPath });
  assert(EvidenceManifestSchema.safeParse(result.manifest).success);
  assert.equal(result.manifest.viewport.width, 320); assert.equal(result.manifest.candidates.length, 1);
  assert(result.manifest.snippets.some((snippet) => snippet.path === 'src/panel.css'));
  assert(!JSON.stringify(result.manifest).includes(f.project));
  assert(!JSON.stringify(result.manifest).includes('never-upload-this'));
  assert.deepEqual(await readFile(f.reportPath), before);
  assert.equal((await loadReviewedEvidence(result.manifestPath)).imageBase64, png().toString('base64'));
  assert(result.manifest.limitations.some((limitation) => limitation.includes('cannot guarantee')));
});

test('healthy reports and failed viewport scans cannot become layout diagnoses', async () => {
  const f = await fixture(); const first = f.report.results[0];
  first.status = 'failed'; first.errors.push({ code: 'NAVIGATION_FAILED', stage: 'navigation', message: 'Failed' });
  f.report.status = 'partial'; await f.save();
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /No successfully scanned failing viewport/);
  first.status = 'complete'; first.errors = []; first.document = { clientWidth: 320, scrollWidth: 320, overflowPx: 0, hasOverflow: false }; first.candidates = [];
  f.report.status = 'complete'; await f.save();
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /No successfully scanned failing viewport/);
});

test('invalid reports, mismatched projects, traversal, missing and oversize screenshots are rejected', async () => {
  const f = await fixture();
  f.report.results[0].screenshot!.path = '../outside.png'; await f.save();
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /Phase 1 schema/);
  f.report.results[0].screenshot!.path = 'screenshots/missing.png'; await f.save();
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /missing or inaccessible/);
  f.report.results[0].screenshot!.path = 'screenshots/320.png'; await f.save();
  await writeFile(path.join(f.scans, 'screenshots', '320.png'), Buffer.alloc(EVIDENCE_LIMITS.imageBytes + 1));
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /size limit/);
  f.report.project.directory = f.directory; await f.save();
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /does not match/);
  await writeFile(f.reportPath, '{}');
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /Phase 1 schema/);
});

test('screenshot directory junction escape is rejected before reading external image', async () => {
  const f = await fixture(); const outside = path.join(f.directory, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, '320.png'), png());
  await symlink(outside, path.join(f.scans, 'escaped'), 'junction');
  f.report.results[0].screenshot!.path = 'escaped/320.png'; await f.save();
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /symlink escapes/);
});

test('manifest and image modifications are detected before upload', async () => {
  const f = await fixture(); const prepared = await prepareDiagnosisEvidence({ project: f.project, report: f.reportPath });
  await writeFile(prepared.manifestPath, `${JSON.stringify(prepared.manifest, null, 2)}\n `);
  await assert.rejects(loadReviewedEvidence(prepared.manifestPath), /manifest changed/);
  const another = await prepareDiagnosisEvidence({ project: f.project, report: f.reportPath });
  await writeFile(path.join(path.dirname(another.manifestPath), 'screenshot.png'), Buffer.from('modified'));
  await assert.rejects(loadReviewedEvidence(another.manifestPath), /screenshot changed/);
});

test('manifest schema independently checks source snippet paths, hashes and line ranges', async () => {
  const f = await fixture(); const { manifest } = await prepareDiagnosisEvidence({ project: f.project, report: f.reportPath });
  assert(manifest.snippets.length > 0);
  const altered = structuredClone(manifest); altered.snippets[0].path = '../.env';
  assert.equal(EvidenceManifestSchema.safeParse(altered).success, false);
  altered.snippets[0].path = 'src/api-token.tsx';
  assert.equal(EvidenceManifestSchema.safeParse(altered).success, false);
  altered.snippets[0].path = 'src/generated/layout.css';
  assert.equal(EvidenceManifestSchema.safeParse(altered).success, false);
  altered.snippets[0].path = manifest.snippets[0].path; altered.snippets[0].endLine += 1;
  assert.equal(EvidenceManifestSchema.safeParse(altered).success, false);
  altered.snippets[0] = { ...manifest.snippets[0], content: 'injected' };
  assert.equal(EvidenceManifestSchema.safeParse(altered).success, false);
});

test('collection is capped at five browser candidates and records truncation', async () => {
  const f = await fixture(); const candidate = f.report.results[0].candidates[0];
  f.report.results[0].candidates = Array.from({ length: 20 }, () => ({ ...candidate })); await f.save();
  const { manifest } = await prepareDiagnosisEvidence({ project: f.project, report: f.reportPath });
  assert.equal(manifest.candidates.length, EVIDENCE_LIMITS.candidates);
  assert(manifest.limitations.some((limitation) => limitation.includes('Browser candidates were truncated')));
});

test('oversized browser styles are rejected rather than silently truncated', async () => {
  const f = await fixture();
  f.report.results[0].candidates[0].styles.transform = 'x'.repeat(501);
  await f.save();
  await assert.rejects(prepareDiagnosisEvidence({ project: f.project, report: f.reportPath }), /bounded reviewed-evidence schema/);
});

test('PNG validation rejects corrupt bytes, truncation and mismatched dimensions', () => {
  validateEvidencePng(png(), 320, 900);
  const corrupted = png(); corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => validateEvidencePng(corrupted, 320, 900), /valid bounded Phase 1 PNG/);
  assert.throws(() => validateEvidencePng(png().subarray(0, 60), 320, 900), /valid bounded Phase 1 PNG/);
  assert.throws(() => validateEvidencePng(png(), 375, 900), /valid bounded Phase 1 PNG/);
  const original = png();
  const withHiddenText = Buffer.concat([original.subarray(0, 33), chunk('tEXt', Buffer.from('Comment\0private hidden metadata')), original.subarray(33)]);
  assert.throws(() => validateEvidencePng(withHiddenText, 320, 900), /valid bounded Phase 1 PNG/);
});
