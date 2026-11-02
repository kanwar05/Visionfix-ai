import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadReviewedEvidence } from './diagnosis-evidence.js';
import { DiagnosisSchema, validateDiagnosisResponse, type Diagnosis } from './diagnosis-model.js';
import { filterSecrets } from './privacy.js';
import { REPAIR_LIMITS, RepairError, RepairExecutionConfigSchema, RepairPlanSchema, type RepairPlan } from './repair-schema.js';

export const repairHash = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');
export function repairInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export async function readRepairFile(file: string, limit: number): Promise<Buffer> {
  let handle;
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error();
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error();
    const buffer = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== info.size || size > limit) throw new Error();
    return buffer.subarray(0, size);
  } catch {
    throw new RepairError('INVALID_REPAIR_INPUT', 'A repair input is missing, changed, linked or exceeds its documented limit.');
  } finally { await handle?.close(); }
}
export async function repairCssFile(project: string, relative: string): Promise<string> {
  const destination = path.resolve(project, relative);
  if (!repairInside(project, destination)) throw new RepairError('UNSAFE_SOURCE', 'CSS path escapes the approved project.');
  let current = project;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new RepairError('UNSAFE_SOURCE', 'CSS symlinks are unsupported.');
  }
  const canonical = await realpath(destination);
  const info = await lstat(destination);
  if (!repairInside(project, canonical) || !info.isFile() || info.nlink > 1) throw new RepairError('UNSAFE_SOURCE', 'CSS must be a contained regular file without writable links.');
  return canonical;
}
function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RepairError('INVALID_REPAIR_JSON', 'Repair input must contain valid UTF-8 JSON.'); }
}
const DiagnosisEnvelopeSchema = z.object({ schemaVersion: z.literal('2.0.0'), createdAt: z.string().datetime(),
  status: z.literal('success'), code: z.literal('DIAGNOSIS_VALIDATED'), message: z.string().max(4000),
  diagnosis: DiagnosisSchema, limitations: z.array(z.string().max(4000)).max(40),
}).strict();
export async function readRepairDiagnosis(diagnosisPath: string, evidence: Awaited<ReturnType<typeof loadReviewedEvidence>>['manifest']): Promise<Diagnosis> {
  const parsed = DiagnosisEnvelopeSchema.safeParse(json(await readRepairFile(diagnosisPath, 256 * 1024)));
  if (!parsed.success) throw new RepairError('DIAGNOSIS_NOT_AVAILABLE', 'A successful validated Phase 2 diagnosis is required. Blocked or fabricated live output cannot be used.', 'blocked');
  try { return validateDiagnosisResponse(parsed.data.diagnosis, evidence); }
  catch { throw new RepairError('INVALID_DIAGNOSIS', 'Diagnosis references do not match the reviewed Phase 2 evidence.'); }
}

/** Local-only review step: no model configuration, process execution, dependency installation or source mutation. */
export async function prepareRepairPlan(options: { project: string; evidence: string; diagnosis: string; config: string }): Promise<{ planPath: string; plan: RepairPlan }> {
  const project = await realpath(path.resolve(options.project));
  if (!(await lstat(project)).isDirectory()) throw new RepairError('INVALID_PROJECT', 'Repair requires an existing project directory.');
  const evidencePath = path.resolve(options.evidence);
  const reviewed = await loadReviewedEvidence(evidencePath);
  const canonicalEvidence = await realpath(evidencePath);
  const parent = path.dirname(canonicalEvidence);
  if (repairInside(project, parent)) throw new RepairError('UNSAFE_OUTPUT', 'Repair outputs must be outside the target project.');
  const diagnosisPath = await realpath(path.resolve(options.diagnosis));
  await readRepairDiagnosis(diagnosisPath, reviewed.manifest);
  const configPath = await realpath(path.resolve(options.config));
  const configBytes = await readRepairFile(configPath, 32 * 1024);
  const parsed = RepairExecutionConfigSchema.safeParse(json(configBytes));
  if (!parsed.success || filterSecrets(configBytes.toString('utf8')) !== configBytes.toString('utf8')) {
    throw new RepairError('INVALID_EXECUTION_CONFIG', 'Review the execution configuration schema; credentials are forbidden in the configuration.');
  }
  const config = parsed.data;
  config.dependencyDirectory = path.resolve(path.dirname(configPath), config.dependencyDirectory);
  let totalBytes = 0;
  const sources = [];
  for (const relative of config.allowedCssFiles) {
    const snippets = reviewed.manifest.snippets.filter((snippet) => snippet.path === relative);
    if (snippets.length === 0 || !reviewed.manifest.mappings.some((mapping) => mapping.snippetIds.some((id) => snippets.some((snippet) => snippet.id === id)))) {
      throw new RepairError('UNSUPPORTED_SOURCE', 'Every approved CSS file must have a supported mapping in the reviewed Phase 2 evidence.', 'blocked');
    }
    const bytes = await readRepairFile(await repairCssFile(project, relative), REPAIR_LIMITS.sourceFileBytes);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n?/g, '\n'); }
    catch { throw new RepairError('UNSUPPORTED_SOURCE', 'Approved CSS must be bounded UTF-8 text.', 'blocked'); }
    const lines = text.split('\n');
    for (const snippet of snippets) {
      const current = filterSecrets(lines.slice(snippet.startLine - 1, snippet.endLine).join('\n'));
      if (current !== snippet.content || repairHash(current) !== snippet.sha256) throw new RepairError('STALE_SOURCE', 'Source no longer matches the reviewed Phase 2 snippet. Prepare a new scan and evidence.');
    }
    const content = filterSecrets(text);
    totalBytes += Buffer.byteLength(content);
    if (Buffer.byteLength(content) > REPAIR_LIMITS.sourceFileBytes || totalBytes > REPAIR_LIMITS.sourceBytes) throw new RepairError('SOURCE_LIMIT', 'Approved CSS exceeds the bounded repair context.');
    sources.push({ path: relative, sha256: repairHash(bytes), bytes: bytes.length, content,
      contentSha256: repairHash(content), startLine: 1 as const, endLine: content.split('\n').length });
  }
  const runId = randomUUID();
  const plan = RepairPlanSchema.parse({ schemaVersion: '3.0.0', runId, createdAt: new Date().toISOString(),
    issueId: reviewed.manifest.issueId, project, evidencePath: canonicalEvidence,
    evidenceSha256: repairHash(await readRepairFile(canonicalEvidence, 512 * 1024)), imageSha256: reviewed.manifest.image.sha256,
    diagnosisPath, diagnosisSha256: repairHash(await readRepairFile(diagnosisPath, 256 * 1024)),
    configPath, configSha256: repairHash(configBytes), config, sources,
    limitations: [
      'Review this plan, approved CSS context, execution arrays and verification selectors before authorizing upload and execution.',
      'CSS is limited to two existing approved files and 80 changed lines; one issue and one attempt per run.',
      'Text redaction is best effort; screenshot pixels are not redacted.',
      'The working copy isolates source changes, not trusted executable code or its network/filesystem permissions.',
      'Verified means only the configured checks passed, not universal correctness.',
    ],
  });
  const serialized = JSON.stringify(plan, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > REPAIR_LIMITS.planBytes) throw new RepairError('PLAN_LIMIT', 'Repair plan exceeds its size limit.');
  const runDirectory = path.join(parent, `repair-${runId}`);
  await mkdir(runDirectory);
  await writeFile(path.join(runDirectory, '.gitignore'), '*\n', { flag: 'wx' });
  const planPath = path.join(runDirectory, 'repair-plan.json');
  await writeFile(planPath, serialized, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(runDirectory, 'repair-plan.sha256'), repairHash(serialized) + '\n', { flag: 'wx' });
  return { planPath, plan };
}

export async function loadRepairPlan(input: string): Promise<{ plan: RepairPlan; planPath: string; planSha256: string; reviewed: Awaited<ReturnType<typeof loadReviewedEvidence>>; diagnosis: Diagnosis }> {
  if ((await lstat(path.resolve(input))).isSymbolicLink()) throw new RepairError('UNSAFE_PLAN', 'A repair plan cannot be a symlink.');
  const planPath = await realpath(path.resolve(input));
  const bytes = await readRepairFile(planPath, REPAIR_LIMITS.planBytes);
  const seal = await readRepairFile(path.join(path.dirname(planPath), 'repair-plan.sha256'), 65);
  if (seal.toString('utf8') !== repairHash(bytes) + '\n') throw new RepairError('CHANGED_PLAN', 'The reviewed repair plan changed. Prepare and review a new plan.');
  const result = RepairPlanSchema.safeParse(json(bytes));
  if (!result.success) throw new RepairError('INVALID_PLAN', 'The repair plan does not match the bounded schema.');
  const plan = result.data;
  if (repairInside(await realpath(plan.project), path.dirname(planPath)) || path.basename(path.dirname(planPath)) !== `repair-${plan.runId}`) throw new RepairError('UNSAFE_OUTPUT', 'Repair directory is outside the approved run identity or inside the target.');
  const reviewed = await loadReviewedEvidence(plan.evidencePath);
  if (repairHash(await readRepairFile(plan.evidencePath, 512 * 1024)) !== plan.evidenceSha256
    || reviewed.manifest.issueId !== plan.issueId || reviewed.manifest.image.sha256 !== plan.imageSha256
    || repairHash(await readRepairFile(plan.diagnosisPath, 256 * 1024)) !== plan.diagnosisSha256
    || repairHash(await readRepairFile(plan.configPath, 32 * 1024)) !== plan.configSha256) throw new RepairError('CHANGED_INPUT', 'A reviewed evidence, diagnosis or execution input changed.');
  const diagnosis = await readRepairDiagnosis(plan.diagnosisPath, reviewed.manifest);
  if (new Set(plan.sources.map((source) => source.path)).size !== plan.sources.length
    || plan.config.allowedCssFiles.length !== plan.sources.length
    || plan.config.allowedCssFiles.some((relative) => !plan.sources.some((source) => source.path === relative))) throw new RepairError('INVALID_PLAN', 'CSS approval and source hashes do not agree.');
  for (const source of plan.sources) {
    const bytes = await readRepairFile(await repairCssFile(plan.project, source.path), REPAIR_LIMITS.sourceFileBytes);
    if (repairHash(bytes) !== source.sha256 || source.contentSha256 !== repairHash(source.content)
      || source.endLine !== source.content.split('\n').length || bytes.length !== source.bytes
      || source.content !== filterSecrets(bytes.toString('utf8').replace(/\r\n?/g, '\n'))) throw new RepairError('STALE_SOURCE', 'An approved source changed after review. Prepare a new plan.');
  }
  return { plan, planPath, planSha256: repairHash(bytes), reviewed, diagnosis };
}
