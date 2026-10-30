import type { MetaConfig } from './config.js';

export type MetaApiErrorType =
  | 'MISSING_CONFIG'
  | 'AUTH_ERROR'
  | 'MODEL_ERROR'
  | 'NETWORK_ERROR'
  | 'API_ERROR';

export interface MetaApiTestSuccess {
  success: true;
  status: number;
  model: string;
  responseText: string;
  durationMs: number;
}

export interface MetaApiTestFailure {
  success: false;
  errorType: MetaApiErrorType;
  statusCode?: number;
  message: string;
  details?: string;
  durationMs?: number;
}

export type MetaApiTestResult = MetaApiTestSuccess | MetaApiTestFailure;

export interface TestMetaApiOptions {
  timeoutMs?: number;
  prompt?: string;
}

/**
 * Sends a minimal test request to the configured Meta model API endpoint.
 * Conforms to the standard OpenAI-compatible Chat Completions API used by Meta.
 * Never mocks success — returns real response or classified error.
 */
export async function testMetaApiConnection(
  config: MetaConfig,
  options: TestMetaApiOptions = {}
): Promise<MetaApiTestResult> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const prompt = options.prompt ?? 'Respond with the single word: OK';
  const startTime = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const cleanBase = config.baseUrl.replace(/\/+$/, '');
  // Endpoint resolution: if base URL ends with /v1, append /chat/completions; otherwise ensure correct path
  const endpoint = cleanBase.endsWith('/chat/completions')
    ? cleanBase
    : `${cleanBase}/chat/completions`;

  const requestBody = {
    model: config.model,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    max_tokens: 32,
    temperature: 0.1,
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const durationMs = Date.now() - startTime;
    clearTimeout(timer);

    if (response.status === 401 || response.status === 403) {
      const errorBody = await response.text().catch(() => '');
      return {
        success: false,
        errorType: 'AUTH_ERROR',
        statusCode: response.status,
        message: `Authentication failed (HTTP ${response.status}). Verify your META_API_KEY.`,
        details: errorBody.slice(0, 300),
        durationMs,
      };
    }

    if (response.status === 404) {
      const errorBody = await response.text().catch(() => '');
      return {
        success: false,
        errorType: 'MODEL_ERROR',
        statusCode: 404,
        message: `Endpoint or model not found (HTTP 404). Check META_BASE_URL (${endpoint}) and META_MODEL (${config.model}).`,
        details: errorBody.slice(0, 300),
        durationMs,
      };
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const isModelIssue =
        errorBody.toLowerCase().includes('model') ||
        errorBody.toLowerCase().includes('not supported') ||
        errorBody.toLowerCase().includes('unknown');

      return {
        success: false,
        errorType: isModelIssue ? 'MODEL_ERROR' : 'API_ERROR',
        statusCode: response.status,
        message: `API request returned HTTP ${response.status}: ${response.statusText}`,
        details: errorBody.slice(0, 300),
        durationMs,
      };
    }

    const json: unknown = await response.json();
    const choiceContent =
      typeof json === 'object' &&
      json !== null &&
      'choices' in json &&
      Array.isArray(json.choices) &&
      json.choices.length > 0 &&
      typeof json.choices[0] === 'object' &&
      json.choices[0] !== null &&
      'message' in json.choices[0] &&
      typeof json.choices[0].message === 'object' &&
      json.choices[0].message !== null &&
      'content' in json.choices[0].message &&
      typeof json.choices[0].message.content === 'string'
        ? json.choices[0].message.content.trim()
        : '';

    if (!choiceContent) {
      return {
        success: false,
        errorType: 'API_ERROR',
        statusCode: response.status,
        message: 'API returned success without textual model output.',
        durationMs,
      };
    }

    return {
      success: true,
      status: response.status,
      model: config.model,
      responseText: choiceContent,
      durationMs,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const durationMs = Date.now() - startTime;

    if (err instanceof Error) {
      if (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted')) {
        return {
          success: false,
          errorType: 'NETWORK_ERROR',
          message: `Request timed out after ${timeoutMs}ms while contacting ${endpoint}.`,
          durationMs,
        };
      }

      return {
        success: false,
        errorType: 'NETWORK_ERROR',
        message: `Network failure connecting to Meta API (${endpoint}): ${err.message}`,
        details: err.stack,
        durationMs,
      };
    }

    return {
      success: false,
      errorType: 'NETWORK_ERROR',
      message: `Unknown error contacting Meta API: ${String(err)}`,
      durationMs,
    };
  }
}
