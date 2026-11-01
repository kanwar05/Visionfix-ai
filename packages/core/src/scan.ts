import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanBrowser } from './browser-scan.js';
import { ScanConfigurationError, validateLocalUrl, validateProject } from './scan-project.js';
import {
  CANDIDATE_LIMIT, OVERFLOW_TOLERANCE_PX, SCAN_WIDTHS, ScanReportSchema, VIEWPORT_HEIGHT,
  type ScanReport,
} from './scan-schema.js';

export interface ScanOptions {
  project: string;
  url: string;
  /** Parent output directory; every scan creates a new UUID subdirectory. */
  output?: string;
}

// Resolve existing ancestors before creating directories, including junctions/symlinks.
async function canonicalOutputDirectory(input: string): Promise<string> {
  let ancestor = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(ancestor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function scanHasIssues(report: ScanReport): boolean {
  return report.results.some((result) => result.document?.hasOverflow || result.candidates.length > 0);
}

export function scanExitCode(report: ScanReport): 0 | 1 | 2 {
  if (report.status !== 'complete') return 2;
  return scanHasIssues(report) ? 1 : 0;
}

export async function scanProject(options: ScanOptions): Promise<{ report: ScanReport; reportDirectory: string }> {
  const targetUrl = validateLocalUrl(options.url);
  const project = await validateProject(options.project);
  const outputBase = await canonicalOutputDirectory(options.output ?? path.join('artifacts', 'scans'));
  const relative = path.relative(project.directory, outputBase);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new ScanConfigurationError('Output directory must be outside the inspected project directory.');
  }
  const scanId = randomUUID();
  const startedAt = new Date().toISOString();
  const reportDirectory = path.join(outputBase, scanId);
  await mkdir(reportDirectory, { recursive: true });
  // Custom output locations are ignored too, without changing the developer's .gitignore.
  await writeFile(path.join(reportDirectory, '.gitignore'), '*\n', { flag: 'wx' });
  const { results, errors } = await scanBrowser(targetUrl, reportDirectory);
  const complete = results.filter((result) => result.status === 'complete').length;
  const report = ScanReportSchema.parse({
    schemaVersion: '1.0.0', scanId, startedAt, finishedAt: new Date().toISOString(),
    targetUrl, project,
    testedViewports: SCAN_WIDTHS.map((width) => ({ width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 })),
    tolerancePx: OVERFLOW_TOLERANCE_PX, candidateLimit: CANDIDATE_LIMIT,
    status: complete === 0 ? 'failed' : complete === SCAN_WIDTHS.length && errors.length === 0 ? 'complete' : 'partial',
    results, errors,
  });
  await writeFile(path.join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return { report, reportDirectory };
}
