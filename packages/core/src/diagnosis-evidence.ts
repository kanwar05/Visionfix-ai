import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { z } from 'zod';
import { isApprovedSourcePath, locateSources } from './source-locator.js';
import { filterSecrets } from './privacy.js';
import { DocumentMetricsSchema, RectangleSchema, ScanReportSchema, ViewportSchema } from './scan-schema.js';

export const EVIDENCE_LIMITS = Object.freeze({ candidates: 5, reportBytes: 2 * 1024 * 1024,
  imageBytes: 4 * 1024 * 1024, manifestBytes: 512 * 1024, snippets: 20,
  snippetBytes: 16 * 1024, sourceBytes: 64 * 1024, sourceLines: 120 });

export class EvidenceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'EvidenceError'; }
}
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePath = z.string().max(300).refine((value) => !/[\x00-\x1f]/.test(value)
  && isApprovedSourcePath(value), 'Unapproved source path');
const styleKeys = ['display', 'position', 'boxSizing', 'width', 'minWidth', 'maxWidth', 'overflowX',
  'overflowY', 'whiteSpace', 'flexWrap', 'transform', 'marginLeft', 'marginRight'] as const;
const stylesShape = Object.fromEntries(styleKeys.map((key) => [key, z.string().max(500)])) as Record<typeof styleKeys[number], z.ZodString>;
const CandidateSchema = z.object({
  id: z.string().regex(/^candidate-[1-5]$/), selector: z.string().min(1).max(1000), tagName: z.string().min(1).max(64),
  rect: RectangleSchema.strict(), styles: z.object(stylesShape).strict(), viewportWidth: z.number().positive(),
  documentWidth: z.number().positive(), overflowPx: z.number().positive(),
}).strict();
const SnippetSchema = z.object({ id: z.string().min(1).max(100), path: sourcePath,
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  content: z.string().min(1).max(EVIDENCE_LIMITS.snippetBytes), sha256: hashSchema,
}).strict();
const MappingSchema = z.object({ candidateId: z.string().max(100), status: z.enum(['mapped', 'ambiguous', 'unmapped']),
  snippetIds: z.array(z.string().max(100)).max(EVIDENCE_LIMITS.snippets),
  reasons: z.array(z.string().max(500)).max(10),
}).strict();
export const EvidenceManifestSchema = z.object({
  schemaVersion: z.literal('2.0.0'), createdAt: z.string().datetime(), scanId: z.string().uuid(),
  issueId: z.string().min(1).max(100), viewport: ViewportSchema.strict().refine((v) => v.width <= 1440),
  document: DocumentMetricsSchema.strict(), candidates: z.array(CandidateSchema).max(EVIDENCE_LIMITS.candidates),
  mappings: z.array(MappingSchema).max(EVIDENCE_LIMITS.candidates), snippets: z.array(SnippetSchema).max(EVIDENCE_LIMITS.snippets),
  image: z.object({ path: z.literal('screenshot.png'), sha256: hashSchema, bytes: z.number().int().positive().max(EVIDENCE_LIMITS.imageBytes),
    mimeType: z.literal('image/png'), width: z.number().int().positive().max(1440), height: z.literal(900) }).strict(),
  limitations: z.array(z.string().max(1000)).max(30),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (!value.document.hasOverflow && value.candidates.length === 0) fail('No layout evidence');
  if (value.issueId !== `${value.scanId}:${value.viewport.width}`) fail('Issue identity mismatch');
  if (value.image.width !== value.viewport.width) fail('Image viewport mismatch');
  const candidateIds = new Set(value.candidates.map((c) => c.id));
  const snippetIds = new Set(value.snippets.map((s) => s.id));
  if (candidateIds.size !== value.candidates.length || snippetIds.size !== value.snippets.length) fail('Duplicate evidence IDs');
  if (value.mappings.length !== value.candidates.length || new Set(value.mappings.map((m) => m.candidateId)).size !== value.mappings.length) fail('Invalid mappings');
  for (const c of value.candidates) if (c.viewportWidth !== value.viewport.width) fail('Candidate viewport mismatch');
  for (const m of value.mappings) {
    if (!candidateIds.has(m.candidateId) || m.snippetIds.some((id) => !snippetIds.has(id))) fail('Unknown mapping reference');
    if ((m.status === 'unmapped') !== (m.snippetIds.length === 0)) fail('Mapping status mismatch');
  }
  let bytes = 0;
  for (const s of value.snippets) {
    bytes += Buffer.byteLength(s.content);
    const count = s.content.split('\n').length;
    if (s.endLine - s.startLine + 1 !== count || count > EVIDENCE_LIMITS.sourceLines
      || Buffer.byteLength(s.content) > EVIDENCE_LIMITS.snippetBytes || s.sha256 !== digest(s.content)) fail('Invalid reviewed snippet');
  }
  if (bytes > EVIDENCE_LIMITS.sourceBytes) fail('Source evidence exceeds bounds');
});
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
async function contained(root: string, relative: string): Promise<string> {
  const lexical = path.resolve(root, relative);
  if (!inside(root, lexical)) throw new EvidenceError('UNSAFE_PATH', 'Evidence path escapes its approved directory.');
  const resolved = await realpath(lexical).catch(() => { throw new EvidenceError('MISSING_EVIDENCE', 'An evidence file is missing or inaccessible.'); });
  if (!inside(root, resolved)) throw new EvidenceError('UNSAFE_PATH', 'Evidence symlink escapes its approved directory.');
  return resolved;
}
async function boundedRead(file: string, limit: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new EvidenceError('OVERSIZED_EVIDENCE', 'Evidence must be a regular file within its size limit.');
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > limit || total !== info.size) throw new EvidenceError('CHANGED_EVIDENCE', 'Evidence changed while it was being read.');
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError('MISSING_EVIDENCE', 'An evidence file is missing or inaccessible.');
  } finally { await handle?.close(); }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Validate bounded non-interlaced 8-bit RGB/RGBA PNGs produced by the Phase 1 Chromium capture. */
export function validateEvidencePng(image: Buffer, width: number, height: number): void {
  const invalid = () => { throw new EvidenceError('INVALID_IMAGE', 'Screenshot must be a valid bounded Phase 1 PNG matching its viewport.'); };
  if (image.length > EVIDENCE_LIMITS.imageBytes || image.length < 57 || !image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) invalid();
  let offset = 8; let header = false; let ended = false; let channels = 0; const compressed: Buffer[] = [];
  while (offset + 12 <= image.length) {
    const size = image.readUInt32BE(offset); const end = offset + size + 12;
    if (end > image.length) invalid();
    const type = image.toString('ascii', offset + 4, offset + 8); const data = image.subarray(offset + 8, offset + 8 + size);
    if (crc32(image.subarray(offset + 4, offset + 8 + size)) !== image.readUInt32BE(offset + 8 + size)) invalid();
    if (!header && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (header || size !== 13 || data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height
        || width < 1 || width > 1440 || height !== 900 || data[8] !== 8 || ![2, 6].includes(data[9])
        || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) invalid();
      channels = data[9] === 6 ? 4 : 3; header = true;
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') { if (size !== 0 || end !== image.length) invalid(); ended = true; break; }
    // Reject textual/unknown metadata: the preview must not hide extra text beside the visible pixels.
    else if (!['sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type)) invalid();
    offset = end;
  }
  if (!header || !ended || compressed.length === 0) invalid();
  const expected = height * (width * channels + 1);
  let pixels: Buffer;
  try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); } catch { return invalid(); }
  if (pixels.length !== expected) invalid();
  for (let row = 0; row < height; row++) if (pixels[row * (width * channels + 1)] > 4) invalid();
}

export async function prepareDiagnosisEvidence(options: { project: string; report: string }): Promise<{ manifestPath: string; manifest: EvidenceManifest }> {
  const project = await realpath(path.resolve(options.project)).catch(() => { throw new EvidenceError('INVALID_PROJECT', 'Project must be an existing directory.'); });
  if (!(await stat(project)).isDirectory()) throw new EvidenceError('INVALID_PROJECT', 'Project must be an existing directory.');
  const reportPath = await realpath(path.resolve(options.report)).catch(() => { throw new EvidenceError('MISSING_REPORT', 'Scan report is missing or inaccessible.'); });
  const scanDirectory = path.dirname(reportPath);
  if (inside(project, scanDirectory)) throw new EvidenceError('UNSAFE_OUTPUT', 'Evidence output must remain outside the inspected project.');
  let raw: unknown;
  try { raw = JSON.parse((await boundedRead(reportPath, EVIDENCE_LIMITS.reportBytes)).toString('utf8')); }
  catch (error) { if (error instanceof EvidenceError) throw error; throw new EvidenceError('INVALID_REPORT', 'Scan report must contain valid JSON.'); }
  const parsed = ScanReportSchema.safeParse(raw);
  if (!parsed.success) throw new EvidenceError('INVALID_REPORT', 'Scan report does not satisfy the Phase 1 schema.');
  const report = parsed.data;
  const scannedProject = await realpath(report.project.directory).catch(() => '');
  if (scannedProject !== project) throw new EvidenceError('PROJECT_MISMATCH', 'Scan report project does not match the supplied project.');
  const selected = report.results.find((result) => result.status === 'complete' && (result.document?.hasOverflow || result.candidates.length > 0));
  if (!selected?.document || !selected.screenshot) throw new EvidenceError('NO_LAYOUT_EVIDENCE', 'No successfully scanned failing viewport is available. Failed scans are not layout diagnoses.');
  if (selected.screenshot.width !== selected.viewport.width || selected.screenshot.height !== selected.viewport.height) throw new EvidenceError('INVALID_IMAGE', 'Screenshot dimensions do not match the selected viewport.');
  const screenshotPath = await contained(scanDirectory, selected.screenshot.path);
  const image = await boundedRead(screenshotPath, EVIDENCE_LIMITS.imageBytes);
  validateEvidencePng(image, selected.viewport.width, selected.viewport.height);
  const candidates = selected.candidates.slice(0, EVIDENCE_LIMITS.candidates).map(({ kind: _kind, ...candidate }, index) => {
    const styles = Object.fromEntries(styleKeys.map((key) => [key, filterSecrets(candidate.styles[key])])) as z.infer<typeof CandidateSchema>['styles'];
    return { ...candidate, id: `candidate-${index + 1}`, selector: filterSecrets(candidate.selector), tagName: filterSecrets(candidate.tagName), styles };
  });
  const source = await locateSources(project, candidates);
  const manifestInput = {
    schemaVersion: '2.0.0', createdAt: new Date().toISOString(), scanId: report.scanId, issueId: `${report.scanId}:${selected.viewport.width}`,
    viewport: selected.viewport, document: selected.document, candidates, mappings: source.mappings, snippets: source.snippets,
    image: { path: 'screenshot.png', sha256: digest(image), bytes: image.length, mimeType: 'image/png', width: selected.viewport.width, height: selected.viewport.height },
    limitations: [
      'Source locations are heuristic candidates. Model hypotheses are not verified root causes.',
      'Secret filtering cannot guarantee removal of every secret; screenshot pixels are not redacted. Review all content before upload.',
      'Only one completed failing viewport and at most five candidates are included; the screenshot captures the viewport only.',
      'The review digest detects changed local evidence; it is not a signature against an attacker who can replace both evidence and digest.',
      ...(selected.candidates.length > EVIDENCE_LIMITS.candidates || selected.candidatesTruncated ? ['Browser candidates were truncated.'] : []),
      ...(source.truncated ? ['Source search or snippets were truncated.'] : []),
      ...[...new Set(source.warnings.map((warning) => filterSecrets(warning).slice(0, 500)))].slice(0, 20),
    ],
  };
  const valid = EvidenceManifestSchema.safeParse(manifestInput);
  if (!valid.success) throw new EvidenceError('INVALID_EVIDENCE', 'Prepared evidence does not meet the bounded reviewed-evidence schema.');
  const manifest = valid.data;
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > EVIDENCE_LIMITS.manifestBytes) throw new EvidenceError('OVERSIZED_EVIDENCE', 'Evidence manifest exceeds its size limit.');
  const directory = path.join(scanDirectory, `diagnosis-${randomUUID()}`);
  await mkdir(directory);
  await writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' });
  await writeFile(path.join(directory, 'screenshot.png'), image, { flag: 'wx' });
  const manifestPath = path.join(directory, 'manifest.json');
  await writeFile(manifestPath, serialized, { flag: 'wx' });
  await writeFile(path.join(directory, 'review.sha256'), `${digest(serialized)}\n`, { flag: 'wx' });
  return { manifestPath, manifest };
}

export async function loadReviewedEvidence(input: string): Promise<{ manifest: EvidenceManifest; imageBase64: string }> {
  const lexical = path.resolve(input);
  const directory = await realpath(path.dirname(lexical)).catch(() => { throw new EvidenceError('MISSING_EVIDENCE', 'Reviewed evidence directory is missing.'); });
  const manifestPath = await contained(directory, path.basename(lexical));
  if ((await lstat(lexical)).isSymbolicLink()) throw new EvidenceError('UNSAFE_PATH', 'Reviewed manifest must be a regular file, not a symlink.');
  const manifestBytes = await boundedRead(manifestPath, EVIDENCE_LIMITS.manifestBytes);
  const sealPath = await contained(directory, 'review.sha256');
  const seal = (await boundedRead(sealPath, 66)).toString('utf8');
  if (!/^[a-f0-9]{64}\n$/.test(seal) || seal.trim() !== digest(manifestBytes)) throw new EvidenceError('CHANGED_EVIDENCE', 'Reviewed manifest changed. Prepare and review new evidence before upload.');
  let raw: unknown;
  try { raw = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new EvidenceError('INVALID_EVIDENCE', 'Evidence manifest must contain valid JSON.'); }
  const parsed = EvidenceManifestSchema.safeParse(raw);
  if (!parsed.success) throw new EvidenceError('INVALID_EVIDENCE', 'Evidence manifest does not satisfy the bounded evidence schema.');
  const manifest = parsed.data;
  const imagePath = await contained(directory, manifest.image.path);
  const image = await boundedRead(imagePath, EVIDENCE_LIMITS.imageBytes);
  if (image.length !== manifest.image.bytes || digest(image) !== manifest.image.sha256) throw new EvidenceError('CHANGED_EVIDENCE', 'Reviewed screenshot changed. Prepare and review new evidence before upload.');
  validateEvidencePng(image, manifest.image.width, manifest.image.height);
  return { manifest, imageBase64: image.toString('base64') };
}
