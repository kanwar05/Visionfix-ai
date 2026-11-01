import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { runDiagnosis, validateDiagnosisResponse, type Diagnosis } from '../packages/core/dist/diagnosis-model.js';
import { EvidenceManifestSchema, type EvidenceManifest } from '../packages/core/dist/diagnosis-evidence.js';

// Every model response in this file is a UNIT TEST MOCK. These tests do not
// establish credentials, remote availability or successful live integration.
const config = { apiKey: 'unit-test-credential-not-a-real-key', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3' };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); content.copy(result, 4); result.writeUInt32BE(crc32(content), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(320); header.writeUInt32BE(900, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(900 * (320 * 3 + 1)))), chunk('IEND', Buffer.alloc(0))]);
}
async function prepared(): Promise<{ path: string; manifest: EvidenceManifest }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'visionfix-mock-diagnosis-'));
  const image = png();
  const content = '.wide {\n  min-width: 700px;\n}';
  const scanId = randomUUID();
  const manifest = EvidenceManifestSchema.parse({
    schemaVersion: '2.0.0', createdAt: new Date().toISOString(), scanId, issueId: `${scanId}:320`,
    viewport: { width: 320, height: 900, deviceScaleFactor: 1 },
    document: { clientWidth: 320, scrollWidth: 700, overflowPx: 380, hasOverflow: true },
    candidates: [{ id: 'candidate-1', selector: '.wide', tagName: 'div',
      rect: { x: 0, y: 0, top: 0, right: 700, bottom: 20, left: 0, width: 700, height: 20 },
      styles: { display: 'block', position: 'static', boxSizing: 'border-box', width: '700px', minWidth: '700px', maxWidth: 'none',
        overflowX: 'visible', overflowY: 'visible', whiteSpace: 'normal', flexWrap: 'nowrap', transform: 'none', marginLeft: '0px', marginRight: '0px' },
      viewportWidth: 320, documentWidth: 700, overflowPx: 380 }],
    mappings: [{ candidateId: 'candidate-1', status: 'mapped', snippetIds: ['snippet-1'], reasons: ['Literal CSS class selector match.'] }],
    snippets: [{ id: 'snippet-1', path: 'src/styles.css', startLine: 10, endLine: 12, content, sha256: hash(content) }],
    image: { path: 'screenshot.png', sha256: hash(image), bytes: image.length, mimeType: 'image/png', width: 320, height: 900 },
    limitations: ['Synthetic fixture for mocked unit tests only.'],
  });
  const serialized = JSON.stringify(manifest, null, 2) + '\n';
  const manifestPath = path.join(directory, 'manifest.json');
  await writeFile(manifestPath, serialized);
  await writeFile(path.join(directory, 'review.sha256'), hash(serialized) + '\n');
  await writeFile(path.join(directory, 'screenshot.png'), image);
  return { path: manifestPath, manifest };
}
function diagnosis(manifest: EvidenceManifest): Diagnosis {
  return { issueId: manifest.issueId, viewportWidth: 320, status: 'grounded',
    explanation: 'The measured 700px minimum width is a likely contributor to 380px overflow at this viewport.',
    browserEvidenceIds: ['candidate-1', 'document'],
    sources: [{ snippetId: 'snippet-1', path: 'src/styles.css', startLine: 11, endLine: 11, quote: '  min-width: 700px;' }],
    repairApproach: 'Review whether the minimum width can shrink at narrow viewports.',
    uncertainties: ['Other constraints may contribute.'], missingEvidence: [], };
}
const mockResponse = (value: unknown): Response => new Response(JSON.stringify({ choices: [{
  message: { content: JSON.stringify(value) }, finish_reason: 'stop',
}] }), { status: 200 });
const mockFetch = (response: Response): typeof fetch => (async () => response) as typeof fetch;

test('mocked unit: upload requires explicit permission before any evidence/config access', async () => {
  let requests = 0;
  const options = { evidence: 'missing-manifest.json', allowModelUpload: false,
    fetchImpl: (async () => { requests++; throw new Error('Must not call'); }) as typeof fetch,
    get config(): never { throw new Error('Must not access configuration'); } };
  const result = await runDiagnosis(options);
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'UPLOAD_NOT_AUTHORIZED'); assert.equal(requests, 0);
});

test('mocked unit: exact reviewed multimodal payload, independent references and separate output', async () => {
  const fixture = await prepared(); let requests = 0;
  const fetchImpl = (async (input, init) => {
    requests++; assert.equal(String(input), 'https://api.meta.ai/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, config.model); assert.equal(body.stream, false); assert.equal(body.tools, undefined);
    assert.deepEqual(JSON.parse(body.messages[1].content[0].text), fixture.manifest);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(body.response_format.type, 'json_schema');
    assert.match(body.messages[0].content, /untrusted DATA/);
    return mockResponse(diagnosis(fixture.manifest));
  }) as typeof fetch;
  const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config, fetchImpl });
  assert.equal(requests, 1); assert.equal(result.status, 'success');
  assert.equal(result.diagnosis?.sources[0].path, 'src/styles.css');
  const output = await readFile(path.join(path.dirname(fixture.path), 'diagnosis.json'), 'utf8');
  assert.equal(JSON.parse(output).status, 'success'); assert(!output.includes(config.apiKey));
});

test('mocked unit: changed manifest or image is rejected before network upload', async (t) => {
  for (const changed of ['manifest.json', 'screenshot.png']) await t.test(changed, async () => {
    const fixture = await prepared(); let requests = 0;
    await writeFile(path.join(path.dirname(fixture.path), changed), 'modified');
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config,
      fetchImpl: (async () => { requests++; throw new Error('Must not upload'); }) as typeof fetch });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'EVIDENCE_INVALID'); assert.equal(requests, 0);
  });
});

test('mocked unit: missing credentials and unknown image model block before network', async (t) => {
  for (const [changed, code] of [[{ ...config, apiKey: '' }, 'MISSING_CONFIG'], [{ ...config, model: 'unverified-model' }, 'IMAGE_SUPPORT_UNVERIFIED'],
    [{ ...config, baseUrl: 'https://private:credential@api.meta.ai/v1' }, 'IMAGE_SUPPORT_UNVERIFIED'],
    [{ ...config, baseUrl: 'http://api.meta.ai/v1' }, 'IMAGE_SUPPORT_UNVERIFIED']] as const) {
    await t.test(code, async () => {
      const fixture = await prepared(); let requests = 0;
      const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config: changed,
        fetchImpl: (async () => { requests++; throw new Error('Must not upload'); }) as typeof fetch });
      assert.equal(result.status, 'blocked'); assert.equal(result.code, code); assert.equal(requests, 0);
      assert.equal(JSON.parse(await readFile(path.join(path.dirname(fixture.path), 'diagnosis.json'), 'utf8')).status, 'blocked');
    });
  }
});

test('mocked unit: invalid JSON, response schema, tool calls and invented references are rejected', async (t) => {
  const fixture = await prepared();
  const valid = diagnosis(fixture.manifest);
  const cases: Array<[string, Response]> = [
    ['malformed API JSON', new Response('not json')],
    ['malformed model JSON', new Response(JSON.stringify({ choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] }))],
    ['wrong issue', mockResponse({ ...valid, issueId: 'invented' })],
    ['wrong viewport', mockResponse({ ...valid, viewportWidth: 375 })],
    ['wrong browser reference', mockResponse({ ...valid, browserEvidenceIds: ['invented'] })],
    ['missing browser reference', mockResponse({ ...valid, status: 'uncertain', browserEvidenceIds: [] })],
    ['invented path', mockResponse({ ...valid, sources: [{ ...valid.sources[0], path: 'src/invented.tsx' }] })],
    ['invented lines', mockResponse({ ...valid, sources: [{ ...valid.sources[0], startLine: 1 }] })],
    ['invented quote', mockResponse({ ...valid, sources: [{ ...valid.sources[0], quote: 'width: 100%;' }] })],
    ['grounded without source', mockResponse({ ...valid, sources: [] })],
    ['uncertain without uncertainties', mockResponse({ ...valid, status: 'uncertain', uncertainties: [] })],
    ['tool invocation', new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid), tool_calls: [] }, finish_reason: 'stop' }] }))],
    ['truncated output', new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) }, finish_reason: 'length' }] }))],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config, fetchImpl: mockFetch(response) });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'INVALID_DIAGNOSIS'); assert.equal(result.diagnosis, undefined);
  });
});

test('mocked unit: ambiguous mappings retain uncertainty and unmapped status never claims source', async () => {
  const fixture = await prepared();
  const ambiguous = { ...fixture.manifest, mappings: [{ ...fixture.manifest.mappings[0], status: 'ambiguous' as const }] };
  assert.throws(() => validateDiagnosisResponse(diagnosis(ambiguous), ambiguous));
  const uncertain = validateDiagnosisResponse({ ...diagnosis(ambiguous), status: 'uncertain' }, ambiguous);
  assert.equal(uncertain.status, 'uncertain');
  const unmapped = validateDiagnosisResponse({ ...diagnosis(fixture.manifest), status: 'unmapped', sources: [], missingEvidence: ['No reliable source match.'] }, fixture.manifest);
  assert.equal(unmapped.status, 'unmapped');
});

test('mocked unit: API errors expose status only and never echo server credentials', async (t) => {
  for (const status of [400, 401, 403, 404, 422, 429, 500]) await t.test(String(status), async () => {
    const fixture = await prepared();
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config,
      fetchImpl: mockFetch(new Response(`private server body ${config.apiKey}`, { status })) });
    assert.equal(result.status, [400, 401, 403, 404, 422].includes(status) ? 'blocked' : 'failed');
    assert(!JSON.stringify(result).includes(config.apiKey));
  });
});

test('mocked unit: network failures, full request timeout and response size limits are bounded', async (t) => {
  await t.test('network exception details suppressed', async () => {
    const fixture = await prepared();
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config,
      fetchImpl: (async () => { throw new Error(config.apiKey); }) as typeof fetch });
    assert.equal(result.code, 'NETWORK_ERROR'); assert(!JSON.stringify(result).includes(config.apiKey));
  });
  await t.test('fetch timeout', async () => {
    const fixture = await prepared();
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config, timeoutMs: 20,
      fetchImpl: (() => new Promise(() => undefined)) as typeof fetch });
    assert.equal(result.code, 'TIMEOUT');
  });
  await t.test('body timeout after headers', async () => {
    const fixture = await prepared();
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config, timeoutMs: 20,
      fetchImpl: mockFetch(new Response(new ReadableStream({ start() { /* Deliberately never finishes. */ } }))) });
    assert.equal(result.code, 'TIMEOUT');
  });
  await t.test('response over 256 KiB', async () => {
    const fixture = await prepared();
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config,
      fetchImpl: mockFetch(new Response('x'.repeat(256 * 1024 + 1))) });
    assert.equal(result.code, 'RESPONSE_TOO_LARGE');
  });
  await t.test('credential echoed in successful API response', async () => {
    const fixture = await prepared();
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config,
      fetchImpl: mockFetch(mockResponse({ ...diagnosis(fixture.manifest), explanation: config.apiKey })) });
    assert.equal(result.code, 'INVALID_DIAGNOSIS'); assert(!JSON.stringify(result).includes(config.apiKey));
  });
  await t.test('JSON escaped credential echoed in successful API response', async () => {
    const fixture = await prepared();
    const envelope = JSON.stringify({ choices: [{ message: {
      content: JSON.stringify({ ...diagnosis(fixture.manifest), explanation: config.apiKey }),
    }, finish_reason: 'stop' }] });
    const escapedEnvelope = envelope.replaceAll(config.apiKey, '\\u0075' + config.apiKey.slice(1));
    assert(!escapedEnvelope.includes(config.apiKey));
    const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config,
      fetchImpl: mockFetch(new Response(escapedEnvelope)) });
    assert.equal(result.code, 'INVALID_DIAGNOSIS'); assert(!JSON.stringify(result).includes(config.apiKey));
  });
});

test('mocked unit: unsafe diagnosis output is refused without following a directory', async () => {
  const fixture = await prepared();
  await mkdir(path.join(path.dirname(fixture.path), 'diagnosis.json'));
  const result = await runDiagnosis({ evidence: fixture.path, allowModelUpload: true, config,
    fetchImpl: mockFetch(mockResponse(diagnosis(fixture.manifest))) });
  assert.equal(result.code, 'OUTPUT_ERROR');
});
