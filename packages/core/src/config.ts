import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';

// Load .env from root workspace if present
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const MetaConfigSchema = z.object({
  apiKey: z
    .string()
    .min(1, 'META_API_KEY must not be empty')
    .refine(
      (val) => !val.includes('your_meta_api_key_here'),
      'META_API_KEY must not be the placeholder value from .env.example'
    ),
  baseUrl: z
    .string()
    .url('META_BASE_URL must be a valid URL')
    .default('https://api.meta.ai/v1'),
  model: z
    .string()
    .min(1, 'META_MODEL must not be empty')
    .default('muse-spark-1.3'),
});

export type MetaConfig = z.infer<typeof MetaConfigSchema>;

export interface MetaConfigCheckResult {
  isConfigured: boolean;
  config?: MetaConfig;
  reason?: string;
  maskedInfo?: {
    baseUrl: string;
    model: string;
    keyMasked: string;
  };
}

/**
 * Safely masks an API key to avoid accidental credential leaks in logs.
 */
export function maskKey(key: string): string {
  if (!key || key.length < 8) {
    return '***';
  }
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Loads and validates Meta API configuration from environment variables.
 * Safe to call even if .env is missing or variables are unset.
 */
export function loadMetaConfig(): MetaConfigCheckResult {
  const rawKey = process.env.META_API_KEY?.trim() ?? '';
  const rawBaseUrl = process.env.META_BASE_URL?.trim() || 'https://api.meta.ai/v1';
  const rawModel = process.env.META_MODEL?.trim() || 'muse-spark-1.3';

  if (!rawKey) {
    return {
      isConfigured: false,
      reason: 'META_API_KEY is not set in the environment or .env file.',
    };
  }

  if (rawKey === 'your_meta_api_key_here') {
    return {
      isConfigured: false,
      reason: 'META_API_KEY is still set to placeholder "your_meta_api_key_here".',
    };
  }

  const parsed = MetaConfigSchema.safeParse({
    apiKey: rawKey,
    baseUrl: rawBaseUrl,
    model: rawModel,
  });

  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map((i) => i.message).join('; ');
    return {
      isConfigured: false,
      reason: `Configuration validation failed: ${errorMessages}`,
    };
  }

  return {
    isConfigured: true,
    config: parsed.data,
    maskedInfo: {
      baseUrl: parsed.data.baseUrl,
      model: parsed.data.model,
      keyMasked: maskKey(parsed.data.apiKey),
    },
  };
}
