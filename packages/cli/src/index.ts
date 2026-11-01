import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  APPLICATION_NAME, APPLICATION_VERSION, CURRENT_PHASE,
  ScanConfigurationError, scanExitCode, scanProject, type ScanReport,
  prepareDiagnosisEvidence, runDiagnosis, EvidenceError, SourceLocationError, type EvidenceManifest,
} from '@visionfix/core';

function printHelp(): void {
  console.log(`${APPLICATION_NAME} v${APPLICATION_VERSION}`);
  console.log(`Status: ${CURRENT_PHASE}\n`);
  console.log('Usage: visionfix [--help | --version]');
  console.log('       visionfix scan --project <directory> --url <local-http-url> [--output <directory>]\n');
  console.log('       visionfix diagnose --project <directory> --report <report.json> --prepare');
  console.log('       visionfix diagnose --evidence <manifest.json> --allow-model-upload\n');
  console.log('diagnose: prepare bounded local evidence, review manifest.json and screenshot.png, then explicitly upload.');
  console.log('  Preparation never loads API configuration or contacts a model.');
  console.log('  Upload verifies the evidence seal and image before sending. Secret filtering is incomplete.');
  console.log('  Diagnosis exit codes: 0 = success (may be uncertain/unmapped); 2 = failed/invalid; 3 = blocked.\n');
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
  if (args[0] === 'diagnose') {
    await runDiagnose(args.slice(1));
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

function evidenceSummary(manifest: EvidenceManifest, manifestPath: string): string {
  const lines = [
    `SUCCESS: prepared ${manifest.issueId} at ${manifest.viewport.width}px. No API request made.`,
    `Review: ${manifestPath}`,
    `Image: ${path.join(path.dirname(manifestPath), manifest.image.path)}`,
    `Evidence: ${manifest.candidates.length} candidate(s), ${manifest.snippets.length} snippet(s).`,
  ];
  for (const mapping of manifest.mappings) {
    lines.push(`  ${mapping.candidateId}: ${mapping.status}; ${mapping.snippetIds.join(', ') || 'no source mapping'}`);
  }
  lines.push('Review all snippets and the image before using --allow-model-upload.');
  lines.push('Filtering cannot guarantee removal of every secret or sensitive image detail.');
  return lines.join('\n');
}

async function runDiagnose(args: string[]): Promise<void> {
  let values: { project?: string; report?: string; prepare?: boolean; evidence?: string; 'allow-model-upload'?: boolean };
  try {
    const parsed = parseArgs({ args, options: {
      project: { type: 'string' }, report: { type: 'string' }, prepare: { type: 'boolean' },
      evidence: { type: 'string' }, 'allow-model-upload': { type: 'boolean' },
    }, strict: true, allowPositionals: false, tokens: true });
    const seen = new Set<string>();
    for (const token of parsed.tokens ?? []) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) throw new Error();
      seen.add(token.name);
    }
    values = parsed.values;
    if (values.prepare) {
      if (!values.project?.trim() || !values.report?.trim() || values.evidence !== undefined || values['allow-model-upload'] !== undefined) throw new Error();
    } else if (!values.evidence?.trim() || values.project !== undefined || values.report !== undefined || values.prepare !== undefined) {
      throw new Error();
    }
  } catch {
    console.error('FAILED: invalid diagnosis options. Use --project <path> --report <report.json> --prepare, or --evidence <manifest.json> --allow-model-upload.');
    process.exitCode = 2;
    return;
  }
  try {
    if (values.prepare) {
      const prepared = await prepareDiagnosisEvidence({ project: values.project!, report: values.report! });
      console.log(evidenceSummary(prepared.manifest, prepared.manifestPath));
      process.exitCode = 0;
      return;
    }
    const result = await runDiagnosis({ evidence: values.evidence!, allowModelUpload: values['allow-model-upload'] === true });
    console.log(`${result.status.toUpperCase()}: ${result.code}. ${result.message}`);
    if (result.diagnosis) {
      const diagnosis = result.diagnosis;
      console.log(`${diagnosis.issueId} (${diagnosis.viewportWidth}px): ${diagnosis.status}`);
      console.log(diagnosis.explanation);
      for (const source of diagnosis.sources) console.log(`  ${source.path}:${source.startLine}-${source.endLine} (${source.snippetId})`);
      console.log(`Suggested approach: ${diagnosis.repairApproach}`);
      for (const uncertainty of [...diagnosis.uncertainties, ...diagnosis.missingEvidence]) console.log(`  Limitation: ${uncertainty}`);
    }
    for (const limitation of result.limitations) console.log(`  Limitation: ${limitation}`);
    process.exitCode = result.status === 'success' ? 0 : result.status === 'blocked' ? 3 : 2;
  } catch (error) {
    console.error(error instanceof EvidenceError ? `FAILED: ${error.code}. ${error.message}`
      : error instanceof SourceLocationError ? `FAILED: SOURCE_LOCATION_ERROR. ${error.message}`
        : 'FAILED: diagnosis evidence could not be prepared or verified. Check the schema, evidence bounds, containment and file permissions. No target files were modified.');
    process.exitCode = 2;
  }
}

if (import.meta.url.startsWith('file:') && process.argv[1]?.endsWith('index.js')) {
  await runCli();
}
