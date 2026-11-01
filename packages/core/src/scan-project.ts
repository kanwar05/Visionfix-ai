import { copyFile, lstat, mkdtemp, readFile, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectMetadata } from './scan-schema.js';

export class ScanConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanConfigurationError';
  }
}

/** This restricts navigation, not subresources or the target application's network. */
export function validateLocalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ScanConfigurationError('Target URL must be an absolute local HTTP URL.');
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new ScanConfigurationError('Only HTTP URLs on localhost, 127.0.0.1, or [::1] are supported.');
  }
  if (url.username || url.password) {
    throw new ScanConfigurationError('Target URLs containing credentials are forbidden.');
  }
  return url.href;
}

/** Copy only package.json into a temporary inspection workspace; never collect sources or .env. */
export async function validateProject(input: string): Promise<ProjectMetadata> {
  let directory: string;
  try {
    directory = await realpath(path.resolve(input));
    if (!(await stat(directory)).isDirectory()) throw new Error();
  } catch {
    throw new ScanConfigurationError('Project path must resolve to an existing directory.');
  }
  const manifest = path.join(directory, 'package.json');
  try {
    const info = await lstat(manifest);
    if (!info.isFile() || info.size > 1_048_576) throw new Error();
  } catch {
    throw new ScanConfigurationError('Project requires a regular package.json file of at most 1 MiB.');
  }

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'visionfix-inspect-'));
  const snapshot = path.join(workspace, 'package.json');
  let packageJson: unknown;
  try {
    await copyFile(manifest, snapshot, constants.COPYFILE_EXCL);
    const content = await readFile(snapshot, 'utf8');
    try {
      packageJson = JSON.parse(content);
    } catch {
      throw new ScanConfigurationError('Project package.json must contain valid JSON.');
    }
  } finally {
    await unlink(snapshot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(workspace);
  }

  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new ScanConfigurationError('Project package.json must contain a JSON object.');
  }
  const record = packageJson as Record<string, unknown>;
  const hasDependency = (name: string): boolean => ['dependencies', 'devDependencies'].some((key) => {
    const dependencies = record[key];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return false;
    const value = (dependencies as Record<string, unknown>)[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
  const missing = ['react', 'vite'].filter((name) => !hasDependency(name));
  if (missing.length) {
    throw new ScanConfigurationError(`Unsupported project: package.json must declare ${missing.join(' and ')} in dependencies or devDependencies.`);
  }
  return { directory, framework: 'react-vite' };
}
