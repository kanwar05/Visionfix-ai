import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class RepairExecutionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RepairExecutionError'; }
}
export const REPAIR_WORKSPACE_LIMITS = Object.freeze({
  sourceFiles: 2000, sourceBytes: 32 * 1024 * 1024, sourceFileBytes: 4 * 1024 * 1024,
  dependencyFiles: 30000, dependencyBytes: 400 * 1024 * 1024, dependencyFileBytes: 32 * 1024 * 1024,
});
const excluded = /^(?:\..*|node_modules|vendor|dist|build|out|coverage|artifacts|reports?|test-results|playwright-report|generated|__generated__|tests?|secrets?|credentials?)$/i;
const sensitive = /(?:^|[._-])(?:env|secrets?|credentials?|tokens?|passwords?|private[-_]?keys?)(?:[._-]|$)|credential|secret|privateKey|accessToken|apiKey/i;
const dependencySecretFile = /^(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini|txt))?$|private[-_]?key\.(?:pem|key)$|\.env(?:\.|$)/i;
const sourceExtension = /\.(?:css|tsx?|jsx?|mjs|cjs|json|html?|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|map)$/i;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const inside = (parent: string, candidate: string) => {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

async function directory(input: string, code: string): Promise<string> {
  try { const resolved = await realpath(path.resolve(input)); if (!(await lstat(resolved)).isDirectory()) throw new Error(); return resolved; }
  catch { throw new RepairExecutionError(code, 'An approved project, output or dependency directory is unavailable.'); }
}

/** Copy current disk state and existing dependencies as separate regular files; never install or link. */
export async function createRepairWorkspace(options: {
  project: string; runDirectory: string; dependencyDirectory: string; runId: string;
}): Promise<{ directory: string; sourceHashes: Array<{ path: string; sha256: string }>; dependencyFiles: number }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.runId)) {
    throw new RepairExecutionError('INVALID_RUN', 'A valid run identifier is required.');
  }
  const project = await directory(options.project, 'INVALID_PROJECT');
  const runDirectory = await directory(options.runDirectory, 'INVALID_OUTPUT');
  if (inside(project, runDirectory)) throw new RepairExecutionError('UNSAFE_WORKSPACE', 'The repair workspace must remain outside the target project.');
  const dependencies = await directory(options.dependencyDirectory, 'DEPENDENCIES_UNAVAILABLE');
  // React/Vite are required; the tool never resolves a missing dependency by installing it.
  for (const entry of ['react/package.json', 'vite/package.json', 'vite/bin/vite.js']) {
    try {
      let ancestor = dependencies;
      for (const segment of entry.split('/')) {
        ancestor = path.join(ancestor, segment);
        if ((await lstat(ancestor)).isSymbolicLink()) throw new Error();
      }
      const resolved = await realpath(path.join(dependencies, entry));
      if (!inside(dependencies, resolved) || !(await lstat(resolved)).isFile()) throw new Error();
    } catch { throw new RepairExecutionError('DEPENDENCIES_UNAVAILABLE', 'Existing React and Vite dependencies must be supplied in the reviewed dependency directory. No installation was attempted.'); }
  }
  const reservation = path.join(runDirectory, 'workspace-location.json');
  try { await writeFile(reservation, JSON.stringify({ runId: options.runId, state: 'creating' }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch { throw new RepairExecutionError('WORKSPACE_EXISTS', 'The run already owns a working copy; it was not overwritten.'); }
  // Native Windows process startup has stricter cwd limits than Node filesystem I/O.
  // Keep physical copies short regardless of how deeply the evidence is nested.
  const workspace = await mkdtemp(path.join(await realpath(os.tmpdir()), `vfx-${options.runId.slice(0, 8)}-`));
  if (inside(project, workspace) || process.platform === 'win32' && workspace.length > 180) {
    throw new RepairExecutionError('UNSAFE_WORKSPACE', 'A short working copy outside the target could not be created. Use a shorter OS temporary directory.');
  }
  const sourceHashes: Array<{ path: string; sha256: string }> = [];
  const copy = async (origin: string, target: string, dependency: boolean): Promise<number> => {
    let files = 0; let bytes = 0; let entries = 0;
    const maxFiles = dependency ? REPAIR_WORKSPACE_LIMITS.dependencyFiles : REPAIR_WORKSPACE_LIMITS.sourceFiles;
    const maxBytes = dependency ? REPAIR_WORKSPACE_LIMITS.dependencyBytes : REPAIR_WORKSPACE_LIMITS.sourceBytes;
    const maxFile = dependency ? REPAIR_WORKSPACE_LIMITS.dependencyFileBytes : REPAIR_WORKSPACE_LIMITS.sourceFileBytes;
    const visit = async (relative: string): Promise<void> => {
      if (++entries > maxFiles * 2) throw new RepairExecutionError('COPY_LIMIT', 'Project or dependency traversal exceeded its documented limit.');
      const absolute = path.join(origin, relative);
      const segments = relative.split('/');
      const name = segments.at(-1)!;
      if ((!dependency && sensitive.test(name)) || name.startsWith('.') || (!dependency && excluded.test(name))
        || (dependency && ['.bin', '.cache', '.vite'].includes(name))) return;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        if (dependency) return; // npm workspace aliases are unnecessary and must never remain writable links.
        const destination = await realpath(absolute);
        if (!inside(origin, destination)) throw new RepairExecutionError('SYMLINK_ESCAPE', 'A source symlink escapes the approved project.');
        throw new RepairExecutionError('UNSUPPORTED_SYMLINK', 'Source symlinks are unsupported for isolated repair. No link was copied.');
      }
      const canonical = await realpath(absolute);
      if (!inside(origin, canonical)) throw new RepairExecutionError('SYMLINK_ESCAPE', 'A source or dependency path escapes its approved directory.');
      if (info.isDirectory()) {
        await mkdir(path.join(target, relative), { recursive: true });
        for (const child of (await readdir(absolute)).sort()) await visit(relative ? `${relative}/${child}` : child);
        return;
      }
      if (dependency && dependencySecretFile.test(name)) return;
      if (!info.isFile() || (!dependency && (!sourceExtension.test(name) || /\.generated\.|\.min\./i.test(name)))) return;
      if (info.size > maxFile || ++files > maxFiles || bytes + info.size > maxBytes) throw new RepairExecutionError('COPY_LIMIT', 'Source or dependency bytes exceeded a documented isolation limit.');
      const handle = await open(absolute, 'r');
      let content: Buffer;
      try {
        const opened = await handle.stat();
        const buffer = Buffer.alloc(Math.min(maxFile + 1, opened.size + 1));
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const current = await lstat(absolute);
        if (!opened.isFile() || opened.ino !== current.ino || current.isSymbolicLink() || length !== opened.size
          || length > maxFile || bytes + length > maxBytes || !inside(origin, await realpath(absolute))) {
          throw new RepairExecutionError('SOURCE_CHANGED', 'Source or dependencies changed during isolated copying.');
        }
        content = buffer.subarray(0, length);
      } finally { await handle.close(); }
      const destination = path.join(target, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: 'wx', mode: info.mode & 0o777 });
      bytes += content.length;
      if (!dependency) sourceHashes.push({ path: relative, sha256: hash(content) });
    };
    for (const child of (await readdir(origin)).sort()) await visit(child);
    return files;
  };
  await copy(project, workspace, false);
  const dependencyFiles = await copy(dependencies, path.join(workspace, 'node_modules'), true);
  await writeFile(path.join(workspace, '.visionfix-workspace.json'), JSON.stringify({ schemaVersion: '3.0.0', runId: options.runId, originalProject: project, runDirectory }) + '\n', { flag: 'wx' });
  await writeFile(reservation, JSON.stringify({ schemaVersion: '3.0.0', runId: options.runId, directory: workspace }) + '\n', { mode: 0o600 });
  return { directory: workspace, sourceHashes, dependencyFiles };
}

export async function requireRepairWorkspace(input: string): Promise<string> {
  const workspace = await directory(input, 'INVALID_WORKSPACE');
  try {
    const markerPath = path.join(workspace, '.visionfix-workspace.json');
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error();
    const handle = await open(markerPath, 'r'); let marker: unknown;
    try { marker = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
    if (!marker || typeof marker !== 'object') throw new Error();
    const value = marker as Record<string, unknown>;
    if (value.schemaVersion !== '3.0.0' || typeof value.runId !== 'string' || typeof value.originalProject !== 'string'
      || inside(await realpath(value.originalProject), workspace)) throw new Error();
    return workspace;
  } catch { throw new RepairExecutionError('INVALID_WORKSPACE', 'Execution requires a separate run-owned workspace marker.'); }
}
