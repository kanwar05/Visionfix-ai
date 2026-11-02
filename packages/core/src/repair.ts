import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { loadMetaConfig, type MetaConfig } from './config.js';
import { captureRepairContent, compareRepairContent, RepairContentResultSchema } from './repair-browser.js';
import { checkRepairPort, runRepairBuild, startRepairServer } from './repair-execution.js';
import { checkRepairModelSupport, generateRepairProposal } from './repair-model.js';
import { PatchProposalSchema, PatchValidationError, validateAndApplyCssPatch, type PatchProposal } from './repair-patch.js';
import { loadRepairPlan, readRepairFile, repairCssFile, repairHash, repairInside } from './repair-plan.js';
import { RepairError } from './repair-schema.js';
import { createRepairWorkspace, RepairExecutionError } from './repair-workspace.js';
import { scanProject } from './scan.js';
import { ScanReportSchema, type ScanReport } from './scan-schema.js';
import { filterSecrets } from './privacy.js';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RelativePathSchema = z.string().min(1).max(1000).refine((value) => !value.includes('\\') && !value.includes(':')
  && !value.startsWith('/') && value.split('/').every((part) => part !== '..' && part !== '' && part !== '.'));
const BuildResultSchema = z.object({ phase: z.enum(['baseline', 'after']), success: z.boolean(),
  exitCode: z.number().int().nullable(), timedOut: z.boolean(), logPath: RelativePathSchema, durationMs: z.number().nonnegative() }).strict();
const BrowserResultSchema = z.object({ report: ScanReportSchema, reportDirectory: RelativePathSchema,
  content: RepairContentResultSchema }).strict();
export const RepairReportSchema = z.object({
  schemaVersion: z.literal('3.0.0'), runId: z.string().uuid(), issueId: z.string().min(1).max(100),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  status: z.enum(['verified', 'rejected', 'blocked', 'inconclusive', 'failed']), code: z.string().min(1).max(100),
  reasons: z.array(z.string().max(1000)).min(1).max(30),
  inputs: z.object({ planSha256: HashSchema, evidenceSha256: HashSchema, imageSha256: HashSchema,
    diagnosisSha256: HashSchema, configSha256: HashSchema,
    sourceHashes: z.array(z.object({ path: RelativePathSchema, sha256: HashSchema }).strict()).max(2),
  }).strict(),
  model: z.object({ kind: z.enum(['none', 'meta', 'deterministic-test']), provider: z.string().max(200).nullable(),
    identifier: z.string().max(200).nullable(), requestMade: z.boolean() }).strict(),
  sourceSnapshot: z.array(z.object({ path: RelativePathSchema, sha256: HashSchema }).strict()).max(2000),
  workspace: z.string().max(2000).refine((value) => path.isAbsolute(value)).nullable(), dependencyFiles: z.number().int().nonnegative(),
  proposal: PatchProposalSchema.nullable(), patch: z.object({ path: z.literal('proposal.diff'), sha256: HashSchema,
    changedFiles: z.array(z.object({ path: RelativePathSchema, beforeSha256: HashSchema, afterSha256: HashSchema,
      addedLines: z.number().int().nonnegative(), removedLines: z.number().int().nonnegative() }).strict()).max(2),
  }).strict().nullable(),
  builds: z.array(BuildResultSchema).max(2), baseline: BrowserResultSchema.nullable(), verification: BrowserResultSchema.nullable(),
  verificationUrls: z.array(z.string().regex(/^http:\/\/127\.0\.0\.1:\d+\/$/)).max(2),
  originalSourcesUnchanged: z.boolean().nullable(),
  cleanup: z.object({ serverStopped: z.boolean(), workspacePatchReverted: z.boolean().nullable(), errors: z.array(z.string().max(200)).max(10) }).strict(),
  limitations: z.array(z.string().max(1000)).max(20),
}).strict().superRefine((report, context) => {
  if (report.status === 'verified' && (!report.patch || !report.baseline || !report.verification
    || report.builds.length !== 2 || report.builds.some((build) => !build.success)
    || !report.originalSourcesUnchanged || !report.cleanup.serverStopped || report.cleanup.errors.length > 0
    || report.baseline.report.status !== 'complete' || report.verification.report.status !== 'complete'
    || geometryReasons(report.baseline.report, report.verification.report, Number(report.issueId.split(':').at(-1))).length > 0
    || !report.baseline.content.results.some((result) => result.evidenceBinding.required && result.evidenceBinding.matched)
    || !compareRepairContent(report.baseline.content, report.verification.content).passed)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Verified reports require successful independent checks, cleanup and source preservation.' });
  }
});
export type RepairReport = z.infer<typeof RepairReportSchema>;
export interface RunRepairOptions {
  plan: string; allowModelUpload: boolean; allowProjectExecution: boolean; config?: MetaConfig;
  /** Infrastructure tests only: no CLI option or mocked production fallback. Always labeled in the report. */
  testProposal?: { kind: 'deterministic-infrastructure-test'; proposal: PatchProposal };
}
export interface RepairRunResult {
  status: RepairReport['status']; code: string; message: string; reportPath?: string; report?: RepairReport;
}
class StopRepair extends Error {
  constructor(public readonly status: RepairReport['status'], public readonly code: string, message: string) { super(message); }
}
const stop = (status: RepairReport['status'], code: string, message: string): never => { throw new StopRepair(status, code, message); };
const relative = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');
function geometryReasons(baseline: ScanReport, after: ScanReport, failingWidth: number): string[] {
  const reasons: string[] = [];
  if (after.status !== 'complete') reasons.push('A required Phase 1 viewport or screenshot failed.');
  for (const current of after.results) {
    const previous = baseline.results.find((result) => result.viewport.width === current.viewport.width)!;
    if (current.status !== 'complete' || !current.document) continue;
    if (current.viewport.width === failingWidth && (current.document.hasOverflow || current.candidates.length > 0)) reasons.push('The original failing viewport still contains overflow candidates.');
    if (current.document.overflowPx > (previous.document?.overflowPx ?? 0) + 1) reasons.push(`Document overflow increased at ${current.viewport.width}px.`);
    if (current.candidates.some((candidate) => {
      const original = previous.candidates.find((item) => item.selector === candidate.selector);
      return !original || candidate.overflowPx > original.overflowPx + 1;
    })) reasons.push(`New or worsened geometry candidates appeared at ${current.viewport.width}px.`);
  }
  return reasons;
}

export async function runRepair(options: RunRepairOptions): Promise<RepairRunResult> {
  if (options.allowModelUpload !== true || options.allowProjectExecution !== true) return {
    status: 'blocked', code: 'AUTHORIZATION_REQUIRED', message: 'Review the plan, then explicitly pass both --allow-model-upload and --allow-project-execution. No input, credential, process or network access occurred.',
  };
  let loaded: Awaited<ReturnType<typeof loadRepairPlan>>;
  try { loaded = await loadRepairPlan(options.plan); }
  catch (error) { return { status: error instanceof RepairError ? error.status : 'failed',
    code: error instanceof RepairError ? error.code : 'INVALID_PLAN', message: error instanceof RepairError ? error.message : 'Repair plan could not be safely verified.' }; }
  const { plan, reviewed, diagnosis } = loaded;
  const runDirectory = path.dirname(loaded.planPath);
  try { await writeFile(path.join(runDirectory, 'attempt.lock'), `${plan.runId}\n`, { flag: 'wx', mode: 0o600 }); }
  catch { return { status: 'blocked', code: 'ATTEMPT_ALREADY_USED', message: 'One attempt is permitted per prepared run. Prepare and review a new plan.' }; }
  const report: RepairReport = {
    schemaVersion: '3.0.0', runId: plan.runId, issueId: plan.issueId, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    status: 'failed', code: 'RUN_INCOMPLETE', reasons: ['Repair did not finish.'],
    inputs: { planSha256: loaded.planSha256, evidenceSha256: plan.evidenceSha256, imageSha256: plan.imageSha256,
      diagnosisSha256: plan.diagnosisSha256, configSha256: plan.configSha256, sourceHashes: plan.sources.map(({ path, sha256 }) => ({ path, sha256 })) },
    model: { kind: options.testProposal ? 'deterministic-test' : 'none', provider: null, identifier: null, requestMade: false },
    sourceSnapshot: [], workspace: null, dependencyFiles: 0, proposal: null, patch: null, builds: [], baseline: null, verification: null,
    verificationUrls: [], originalSourcesUnchanged: null, cleanup: { serverStopped: true, workspacePatchReverted: null, errors: [] },
    limitations: [...plan.limitations,
      'Source and dependency copies are physical files; no install command or install hook is run.',
      'Browser checks cover only the five Phase 1 viewports and configured target/guarded interaction.',
      ...(options.testProposal ? ['DETERMINISTIC INFRASTRUCTURE TEST: proposal supplied by test code; no model-generated repair or live AI success is claimed.'] : [])],
  };
  let workspace: string | undefined;
  let server: Awaited<ReturnType<typeof startRepairServer>> | undefined;
  const backups = new Map<string, Buffer>();
  let patchAttempted = false;
  const stopServer = async () => {
    if (!server) return;
    const owned = server; server = undefined;
    await owned.stop(); report.cleanup.serverStopped = true;
  };
  try {
    const config = options.testProposal ? undefined : options.config ?? loadMetaConfig().config;
    if (!options.testProposal) {
      const support = checkRepairModelSupport(config);
      if (!support.isConfigured) stop('blocked', support.code, 'Live Meta repair is blocked. Configure valid local Meta credentials and a documented image-capable model; no project code or model request was run.');
    }
    await checkRepairPort(plan.config.port);
    const copy = await createRepairWorkspace({ project: plan.project, runDirectory, dependencyDirectory: plan.config.dependencyDirectory, runId: plan.runId });
    workspace = copy.directory; report.workspace = copy.directory; report.dependencyFiles = copy.dependencyFiles; report.sourceSnapshot = copy.sourceHashes;
    for (const source of plan.sources) {
      const bytes = await readRepairFile(await repairCssFile(workspace, source.path), 16 * 1024);
      if (repairHash(bytes) !== source.sha256) stop('failed', 'STALE_SOURCE', 'The isolated CSS no longer matches its reviewed source hash.');
      backups.set(source.path, bytes);
    }
    const browser = async (phase: 'baseline' | 'after') => {
      const build = await runRepairBuild({ workspace: workspace!, command: plan.config.build, logDirectory: path.join(runDirectory, phase, 'logs') });
      report.builds.push({ ...build, phase, logPath: relative(runDirectory, build.logPath) });
      if (!build.success) stop(phase === 'after' ? 'rejected' : 'failed', 'BUILD_FAILED', `${phase === 'after' ? 'Proposed repair' : 'Baseline'} build failed or timed out.`);
      server = await startRepairServer({ workspace: workspace!, command: plan.config.server, port: plan.config.port, logDirectory: path.join(runDirectory, phase, 'logs') });
      report.cleanup.serverStopped = false; report.verificationUrls.push(server.url);
      const scan = await scanProject({ project: workspace!, url: server.url, output: path.join(runDirectory, phase, 'scans') });
      const content = await captureRepairContent({ url: server.url, outputDirectory: path.join(runDirectory, phase),
        targetSelector: plan.config.targetSelector, interaction: plan.config.interaction,
        evidenceBinding: { viewportWidth: reviewed.manifest.viewport.width, selectors: reviewed.manifest.candidates.map((candidate) => candidate.selector) } });
      const result = { report: scan.report, reportDirectory: relative(runDirectory, scan.reportDirectory), content };
      await stopServer();
      return result;
    };
    report.baseline = await browser('baseline');
    const failing = report.baseline.report.results.find((result) => result.viewport.width === reviewed.manifest.viewport.width);
    const candidatesReproduced = reviewed.manifest.candidates.length === 0 || reviewed.manifest.candidates.some((candidate) =>
      failing?.candidates.some((current) => current.selector === candidate.selector && current.tagName === candidate.tagName && current.overflowPx > 1));
    if (report.baseline.report.status !== 'complete' || failing?.status !== 'complete'
      || (!failing.document?.hasOverflow && failing.candidates.length === 0) || !candidatesReproduced
      || !report.baseline.content.results.some((result) => result.width === reviewed.manifest.viewport.width && result.evidenceBinding.required && result.evidenceBinding.matched)
      || report.baseline.content.results.some((result) => result.status !== 'complete' || !result.target?.visible || !result.interaction.passed)) {
      stop('inconclusive', 'BASELINE_NOT_REPRODUCIBLE', 'The original failure, required content or configured interaction could not be reproduced in the unmodified copy. No patch was applied.');
    }
    let proposal: PatchProposal;
    if (options.testProposal) proposal = PatchProposalSchema.parse(options.testProposal.proposal);
    else {
      const generated = await generateRepairProposal({ manifest: reviewed.manifest, imageBase64: reviewed.imageBase64,
        diagnosis, sources: plan.sources, allowModelUpload: true, config });
      report.model = { kind: generated.requestMade ? 'meta' : 'none', provider: generated.provider ?? null,
        identifier: generated.model ?? null, requestMade: generated.requestMade };
      if (generated.status !== 'success' || !generated.proposal) stop(generated.status === 'blocked' ? 'blocked' : 'failed', generated.code, generated.message);
      proposal = PatchProposalSchema.parse(generated.proposal);
    }
    const serializedProposal = JSON.stringify(proposal);
    if (filterSecrets(serializedProposal) !== serializedProposal) stop('rejected', 'SENSITIVE_PROPOSAL', 'The proposal contained credential-like text and was not persisted or applied.');
    report.proposal = proposal;
    await writeFile(path.join(runDirectory, 'proposal.diff'), proposal.unifiedDiff, { flag: 'wx', mode: 0o600 });
    report.patch = { path: 'proposal.diff', sha256: repairHash(proposal.unifiedDiff), changedFiles: [] };
    patchAttempted = true;
    const applied = await validateAndApplyCssPatch({ workspace, runId: plan.runId, sources: plan.sources, proposal, issueId: plan.issueId });
    report.patch.changedFiles = applied.changedFiles;
    report.verification = await browser('after');
    const geometry = geometryReasons(report.baseline.report, report.verification.report, reviewed.manifest.viewport.width);
    const content = compareRepairContent(report.baseline.content, report.verification.content);
    const reasons = [...geometry, ...content.reasons];
    if (reasons.length > 0) stop('rejected', 'VERIFICATION_REJECTED', reasons.slice(0, 8).join(' ').slice(0, 1000));
    report.status = 'verified'; report.code = 'CONFIGURED_CHECKS_PASSED';
    report.reasons = ['The reviewed CSS repair passed the baseline reproduction, isolated builds, five viewport geometry/content checks, configured guarded interaction and matching screenshot capture. This is not universal correctness.'];
  } catch (error) {
    report.status = error instanceof StopRepair ? error.status
      : error instanceof PatchValidationError ? 'rejected'
        : error instanceof RepairExecutionError && ['DEPENDENCIES_UNAVAILABLE', 'UNSUPPORTED_SERVER', 'UNSUPPORTED_COMMAND', 'UNSUPPORTED_SYMLINK', 'COPY_LIMIT'].includes(error.code) ? 'blocked' : 'failed';
    report.code = error instanceof StopRepair || error instanceof PatchValidationError || error instanceof RepairExecutionError || error instanceof RepairError ? error.code : 'REPAIR_FAILED';
    report.reasons = [error instanceof StopRepair || error instanceof PatchValidationError || error instanceof RepairExecutionError || error instanceof RepairError
      ? error.message.slice(0, 1000) : 'Repair could not finish safely. No original source changes were requested.'];
  } finally {
    try { await stopServer(); }
    catch { report.status = 'failed'; report.code = 'CLEANUP_FAILED'; report.cleanup.serverStopped = false; report.cleanup.errors.push('A run-owned server could not be confirmed stopped.'); }
    if (workspace && patchAttempted && report.status !== 'verified') {
      try {
        const canonical = await realpath(workspace);
        const marker = JSON.parse((await readRepairFile(path.join(canonical, '.visionfix-workspace.json'), 4096)).toString('utf8'));
        if (path.dirname(canonical).toLowerCase() !== (await realpath(os.tmpdir())).toLowerCase()
          || !path.basename(canonical).startsWith(`vfx-${plan.runId.slice(0, 8)}-`)
          || marker.runId !== plan.runId || marker.runDirectory !== await realpath(runDirectory)
          || marker.originalProject !== await realpath(plan.project) || repairInside(plan.project, canonical)) throw new Error();
        for (const [relativePath, bytes] of backups) {
          const file = await repairCssFile(workspace, relativePath);
          await writeFile(file, bytes);
        }
        report.cleanup.workspacePatchReverted = true;
      } catch { report.status = 'failed'; report.code = 'REVERT_FAILED'; report.cleanup.workspacePatchReverted = false; report.cleanup.errors.push('Run-owned CSS could not be safely restored. Original files were not used as an output.'); }
    }
    try {
      const sources = report.sourceSnapshot.length ? report.sourceSnapshot : report.inputs.sourceHashes;
      report.originalSourcesUnchanged = true;
      for (const source of sources) {
        const file = path.resolve(plan.project, source.path);
        if (!repairInside(plan.project, file) || (await lstat(file)).isSymbolicLink()
          || repairHash(await readRepairFile(file, 4 * 1024 * 1024)) !== source.sha256) { report.originalSourcesUnchanged = false; break; }
      }
      if (!report.originalSourcesUnchanged) { report.status = 'failed'; report.code = 'ORIGINAL_SOURCE_CHANGED'; report.reasons.push('Original source hashes changed during the run; review concurrent changes.'); }
    } catch { report.originalSourcesUnchanged = false; report.status = 'failed'; report.code = 'ORIGINAL_SOURCE_UNVERIFIED'; report.reasons.push('Original source preservation could not be independently confirmed.'); }
  }
  report.finishedAt = new Date().toISOString();
  const reportPath = path.join(runDirectory, 'repair-report.json');
  try {
    const valid = RepairReportSchema.parse(report);
    await writeFile(reportPath, JSON.stringify(valid, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { status: valid.status, code: valid.code, message: valid.reasons.join(' '), reportPath, report: valid };
  } catch { return { status: 'failed', code: 'REPORT_FAILED', message: 'Repair result could not be safely validated or saved. Review retained local run artifacts; no original project patch was applied.' }; }
}

export function repairExitCode(status: RepairReport['status']): 0 | 1 | 2 | 3 | 4 {
  return status === 'verified' ? 0 : status === 'rejected' ? 1 : status === 'blocked' ? 3 : status === 'inconclusive' ? 4 : 2;
}
