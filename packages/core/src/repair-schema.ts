import path from 'node:path';
import { z } from 'zod';
import { isApprovedSourcePath } from './source-locator.js';

export const REPAIR_LIMITS = Object.freeze({ files: 2, sourceFileBytes: 16 * 1024,
  sourceBytes: 32 * 1024, changedLines: 80, diffBytes: 32 * 1024, planBytes: 128 * 1024 });
export const RepairCssPathSchema = z.string().min(1).max(300).refine((value) =>
  isApprovedSourcePath(value) && value.endsWith('.css') && !/[\x00-\x1f]/.test(value), 'Approved existing CSS source path required');
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const LocalPathSchema = z.string().min(1).max(2000).refine((value) => path.isAbsolute(value) && !/[\x00-\x1f]/.test(value));
export const ExecutionCommandSchema = z.object({
  executable: LocalPathSchema.refine((value) => !/\.(?:cmd|bat|ps1|sh)$/i.test(value), 'A native executable is required'),
  args: z.array(z.string().max(2000).refine((value) => !/[\x00\r\n]/.test(value))).min(1).max(30),
  timeoutMs: z.number().int().min(100).max(120_000),
}).strict();
export type ExecutionCommand = z.infer<typeof ExecutionCommandSchema>;
export const RepairExecutionConfigSchema = z.object({
  schemaVersion: z.literal('3.0.0'), allowedCssFiles: z.array(RepairCssPathSchema).min(1).max(REPAIR_LIMITS.files),
  dependencyDirectory: z.string().min(1).max(2000), build: ExecutionCommandSchema,
  server: ExecutionCommandSchema.refine((value) => value.timeoutMs <= 30_000, 'Readiness timeout is limited to 30 seconds'),
  port: z.number().int().min(1024).max(65535), targetSelector: z.string().min(1).max(1000),
  interaction: z.object({ selector: z.string().min(1).max(1000), expectedDialog: z.string().min(1).max(500).optional() }).strict().optional(),
}).strict().refine((value) => new Set(value.allowedCssFiles).size === value.allowedCssFiles.length, 'Duplicate CSS file approval');
export type RepairExecutionConfig = z.infer<typeof RepairExecutionConfigSchema>;
export const RepairSourceReviewSchema = z.object({ path: RepairCssPathSchema, sha256: HashSchema,
  bytes: z.number().int().positive().max(REPAIR_LIMITS.sourceFileBytes), content: z.string().max(REPAIR_LIMITS.sourceFileBytes),
  contentSha256: HashSchema, startLine: z.literal(1), endLine: z.number().int().positive(),
}).strict();
export type RepairSourceReview = z.infer<typeof RepairSourceReviewSchema>;
export type SourceReview = RepairSourceReview;
export const RepairPlanSchema = z.object({
  schemaVersion: z.literal('3.0.0'), runId: z.string().uuid(), createdAt: z.string().datetime(),
  issueId: z.string().min(1).max(100), project: LocalPathSchema, evidencePath: LocalPathSchema,
  evidenceSha256: HashSchema, imageSha256: HashSchema, diagnosisPath: LocalPathSchema, diagnosisSha256: HashSchema,
  configPath: LocalPathSchema, configSha256: HashSchema, config: RepairExecutionConfigSchema,
  sources: z.array(RepairSourceReviewSchema).min(1).max(REPAIR_LIMITS.files), limitations: z.array(z.string().max(1000)).max(12),
}).strict();
export type RepairPlan = z.infer<typeof RepairPlanSchema>;
export class RepairError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 'blocked' | 'failed' = 'failed') {
    super(message); this.name = 'RepairError';
  }
}
