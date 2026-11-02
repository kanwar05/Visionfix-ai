import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { filterSecrets } from './privacy.js';
import { isApprovedSourcePath } from './source-locator.js';
import type { SourceReview } from './repair-schema.js';

export const PATCH_LIMITS = Object.freeze({ files: 2, changedLines: 80, diffBytes: 32 * 1024,
  sourceFileBytes: 16 * 1024, totalSourceBytes: 32 * 1024 });
export const PatchProposalSchema = z.object({
  issueId: z.string().min(1).max(200), explanation: z.string().min(1).max(4000),
  unifiedDiff: z.string().min(1).max(PATCH_LIMITS.diffBytes),
  uncertainties: z.array(z.string().min(1).max(1000)).max(12),
}).strict();
export type PatchProposal = z.infer<typeof PatchProposalSchema>;
export interface AppliedCssChange { path: string; beforeSha256: string; afterSha256: string; addedLines: number; removedLines: number }
export interface AppliedCssPatch { changedFiles: AppliedCssChange[]; diff: string }
export class PatchValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PatchValidationError'; }
}
const reject = (code: string, message: string): never => { throw new PatchValidationError(code, message); };
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const validCssPath = (relative: string): boolean => relative.length <= 300 && !/[\x00-\x1f]/.test(relative)
  && isApprovedSourcePath(relative) && relative.endsWith('.css');

interface DiffLine { kind: ' ' | '+' | '-'; text: string; noNewline: boolean }
interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[] }
interface FilePatch { path: string; hunks: Hunk[] }

/** Parse only ordinary modifications of existing text files; no Git execution or fuzzy matching. */
function parseUnifiedDiff(value: string): FilePatch[] {
  if (Buffer.byteLength(value) > PATCH_LIMITS.diffBytes || value.includes('\0') || /\r(?!\n)/.test(value)) {
    return reject('PATCH_LIMIT', 'Unified diff exceeds its supported text bounds.');
  }
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    let gitPath: string | undefined;
    if (lines[index].startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[index++]);
      if (!match || match[1] !== match[2] || !validCssPath(match[1])) return reject('UNAPPROVED_PATH', 'Diff paths must be identical approved relative CSS paths.');
      gitPath = match[1];
      if (lines[index]?.startsWith('index ')) {
        if (!/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100644)?$/.test(lines[index++])) return reject('UNSUPPORTED_DIFF', 'Unsupported diff metadata.');
      }
    }
    const before = /^--- a\/(.+)$/.exec(lines[index++] ?? '');
    const after = /^\+\+\+ b\/(.+)$/.exec(lines[index++] ?? '');
    if (!before || !after || before[1] !== after[1] || !validCssPath(before[1])
      || gitPath !== undefined && gitPath !== before[1]) return reject('UNAPPROVED_PATH', 'Only modifications of identical existing approved CSS paths are supported.');
    if (files.some((file) => file.path === before[1]) || files.length >= PATCH_LIMITS.files) return reject('PATCH_LIMIT', 'Patch has duplicate paths or too many changed files.');
    const file: FilePatch = { path: before[1], hunks: [] };
    while (index < lines.length && lines[index].startsWith('@@ ')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[index++]);
      if (!header) return reject('INVALID_HUNK', 'Invalid unified diff hunk header.');
      const [oldStart, oldCount, newStart, newCount] = [Number(header[1]), Number(header[2] ?? 1), Number(header[3]), Number(header[4] ?? 1)];
      if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)
        || oldCount === 0 && newCount === 0 || oldCount > 0 && oldStart === 0 || newCount > 0 && newStart === 0) {
        return reject('INVALID_HUNK', 'Invalid unified diff line coordinates.');
      }
      const hunk: Hunk = { oldStart, oldCount, newStart, newCount, lines: [] };
      let oldLines = 0; let newLines = 0;
      while (oldLines < oldCount || newLines < newCount) {
        const line = lines[index++];
        if (line === undefined || ![' ', '+', '-'].includes(line[0])) return reject('INVALID_HUNK', 'Hunk line counts do not match the supplied lines.');
        const kind = line[0] as DiffLine['kind'];
        oldLines += kind === '+' ? 0 : 1; newLines += kind === '-' ? 0 : 1;
        if (oldLines > oldCount || newLines > newCount) return reject('INVALID_HUNK', 'Hunk line counts exceed their declared bounds.');
        const entry: DiffLine = { kind, text: line.slice(1), noNewline: false };
        if (lines[index] === '\\ No newline at end of file') { entry.noNewline = true; index++; }
        hunk.lines.push(entry);
      }
      file.hunks.push(hunk);
    }
    if (file.hunks.length === 0) return reject('INVALID_HUNK', 'Each changed file requires at least one exact hunk.');
    files.push(file);
    if (index < lines.length && !lines[index].startsWith('diff --git ') && !lines[index].startsWith('--- a/')) {
      return reject('UNSUPPORTED_DIFF', 'Unsupported metadata, binary data or trailing patch text.');
    }
  }
  if (files.length === 0) return reject('EMPTY_PATCH', 'Patch does not modify any approved CSS file.');
  return files;
}

/** Compare complete resource constructs, including multiline and quoted arguments. */
function resourceFingerprint(css: string): string[] {
  // Escaped identifiers/strings require a complete CSS tokenizer; fail closed in this MVP.
  if (css.includes('\\')) return reject('UNSAFE_CSS', 'Escaped CSS in a patched file is unsupported.');
  let clean = ''; let quote = '';
  for (let index = 0; index < css.length; index++) {
    const character = css[index];
    if (quote) { clean += character; if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; clean += character; continue; }
    if (character === '/' && css[index + 1] === '*') {
      const end = css.indexOf('*/', index + 2);
      if (end < 0) return reject('UNSAFE_CSS', 'Unterminated CSS comments are unsupported.');
      index = end + 1; continue;
    }
    clean += character;
  }
  const constructs = /@import\b|\b(?:url|(?:-webkit-)?image-set|expression)\s*\(|\b(?:behavior|-moz-binding)\s*:/gi;
  const fingerprints: string[] = []; let match: RegExpExecArray | null;
  while ((match = constructs.exec(clean))) {
    const functional = match[0].endsWith('(');
    let depth = functional ? 1 : 0; let innerQuote = ''; let end = constructs.lastIndex;
    for (; end < clean.length; end++) {
      const character = clean[end];
      if (innerQuote) { if (character === innerQuote) innerQuote = ''; continue; }
      if (character === '"' || character === "'") { innerQuote = character; continue; }
      if (character === '(') depth++;
      if (character === ')') { depth--; if (functional && depth === 0) { end++; break; } }
      if (!functional && depth === 0 && character === ';') { end++; break; }
      if (!functional && depth === 0 && character === '}') break;
    }
    if (functional && depth !== 0 || innerQuote) return reject('UNSAFE_CSS', 'Malformed CSS resource constructs are unsupported.');
    // Include the declaration prefix: changing a property/custom-property name can
    // activate an otherwise unchanged URL whose argument itself did not change.
    const declarationStart = Math.max(clean.lastIndexOf(';', match.index - 1), clean.lastIndexOf('{', match.index - 1), clean.lastIndexOf('}', match.index - 1)) + 1;
    fingerprints.push(clean.slice(declarationStart, end)); constructs.lastIndex = end;
  }
  return fingerprints;
}

function applyExact(original: string, file: FilePatch): { content: string; added: number; removed: number } {
  if (/\r(?!\n)/.test(original)) return reject('UNSUPPORTED_SOURCE', 'CSS source uses unsupported line endings.');
  const crlf = original.includes('\r\n');
  if (crlf && original.replace(/\r\n/g, '').includes('\n')) return reject('UNSUPPORTED_SOURCE', 'Mixed CSS source line endings are unsupported.');
  const text = original.replace(/\r\n/g, '\n');
  const ended = text.endsWith('\n');
  const source = text.split('\n'); if (ended) source.pop();
  const output: string[] = [];
  let cursor = 0; let added = 0; let removed = 0; let touchesEnd = false;
  const noNewlinePositions: number[] = [];
  for (const hunk of file.hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < cursor || start > source.length || start + hunk.oldCount > source.length) return reject('EXACT_APPLY_FAILED', 'Hunk source coordinates do not match the reviewed file.');
    output.push(...source.slice(cursor, start)); cursor = start;
    const newStart = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (newStart !== output.length) return reject('EXACT_APPLY_FAILED', 'Hunk destination coordinates do not match exact application.');
    if (!ended && hunk.oldCount === 0 && start === source.length) return reject('EXACT_APPLY_FAILED', 'Appending to a non-terminated final line requires an exact replacement hunk.');
    for (const line of hunk.lines) {
      if (line.text.includes('[REDACTED]')) return reject('REDACTED_CONTEXT', 'Patches cannot rely on or modify redacted source lines.');
      if (line.kind !== '+') {
        if (source[cursor] !== line.text) return reject('EXACT_APPLY_FAILED', 'Hunk content does not match the exact reviewed source lines.');
        const final = cursor === source.length - 1;
        if (line.noNewline !== (final && !ended)) return reject('EXACT_APPLY_FAILED', 'Hunk newline markers do not match the reviewed source.');
        cursor++;
      }
      if (line.kind !== '-') {
        output.push(line.text);
        if (line.noNewline) noNewlinePositions.push(output.length - 1);
      }
      added += line.kind === '+' ? 1 : 0; removed += line.kind === '-' ? 1 : 0;
    }
    touchesEnd ||= cursor === source.length;
  }
  output.push(...source.slice(cursor));
  if (noNewlinePositions.some((position) => position !== output.length - 1) || noNewlinePositions.length > 1) {
    return reject('EXACT_APPLY_FAILED', 'Patch newline markers must identify only the final output line.');
  }
  const newline = noNewlinePositions.length ? false : touchesEnd ? true : ended;
  const content = output.join('\n') + (newline ? '\n' : '');
  if (content.trim() === '' || content === text || added + removed === 0) return reject('EMPTY_PATCH', 'Empty, whole-file deletion and ineffective no-op patches are unsupported.');
  // CSS must not add resource loading or legacy executable CSS capabilities.
  const newCode = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === '+').map((line) => line.text)).join('\n');
  if (/@import\b|(?:url|(?:-webkit-)?image-set|expression)\s*\(|(?:^|[;{\s])(?:behavior|-moz-binding)\s*:/i.test(newCode)
    || /\\(?:[0-9a-f]{1,6}\s?|[^\r\n])/i.test(newCode)) {
    return reject('UNSAFE_CSS', 'New resource loading, escaped CSS and executable legacy CSS are unsupported.');
  }
  if (JSON.stringify(resourceFingerprint(text)) !== JSON.stringify(resourceFingerprint(content))) {
    return reject('UNSAFE_CSS', 'Patch changes an existing CSS resource or executable construct.');
  }
  return { content: crlf ? content.replace(/\n/g, '\r\n') : content, added, removed };
}

async function ownedRoot(workspace: string, runId: string): Promise<string> {
  if (!z.string().uuid().safeParse(runId).success) return reject('UNOWNED_WORKSPACE', 'A valid run identity is required.');
  const root = path.resolve(workspace);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) return reject('UNOWNED_WORKSPACE', 'Patch destination must be a canonical run-owned workspace.');
  const markerPath = path.join(root, '.visionfix-workspace.json');
  const info = await lstat(markerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || info.nlink > 1) return reject('UNOWNED_WORKSPACE', 'Workspace ownership marker is invalid.');
  const marker = z.object({ schemaVersion: z.literal('3.0.0'), runId: z.string().uuid(), originalProject: z.string().min(1),
    runDirectory: z.string().max(2000).refine((value) => path.isAbsolute(value)).optional() })
    .strict().parse(JSON.parse(await readFile(markerPath, 'utf8')));
  if (marker.runId !== runId || !path.isAbsolute(marker.originalProject)
    || path.resolve(marker.originalProject) === root || isInside(path.resolve(marker.originalProject), root)) {
    return reject('UNOWNED_WORKSPACE', 'Workspace does not belong to this repair run or is inside the original project.');
  }
  return root;
}

/** Validate all files before writing, then replace only CSS files in the caller's run-owned copy. */
export async function validateAndApplyCssPatch(options: {
  workspace: string; runId: string; sources: SourceReview[]; proposal: PatchProposal; issueId: string;
}): Promise<AppliedCssPatch> {
  const proposal = PatchProposalSchema.safeParse(options.proposal);
  if (!proposal.success || proposal.data.issueId !== options.issueId) return reject('INVALID_PROPOSAL', 'Patch proposal does not match the reviewed issue and schema.');
  let root: string;
  try { root = await ownedRoot(options.workspace, options.runId); }
  catch (error) { if (error instanceof PatchValidationError) throw error; return reject('UNOWNED_WORKSPACE', 'Run-owned workspace is missing or invalid.'); }
  if (options.sources.length === 0 || options.sources.length > PATCH_LIMITS.files
    || new Set(options.sources.map((source) => source.path)).size !== options.sources.length
    || options.sources.some((source) => !validCssPath(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256)
      || !/^[a-f0-9]{64}$/.test(source.contentSha256) || source.contentSha256 !== hash(source.content)
      || source.startLine !== 1 || source.endLine !== source.content.split('\n').length
      || Buffer.byteLength(source.content) > PATCH_LIMITS.sourceFileBytes || source.bytes > PATCH_LIMITS.sourceFileBytes)
    || options.sources.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0) > PATCH_LIMITS.totalSourceBytes) {
    return reject('INVALID_SOURCE_REVIEW', 'Approved source review does not meet CSS path, hash or size constraints.');
  }
  // Every approved source must still match, even when a proposal touches only one.
  for (const review of options.sources) {
    let current = root;
    for (const segment of review.path.split('/')) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(() => reject('UNAPPROVED_PATH', 'An approved CSS source is missing.'));
      if (info.isSymbolicLink() || !isInside(root, await realpath(current))) return reject('SYMLINK_ESCAPE', 'Approved CSS source paths must not contain symlinks.');
    }
    const info = await lstat(current);
    if (!info.isFile() || info.nlink > 1 || info.size > PATCH_LIMITS.sourceFileBytes) return reject('UNAPPROVED_PATH', 'Approved CSS source must be a bounded regular file without writable links.');
    const bytes = await readFile(current);
    if (bytes.length !== review.bytes || hash(bytes) !== review.sha256) return reject('STALE_SOURCE', 'An approved CSS source no longer matches its reviewed source hash.');
  }
  const parsed = parseUnifiedDiff(proposal.data.unifiedDiff);
  const prepared: Array<{ destination: string; source: Buffer; after: Buffer; result: AppliedCssChange }> = [];
  let totalChanged = 0;
  for (const file of parsed) {
    const review = options.sources.find((source) => source.path === file.path);
    if (!review) return reject('UNAPPROVED_PATH', 'Patch references a file outside the explicitly approved CSS evidence.');
    const destination = path.join(root, file.path);
    if (!isInside(root, destination)) return reject('UNAPPROVED_PATH', 'Patch path escapes its workspace.');
    let current = root;
    for (const segment of file.path.split('/')) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(() => reject('UNAPPROVED_PATH', 'Patch requires an existing regular approved CSS file.'));
      if (info.isSymbolicLink() || !isInside(root, await realpath(current))) return reject('SYMLINK_ESCAPE', 'Patch paths must not contain symlinks.');
    }
    const info = await lstat(destination);
    if (!info.isFile() || info.nlink > 1 || info.size > PATCH_LIMITS.sourceFileBytes) return reject('UNAPPROVED_PATH', 'CSS patch target must be a bounded regular file without writable links.');
    const original = await readFile(destination);
    if (original.length !== review.bytes || hash(original) !== review.sha256) return reject('STALE_SOURCE', 'CSS source no longer matches the reviewed source hash.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original); }
    catch { return reject('UNSUPPORTED_SOURCE', 'CSS source is not valid UTF-8 text.'); }
    if (text.includes('\0') || filterSecrets(text.replace(/\r\n/g, '\n')) !== review.content) return reject('STALE_SOURCE', 'CSS source does not match its reviewed text context.');
    const applied = applyExact(text, file);
    totalChanged += applied.added + applied.removed;
    if (totalChanged > PATCH_LIMITS.changedLines) return reject('PATCH_LIMIT', 'Patch exceeds the changed-line limit.');
    const after = Buffer.from(applied.content);
    if (after.length > PATCH_LIMITS.sourceFileBytes) return reject('PATCH_LIMIT', 'Patched CSS exceeds its source-file size limit.');
    prepared.push({ destination, source: original, after,
      result: { path: file.path, beforeSha256: hash(original), afterSha256: hash(after), addedLines: applied.added, removedLines: applied.removed } });
  }
  for (const file of prepared) {
    const info = await lstat(file.destination);
    if (info.isSymbolicLink() || info.nlink > 1 || hash(await readFile(file.destination)) !== hash(file.source)
      || !isInside(root, await realpath(file.destination))) return reject('STALE_SOURCE', 'Workspace CSS changed before patch application.');
  }
  for (const file of prepared) {
    const temporary = path.join(path.dirname(file.destination), `.visionfix-css-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, file.after, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file.destination);
      if (hash(await readFile(file.destination)) !== file.result.afterSha256) return reject('WRITE_FAILED', 'Patched CSS could not be verified after writing.');
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  return { changedFiles: prepared.map((file) => file.result), diff: proposal.data.unifiedDiff.replace(/\r\n/g, '\n') };
}
