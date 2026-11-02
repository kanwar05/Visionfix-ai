import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { EvidenceManifestSchema } from '../packages/core/dist/diagnosis-evidence.js';
import { generateRepairProposal, checkRepairModelSupport } from '../packages/core/dist/repair-model.js';
import type { Diagnosis } from '../packages/core/dist/diagnosis-model.js';
import type { SourceReview } from '../packages/core/dist/repair-schema.js';
import type { PatchProposal } from '../packages/core/dist/repair-patch.js';

// All fetch responses and patch proposals in this file are UNIT TEST MOCKS.
// They verify infrastructure only, never live AI repair availability or success.
const config = { apiKey: 'unit-test-fake-meta-credential', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3' };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function png() {
  const crc = (buffer: Buffer) => { let value = 0xffffffff; for (const byte of buffer) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, value: Buffer) => { const result = Buffer.alloc(value.length + 12); result.writeUInt32BE(value.length); result.write(type, 4); value.copy(result, 8); result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(320); header.writeUInt32BE(900, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(900 * (320 * 3 + 1)))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() {
  const image = png(); const content = '.card {\n  width: 640px;\n}\n'; const scanId = randomUUID(); const issueId = `${scanId}:320`;
  const source: SourceReview = { path: 'src/styles.css', sha256: hash(content), bytes: Buffer.byteLength(content), content,
    contentSha256: hash(content), startLine: 1, endLine: content.split('\n').length };
  const manifest = EvidenceManifestSchema.parse({ schemaVersion: '2.0.0', createdAt: new Date().toISOString(), scanId, issueId,
    viewport: { width: 320, height: 900, deviceScaleFactor: 1 }, document: { clientWidth: 320, scrollWidth: 640, overflowPx: 320, hasOverflow: true },
    candidates: [{ id: 'candidate-1', selector: '.card', tagName: 'div', rect: { x: 0, y: 0, top: 0, right: 640, bottom: 20, left: 0, width: 640, height: 20 },
      styles: { display: 'block', position: 'static', boxSizing: 'border-box', width: '640px', minWidth: '0px', maxWidth: 'none', overflowX: 'visible', overflowY: 'visible',
        whiteSpace: 'normal', flexWrap: 'nowrap', transform: 'none', marginLeft: '0px', marginRight: '0px' }, viewportWidth: 320, documentWidth: 640, overflowPx: 320 }],
    mappings: [{ candidateId: 'candidate-1', status: 'mapped', snippetIds: ['css-1'], reasons: ['Exact class selector.'] }],
    snippets: [{ id: 'css-1', path: source.path, startLine: 1, endLine: source.endLine, content, sha256: hash(content) }],
    image: { path: 'screenshot.png', sha256: hash(image), bytes: image.length, mimeType: 'image/png', width: 320, height: 900 }, limitations: ['Synthetic unit input.'] });
  const diagnosis: Diagnosis = { issueId, viewportWidth: 320, status: 'grounded', explanation: 'A fixed width is a possible contributor.',
    browserEvidenceIds: ['candidate-1'], sources: [{ snippetId: 'css-1', path: source.path, startLine: 2, endLine: 2, quote: '  width: 640px;' }],
    repairApproach: 'Constrain width without hiding content.', uncertainties: ['A browser check is still required.'], missingEvidence: [] };
  const proposal: PatchProposal = { issueId, explanation: 'Deterministic unit proposal, not live AI output.', uncertainties: [],
    unifiedDiff: '--- a/src/styles.css\n+++ b/src/styles.css\n@@ -1,3 +1,3 @@\n .card {\n-  width: 640px;\n+  width: 100%;\n }\n' };
  return { manifest, imageBase64: image.toString('base64'), diagnosis, sources: [source], allowModelUpload: true, config, proposal };
}
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
const fakeFetch = (value: Response): typeof fetch => (async () => value) as typeof fetch;

test('mocked infrastructure: proposal upload requires permission before evidence/configuration access', async () => {
  const result = await generateRepairProposal({ allowModelUpload: false } as Parameters<typeof generateRepairProposal>[0]);
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'UPLOAD_NOT_AUTHORIZED'); assert.equal(result.requestMade, false);
});

test('mocked infrastructure: request sends only bounded reviewed evidence and structured CSS proposal has no execution authority', async () => {
  const context = fixture(); let calls = 0;
  const result = await generateRepairProposal({ ...context, fetchImpl: (async (url, options) => {
    calls++; assert.equal(url, 'https://api.meta.ai/v1/chat/completions'); assert.equal(options?.redirect, 'error');
    const body = JSON.parse(String(options!.body)); assert.equal(body.model, config.model); assert.equal(body.tools, undefined);
    assert.match(body.messages[0].content, /UNTRUSTED DATA/); assert.equal(body.messages[1].content[1].image_url.url, `data:image/png;base64,${context.imageBase64}`);
    const payload = JSON.parse(body.messages[1].content[0].text);
    assert.deepEqual(Object.keys(payload).sort(), ['approvedCss', 'browserEvidence', 'diagnosis', 'limits']);
    assert.equal(payload.approvedCss[0].content, context.sources[0].content); assert.equal(payload.build, undefined); assert.equal(payload.config, undefined);
    assert(!String(options!.body).includes(config.apiKey));
    return response(context.proposal);
  }) as typeof fetch });
  assert.equal(calls, 1); assert.equal(result.status, 'success'); assert.equal(result.requestMade, true);
  assert.equal(result.model, config.model); assert.equal(result.provider, 'Meta Model API'); assert.deepEqual(result.proposal, context.proposal);
});

test('mocked infrastructure: missing configuration, unknown model or unsafe endpoint never uploads', async (t) => {
  for (const local of [{ ...config, apiKey: '' }, { ...config, model: 'unknown-image-model' },
    { ...config, baseUrl: 'http://api.meta.ai/v1' }, { ...config, baseUrl: 'https://user:private@api.meta.ai/v1' }]) {
    await t.test('configuration preflight', async () => {
      let calls = 0; const result = await generateRepairProposal({ ...fixture(), config: local,
        fetchImpl: (async () => { calls++; throw new Error('Must not upload'); }) as typeof fetch });
      assert.equal(result.status, 'blocked'); assert.equal(result.requestMade, false); assert.equal(calls, 0);
      assert.equal(checkRepairModelSupport(local).isConfigured, false);
    });
  }
});

test('mocked infrastructure: changed source context, invalid diagnosis and image mismatch fail before upload', async (t) => {
  await t.test('source hash', async () => { const context = fixture(); context.sources[0].content += 'changed'; const result = await generateRepairProposal(context); assert.equal(result.code, 'INVALID_REPAIR_EVIDENCE'); assert.equal(result.requestMade, false); });
  await t.test('unmapped diagnosis', async () => { const context = fixture(); context.diagnosis.status = 'unmapped'; context.diagnosis.sources = []; context.diagnosis.missingEvidence = ['No mapped CSS.']; const result = await generateRepairProposal(context); assert.equal(result.code, 'INVALID_REPAIR_EVIDENCE'); });
  await t.test('image changed', async () => { const context = fixture(); context.imageBase64 = context.imageBase64.slice(4); const result = await generateRepairProposal(context); assert.equal(result.code, 'INVALID_REPAIR_EVIDENCE'); });
  await t.test('known credential in reviewed context', async () => {
    const context = fixture(); context.diagnosis.explanation = config.apiKey;
    const result = await generateRepairProposal(context); assert.equal(result.code, 'SENSITIVE_EVIDENCE'); assert.equal(result.requestMade, false);
  });
});

test('mocked infrastructure: invalid JSON/schema, wrong issues, tools, truncated output and credential echoes are rejected', async (t) => {
  const context = fixture();
  const cases: Array<[string, Response]> = [
    ['API JSON', new Response('not json')], ['model JSON', new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] }))],
    ['wrong issue', response({ ...context.proposal, issueId: 'invented' })], ['extra command', response({ ...context.proposal, command: 'untrusted' })],
    ['tool calls', new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(context.proposal), tool_calls: [] } }] }))],
    ['truncation', new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(context.proposal) } }] }))],
    ['credential echo', response({ ...context.proposal, explanation: config.apiKey })],
    ['escaped credential echo', new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...context.proposal, explanation: config.apiKey }) } }] }).replaceAll(config.apiKey, '\\u0075nit-test-fake-meta-credential'))],
  ];
  for (const [name, mocked] of cases) await t.test(name, async () => {
    const result = await generateRepairProposal({ ...context, fetchImpl: fakeFetch(mocked) });
    assert.equal(result.status, 'failed'); assert.equal(result.proposal, undefined); assert.equal(result.requestMade, true);
    assert(!JSON.stringify(result).includes(config.apiKey));
  });
});

test('mocked infrastructure: API errors expose status only without server body or authorization data', async (t) => {
  for (const status of [400, 401, 403, 404, 422, 429, 500]) await t.test(String(status), async () => {
    const result = await generateRepairProposal({ ...fixture(), fetchImpl: fakeFetch(new Response(`private server data ${config.apiKey}`, { status })) });
    assert.equal(result.status, [400, 401, 403, 404, 422].includes(status) ? 'blocked' : 'failed');
    assert.equal(result.requestMade, true); assert(!JSON.stringify(result).includes(config.apiKey)); assert(!JSON.stringify(result).includes('private server data'));
  });
});

test('mocked infrastructure: network errors, request/body deadlines and response limits are bounded', async (t) => {
  await t.test('network error', async () => { const result = await generateRepairProposal({ ...fixture(), fetchImpl: (async () => { throw new Error(config.apiKey); }) as typeof fetch }); assert.equal(result.code, 'NETWORK_ERROR'); assert(!JSON.stringify(result).includes(config.apiKey)); });
  await t.test('request timeout', async () => { const result = await generateRepairProposal({ ...fixture(), timeoutMs: 20, fetchImpl: (() => new Promise(() => undefined)) as typeof fetch }); assert.equal(result.code, 'TIMEOUT'); });
  await t.test('body timeout', async () => { const result = await generateRepairProposal({ ...fixture(), timeoutMs: 20, fetchImpl: fakeFetch(new Response(new ReadableStream({ start() { /* intentionally unfinished */ } }))) }); assert.equal(result.code, 'TIMEOUT'); });
  await t.test('response limit', async () => { const result = await generateRepairProposal({ ...fixture(), fetchImpl: fakeFetch(new Response('x'.repeat(256 * 1024 + 1))) }); assert.equal(result.code, 'RESPONSE_TOO_LARGE'); });
});
