import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  APPLICATION_NAME, APPLICATION_VERSION, CURRENT_PHASE,
  ScanConfigurationError, scanExitCode, scanProject, type ScanReport,
} from '@visionfix/core';

function printHelp(): void {
  console.log(`${APPLICATION_NAME} v${APPLICATION_VERSION}`);
  console.log(`Status: ${CURRENT_PHASE}\n`);
  console.log('Usage: visionfix [--help | --version]');
  console.log('       visionfix scan --project <directory> --url <local-http-url> [--output <directory>]\n');
  console.log('scan: inspect a separately running React + Vite app at 320, 375, 390, 768, 1440 x 900px.');
  console.log('  --project  Existing project directory; only package.json is inspected in an isolated copy.');
  console.log('  --url      HTTP URL on localhost, 127.0.0.1 or [::1], without credentials.');
  console.log('  --output   Parent report directory outside the target project (default: artifacts/scans).');
  console.log('  -h, --help     Print help (also available as scan --help).');
  console.log('  -v, --version  Print application name and version.\n');
  console.log('Exit codes: 0 = complete, no issues; 1 = complete, issues; 2 = invalid or incomplete/failed scan.');
  console.log('Start the target yourself. Scanning does not install dependencies or execute project scripts.');
  console.log('Local URLs are not a network sandbox. Reports/screenshots may contain sensitive information.');
}

export function formatScanSummary(report: ScanReport, reportDirectory: string): string {
  const lines = [`Scan ${report.scanId}: ${report.status}`];
  for (const result of report.results) {
    const prefix = `${result.viewport.width}px`;
    if (result.status === 'failed') {
      lines.push(`  ${prefix}: FAILED (${result.errors.map((error) => error.code).join(', ')})`);
    } else {
      const geometry = result.document!;
      lines.push(`  ${prefix}: document overflow ${geometry.overflowPx}px; ${result.candidates.length} candidate(s)${result.candidatesTruncated ? ' (limited)' : ''}`);
    }
  }
  const failed = report.results.filter((result) => result.status === 'failed').length;
  lines.push(`Failed viewports: ${failed}; scan errors: ${report.errors.length}`);
  lines.push('Candidates are browser evidence, not proven CSS root causes.');
  lines.push(`Report: ${path.join(reportDirectory, 'report.json')}`);
  return lines.join('\n');
}

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.length === 0 || (args.length === 1 && ['--version', '-v'].includes(args[0]))) {
    console.log(`${APPLICATION_NAME} v${APPLICATION_VERSION} (${CURRENT_PHASE})`);
    return;
  }
  if (args[0] !== 'scan') {
    console.error('Unknown command. Run "visionfix --help" for usage.');
    process.exitCode = 2;
    return;
  }
  let values: { project?: string; url?: string; output?: string };
  try {
    const parsed = parseArgs({
      args: args.slice(1),
      options: { project: { type: 'string' }, url: { type: 'string' }, output: { type: 'string' } },
      strict: true, allowPositionals: false, tokens: true,
    });
    const seen = new Set<string>();
    for (const token of parsed.tokens ?? []) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) throw new Error('Duplicate option');
      seen.add(token.name);
    }
    values = parsed.values;
    if (!values.project?.trim() || !values.url?.trim() || values.output?.trim() === '') throw new Error('Missing option');
  } catch {
    console.error('Invalid scan options. Required: --project <directory> --url <local-http-url>; optional: --output <directory>.');
    process.exitCode = 2;
    return;
  }
  try {
    const { report, reportDirectory } = await scanProject({ project: values.project!, url: values.url!, output: values.output });
    console.log(formatScanSummary(report, reportDirectory));
    process.exitCode = scanExitCode(report);
  } catch (error) {
    console.error(error instanceof ScanConfigurationError ? error.message
      : 'Scan could not finish or save a report. Check project/output permissions and the Chromium installation.');
    process.exitCode = 2;
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1]?.endsWith('index.js')) {
  await runCli();
}
