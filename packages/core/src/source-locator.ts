import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { filterSecrets } from './privacy.js';

export const APPROVED_SOURCE_DIRECTORIES = ['src', 'app', 'pages', 'components', 'styles'] as const;
export const SOURCE_LIMITS = {
  candidates: 8, files: 200, entries: 2000, fileBytes: 131072, totalSourceBytes: 1048576,
  snippets: 20, snippetLines: 24, snippetBytes: 4096, totalSnippetBytes: 32768,
} as const;

export interface SourceCandidate { id: string; selector: string; tagName: string }
export interface SourceSnippet {
  id: string; path: string; startLine: number; endLine: number; content: string; sha256: string;
}
export interface SourceMapping {
  candidateId: string; status: 'mapped' | 'ambiguous' | 'unmapped'; snippetIds: string[]; reasons: string[];
}
export interface SourceLocations {
  mappings: SourceMapping[]; snippets: SourceSnippet[]; truncated: boolean; warnings: string[];
}
export class SourceLocationError extends Error {
  constructor(message: string) { super(message); this.name = 'SourceLocationError'; }
}

const excluded = /^(?:\..*|node_modules|vendor|dist|build|out|coverage|artifacts|reports?|test-results|playwright-report|generated|__generated__|secrets?|credentials?)$/i;
const sensitiveName = /(?:^|[._-])(?:env|secrets?|credentials?|tokens?|passwords?|private[-_]?keys?)(?:[._-]|$)|credential|secret|privateKey|accessToken|apiKey/i;
const generatedName = /(?:\.generated\.|\.min\.|\.d\.tsx?$)/i;

export function isApprovedSourcePath(relative: string): boolean {
  const segments = relative.split('/');
  return !relative.includes('\\') && !relative.includes(':') && !relative.includes('\0')
    && segments.length >= 2 && APPROVED_SOURCE_DIRECTORIES.some((directory) => directory === segments[0])
    && segments.every((segment) => segment !== '' && segment !== '..' && segment !== '.'
      && !excluded.test(segment) && !sensitiveName.test(segment))
    && /\.(?:css|jsx|tsx)$/i.test(relative) && !generatedName.test(relative);
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

interface Snapshot { directory: string; files: string[]; truncated: boolean; warnings: string[] }

async function removeSnapshot(directory: string): Promise<void> {
  const expectedParent = await realpath(os.tmpdir());
  const resolved = await realpath(directory);
  if (path.dirname(resolved).toLowerCase() !== expectedParent.toLowerCase()
    || !path.basename(resolved).startsWith('visionfix-source-')) {
    throw new SourceLocationError('Refusing cleanup outside the private source snapshot directory.');
  }
  await rm(resolved, { recursive: true, force: true });
}

/** Copy only bounded approved source into a private snapshot before parsing or matching it. */
async function snapshotSources(projectPath: string): Promise<Snapshot> {
  const root = await realpath(path.resolve(projectPath));
  if (!(await lstat(root)).isDirectory()) throw new SourceLocationError('Source project must be a directory.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'visionfix-source-'));
  const snapshot: Snapshot = { directory, files: [], truncated: false, warnings: [] };
  let entries = 0;
  let bytes = 0;
  try {
    const visit = async (absolute: string, relative: string): Promise<void> => {
      if (++entries > SOURCE_LIMITS.entries || snapshot.files.length >= SOURCE_LIMITS.files) {
        snapshot.truncated = true; return;
      }
      const segments = relative.split('/');
      if (segments.some((part) => excluded.test(part) || sensitiveName.test(part))) return;
      const resolved = await realpath(absolute);
      if (!inside(root, resolved)) throw new SourceLocationError('Source symlink escapes the project root.');
      const approved = path.join(root, segments[0]);
      if (!inside(approved, resolved)) throw new SourceLocationError('Source symlink escapes its approved source directory.');
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        snapshot.warnings.push('An internal source symlink was excluded.'); return;
      }
      if (info.isDirectory()) {
        const children = await opendir(absolute);
        for await (const child of children) {
          if (entries >= SOURCE_LIMITS.entries || snapshot.files.length >= SOURCE_LIMITS.files) { snapshot.truncated = true; break; }
          await visit(path.join(absolute, child.name), `${relative}/${child.name}`);
        }
        return;
      }
      if (!info.isFile() || !isApprovedSourcePath(relative)) return;
      if (info.size > SOURCE_LIMITS.fileBytes || bytes + info.size > SOURCE_LIMITS.totalSourceBytes) {
        snapshot.truncated = true; return;
      }
      // Bound the read even if the source grows concurrently, and parse only the private copy.
      const destination = path.join(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      const source = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let content: Buffer;
      try {
        const buffer = Buffer.alloc(SOURCE_LIMITS.fileBytes + 1);
        const { bytesRead } = await source.read(buffer, 0, buffer.length, 0);
        const current = await lstat(absolute);
        const opened = await source.stat();
        if (bytesRead > SOURCE_LIMITS.fileBytes || bytesRead + bytes > SOURCE_LIMITS.totalSourceBytes
          || !inside(approved, await realpath(absolute)) || current.isSymbolicLink()
          || opened.ino !== current.ino || !opened.isFile()) {
          throw new SourceLocationError('Source changed or exceeded bounds while creating an isolated snapshot.');
        }
        content = buffer.subarray(0, bytesRead);
      } finally { await source.close(); }
      await writeFile(destination, content, { flag: 'wx' });
      bytes += content.length;
      snapshot.files.push(relative);
    };
    for (const approved of APPROVED_SOURCE_DIRECTORIES) {
      try { await visit(path.join(root, approved), approved); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return snapshot;
  } catch (error) {
    await removeSnapshot(directory);
    throw error;
  }
}

interface ElementEvidence {
  line: number; endLine: number; chain: string[]; classes: string[]; id?: string; uncertain: boolean;
}
interface SourceFile { path: string; text: string; lines: string[]; elements: ElementEvidence[] }
interface Hit { file: SourceFile; line: number; endLine: number; reason: string; weak: boolean }

function literalAttribute(attributes: ts.JsxAttributes, name: string): string | undefined {
  const attribute = attributes.properties.find((property): property is ts.JsxAttribute =>
    ts.isJsxAttribute(property) && property.name.getText() === name);
  if (!attribute?.initializer) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression
    && (ts.isStringLiteral(attribute.initializer.expression) || ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression))) {
    return attribute.initializer.expression.text;
  }
  return undefined;
}

function parseElements(file: ts.SourceFile): ElementEvidence[] {
  const elements: ElementEvidence[] = [];
  type Element = ts.JsxElement | ts.JsxSelfClosingElement;
  const isElement = (node: ts.Node): node is Element => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
  const tag = (node: Element): string => (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(file);
  const visitElement = (node: Element, chain: string[], index: number, uncertain: boolean): void => {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const name = tag(node);
    const next = [...chain, `${name}:nth-of-type(${index})`];
    elements.push({
      line: file.getLineAndCharacterOfPosition(opening.getStart(file)).line + 1,
      endLine: file.getLineAndCharacterOfPosition(opening.getEnd()).line + 1,
      chain: next, classes: literalAttribute(opening.attributes, 'className')?.split(/\s+/).filter(Boolean) ?? [],
      id: literalAttribute(opening.attributes, 'id'), uncertain: uncertain || /^[A-Z]/.test(name),
    });
    if (!ts.isJsxElement(node)) return;
    const counts = new Map<string, number>();
    const dynamic = node.children.some((child) => ts.isJsxFragment(child)
      || (ts.isJsxExpression(child) && child.expression !== undefined));
    for (const child of node.children) {
      if (isElement(child)) {
        const childTag = tag(child);
        const count = (counts.get(childTag) ?? 0) + 1;
        counts.set(childTag, count);
        visitElement(child, next, count, uncertain || dynamic || /^[A-Z]/.test(name));
      } else if (ts.isJsxExpression(child) || ts.isJsxFragment(child)) {
        const inspect = (inner: ts.Node): void => {
          if (isElement(inner)) visitElement(inner, [], 1, true);
          else ts.forEachChild(inner, inspect);
        };
        ts.forEachChild(child, inspect);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (isElement(node)) visitElement(node, [], 1, false);
    else ts.forEachChild(node, visit);
  };
  visit(file);
  return elements;
}

function cssHits(files: SourceFile[], classes: Set<string>, ids: Set<string>, weak: boolean): Hit[] {
  const hits: Hit[] = [];
  for (const file of files.filter((source) => source.path.endsWith('.css'))) {
    // Match tokens only in selector preludes, never declarations, comments, or arbitrary file text.
    const clean = file.text.replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\r\n]/g, ' '));
    const rules = /([^{}]+)\{/g;
    let rule: RegExpExecArray | null;
    while ((rule = rules.exec(clean))) {
      const prelude = rule[1];
      if (prelude.trim().startsWith('@')) continue;
      const tokens = [...prelude.matchAll(/([.#])(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)];
      if (!tokens.some((token) => (token[1] === '.' ? classes : ids).has(token[2]))) continue;
      const first = rule.index + prelude.search(/\S/);
      const line = clean.slice(0, first).split('\n').length;
      const closing = clean.indexOf('}', rules.lastIndex);
      const endLine = closing < 0 ? line : clean.slice(0, closing + 1).split('\n').length;
      hits.push({ file, line, endLine, reason: 'A CSS selector matches a supplied or structurally supported class/id.', weak });
    }
  }
  return hits;
}

function findHits(files: SourceFile[], candidate: SourceCandidate): Hit[] {
  const hits: Hit[] = [];
  // The last compound identifies the candidate; ancestor class names must not map an unrelated descendant.
  const compound = candidate.selector.split(/\s*[>+~]\s*|\s+/).at(-1) ?? '';
  const classes = new Set([...compound.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((match) => match[1]));
  const ids = new Set([...compound.matchAll(/#(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((match) => match[1]));
  const moduleClasses = new Set<string>();
  for (const token of classes) {
    const generated = /^_([_a-zA-Z][\w-]*?)_[A-Za-z0-9]{4,}_[0-9]+$/.exec(token)
      ?? /^([_a-zA-Z][\w-]*?)__[A-Za-z0-9]{4,}$/.exec(token);
    if (generated) moduleClasses.add(generated[1]);
  }
  const structural = candidate.selector.split(/\s*>\s*/);
  const validStructural = structural.every((segment) => /^[a-z][\w-]*:nth-of-type\([1-9]\d*\)$/.test(segment));
  for (const file of files) {
    for (const element of file.elements) {
      const literal = element.classes.some((token) => classes.has(token)) || Boolean(element.id && ids.has(element.id));
      const chainMatch = validStructural && element.chain.length >= 3 && element.chain.length <= structural.length
        && element.chain.every((segment, index) => segment === structural[structural.length - element.chain.length + index]);
      if (!literal && !chainMatch) continue;
      hits.push({ file, line: element.line, endLine: element.endLine,
        reason: literal ? 'A JSX literal className/id matches the candidate selector.'
          : 'A static JSX ancestry suffix matches the structural selector; runtime rendering can differ.',
        weak: !literal });
      if (chainMatch) {
        for (const token of element.classes) classes.add(token);
        if (element.id) ids.add(element.id);
      }
    }
  }
  hits.push(...cssHits(files, classes, ids, classes.size === 0 && ids.size === 0 || hits.some((hit) => hit.weak)));
  if (moduleClasses.size) {
    hits.push(...cssHits(files.filter((file) => /\.module\.css$/i.test(file.path)), moduleClasses, new Set(), true)
      .map((hit) => ({ ...hit, reason: 'A CSS module local class resembles a generated runtime class; the transform is not verified.' })));
  }
  return hits;
}

function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export async function locateSources(projectPath: string, candidates: SourceCandidate[]): Promise<SourceLocations> {
  if (candidates.length > SOURCE_LIMITS.candidates || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length
    || candidates.some((candidate) => !candidate.id || candidate.id.length > 200
    || candidate.selector.length > 1000 || !candidate.selector || candidate.tagName.length > 100)) {
    throw new SourceLocationError('Source candidates exceed supported bounds.');
  }
  const snapshot = await snapshotSources(projectPath);
  try {
    const files: SourceFile[] = [];
    for (const relative of snapshot.files) {
      const handle = await open(path.join(snapshot.directory, relative), 'r');
      let text: string;
      try {
        const bytes = Buffer.alloc(SOURCE_LIMITS.fileBytes + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > SOURCE_LIMITS.fileBytes) throw new SourceLocationError('Snapshot file exceeds source bounds.');
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
      } catch (error) {
        if (error instanceof TypeError) { snapshot.warnings.push('A non-UTF-8 source file was excluded.'); continue; }
        throw error;
      } finally { await handle.close(); }
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text) || /@generated|DO NOT EDIT|AUTO[- ]GENERATED/i.test(text.slice(0, 1000))) {
        snapshot.warnings.push('A binary or generated source file was excluded.'); continue;
      }
      text = text.replace(/\r\n?/g, '\n');
      const syntax = /\.(?:jsx|tsx)$/i.test(relative)
        ? ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX) : undefined;
      files.push({ path: relative, text, lines: text.split('\n'), elements: syntax ? parseElements(syntax) : [] });
    }
    const result: SourceLocations = { mappings: [], snippets: [], truncated: snapshot.truncated, warnings: [...new Set(snapshot.warnings)] };
    let snippetBytes = 0;
    const seen = new Map<string, SourceSnippet>();
    for (const candidate of candidates) {
      const hits = findHits(files, candidate);
      const snippetIds: string[] = [];
      for (const hit of hits) {
        const startLine = Math.max(1, hit.line - 2);
        const endLine = Math.min(hit.file.lines.length, Math.max(hit.line + 5, hit.endLine + 1), startLine + SOURCE_LIMITS.snippetLines - 1);
        const key = `${hit.file.path}:${startLine}:${endLine}`;
        let snippet = seen.get(key);
        if (!snippet) {
          const content = filterSecrets(hit.file.lines.slice(startLine - 1, endLine).join('\n'));
          const bytes = Buffer.byteLength(content);
          if (bytes > SOURCE_LIMITS.snippetBytes || snippetBytes + bytes > SOURCE_LIMITS.totalSnippetBytes
            || result.snippets.length >= SOURCE_LIMITS.snippets) { result.truncated = true; continue; }
          snippet = { id: `source-${hash(key).slice(0, 16)}`, path: hit.file.path, startLine, endLine, content, sha256: hash(content) };
          seen.set(key, snippet); result.snippets.push(snippet); snippetBytes += bytes;
        }
        if (!snippetIds.includes(snippet.id)) snippetIds.push(snippet.id);
      }
      const jsxHits = hits.filter((hit) => !hit.file.path.endsWith('.css'));
      const cssHitsOnly = hits.filter((hit) => hit.file.path.endsWith('.css'));
      const ambiguous = hits.some((hit) => hit.weak) || jsxHits.length > 1 || cssHitsOnly.length > 1 || result.truncated;
      result.mappings.push({
        candidateId: candidate.id, status: snippetIds.length === 0 ? 'unmapped' : ambiguous ? 'ambiguous' : 'mapped', snippetIds,
        reasons: snippetIds.length === 0 ? ['No supported selector or static JSX ancestry match in the bounded approved sources.']
          : [...new Set(hits.map((hit) => hit.reason)), ...(ambiguous ? ['Multiple matches, structural inference, or collection limits prevent a unique verified mapping.'] : [])],
      });
    }
    if (result.truncated) result.warnings.push('Source collection or snippets reached a documented bound; missing evidence is possible.');
    return result;
  } finally {
    // The only recursive removal is our mkdtemp-owned private snapshot, never the inspected project.
    await removeSnapshot(snapshot.directory);
  }
}
