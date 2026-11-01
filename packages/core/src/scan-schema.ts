import { z } from 'zod';

export const SCAN_WIDTHS = [320, 375, 390, 768, 1440] as const;
export const VIEWPORT_HEIGHT = 900;
// DOMRect uses fractions while clientWidth/scrollWidth round to integer CSS pixels.
export const OVERFLOW_TOLERANCE_PX = 1;
export const CANDIDATE_LIMIT = 20;

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.literal(900),
  deviceScaleFactor: z.literal(1),
});
export type ScanViewport = z.infer<typeof ViewportSchema>;

export const ScanErrorSchema = z.object({
  code: z.string().min(1),
  stage: z.enum(['configuration', 'browser', 'navigation', 'readiness', 'measurement', 'screenshot', 'cleanup']),
  message: z.string().min(1).max(500),
  viewportWidth: z.number().int().positive().optional(),
});
export type ScanError = z.infer<typeof ScanErrorSchema>;

export const RectangleSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  top: z.number().finite(), right: z.number().finite(),
  bottom: z.number().finite(), left: z.number().finite(),
  width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(),
});

export const ComputedStylesSchema = z.object({
  display: z.string(), position: z.string(), boxSizing: z.string(),
  width: z.string(), minWidth: z.string(), maxWidth: z.string(),
  overflowX: z.string(), overflowY: z.string(),
  whiteSpace: z.string(), flexWrap: z.string(),
  transform: z.string(), marginLeft: z.string(), marginRight: z.string(),
});
export const IssueEvidenceSchema = z.object({
  kind: z.literal('candidate-contributor'),
  selector: z.string().min(1).max(1000),
  tagName: z.string().min(1),
  rect: RectangleSchema,
  styles: ComputedStylesSchema,
  viewportWidth: z.number().positive(),
  documentWidth: z.number().positive(),
  overflowPx: z.number().positive(),
});
export type IssueEvidence = z.infer<typeof IssueEvidenceSchema>;

export const DocumentMetricsSchema = z.object({
  clientWidth: z.number().positive(),
  scrollWidth: z.number().positive(),
  overflowPx: z.number().nonnegative(),
  hasOverflow: z.boolean(),
});
export type DocumentMetrics = z.infer<typeof DocumentMetricsSchema>;

export const ScreenshotPathSchema = z.string().min(1).refine(
  (value) => !value.includes('\\') && !value.startsWith('/') && !value.includes(':')
    && value.split('/').every((part) => part !== '..' && part !== '.' && part !== ''),
  'Screenshot path must be a relative report path without traversal',
);
export type ScreenshotPath = z.infer<typeof ScreenshotPathSchema>;
export const ScreenshotSchema = z.object({
  path: ScreenshotPathSchema,
  width: z.number().int().positive(),
  height: z.literal(900),
  capture: z.literal('viewport'),
});
export type ScanScreenshot = z.infer<typeof ScreenshotSchema>;

export const ViewportResultSchema = z.object({
  viewport: ViewportSchema,
  status: z.enum(['complete', 'failed']),
  document: DocumentMetricsSchema.nullable(),
  candidates: z.array(IssueEvidenceSchema).max(CANDIDATE_LIMIT),
  candidatesTruncated: z.boolean(),
  screenshot: ScreenshotSchema.nullable(),
  errors: z.array(ScanErrorSchema),
}).superRefine((value, ctx) => {
  if (value.status === 'complete' && (!value.document || !value.screenshot || value.errors.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Complete viewport requires geometry, screenshot, and no errors' });
  }
  if (value.status === 'failed' && value.errors.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Failed viewport requires an explicit error' });
  }
});
export type ViewportResult = z.infer<typeof ViewportResultSchema>;

export const ProjectMetadataSchema = z.object({
  directory: z.string().min(1),
  framework: z.literal('react-vite'),
});
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export const ScanMetadataSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  scanId: z.string().uuid(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  targetUrl: z.string().url(),
  project: ProjectMetadataSchema,
  testedViewports: z.array(ViewportSchema).length(SCAN_WIDTHS.length),
  tolerancePx: z.literal(OVERFLOW_TOLERANCE_PX),
  candidateLimit: z.literal(CANDIDATE_LIMIT),
  status: z.enum(['complete', 'partial', 'failed']),
});
export type ScanMetadata = z.infer<typeof ScanMetadataSchema>;

export const ScanReportSchema = ScanMetadataSchema.extend({
  results: z.array(ViewportResultSchema).length(SCAN_WIDTHS.length),
  errors: z.array(ScanErrorSchema),
}).superRefine((report, ctx) => {
  const complete = report.results.filter((result) => result.status === 'complete').length;
  const expectedStatus = complete === 0 ? 'failed'
    : complete === SCAN_WIDTHS.length && report.errors.length === 0 ? 'complete' : 'partial';
  if (report.status !== expectedStatus) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Scan status must match viewport outcomes and scan errors' });
  }
  if (report.results.some((result, index) => result.viewport.width !== SCAN_WIDTHS[index])
    || report.testedViewports.some((viewport, index) => viewport.width !== SCAN_WIDTHS[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Report must include each configured viewport in order' });
  }
});
export type ScanReport = z.infer<typeof ScanReportSchema>;
