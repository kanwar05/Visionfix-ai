import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { captureRepairContent, compareRepairContent, RepairContentResultSchema, type RepairContentResult } from '../packages/core/dist/repair-browser.js';

// All pages and proposed mutations in this file are deterministic infrastructure
// inputs. Passing these checks does not establish any successful live AI repair.
const root = fileURLToPath(new URL('../', import.meta.url));
let directory: string; let server: Server; let url: string; let baseline: RepairContentResult;
let attemptedPurchases = 0;
const contents = '<section id="target"><h2>Technical details</h2><div><span>Responsive keyboard</span><span>Wireless connectivity</span></div></section>';
const checkout = '<form><button type="button" id="checkout" onclick="alert(\'Checkout test only\');fetch(\'/purchase\',{method:\'POST\'}).catch(()=>{})">Checkout</button></form>';
function html(variant: string): string {
  let css = '*{box-sizing:border-box}body{margin:0;padding:16px;font:16px/1.5 sans-serif}#target{width:100%;max-width:600px;padding:12px;border:1px solid}#target h2{font-size:18px}#target span{display:block}button{margin-top:12px;padding:12px}';
  if (variant === 'overflow' || variant === 'mask') css += '#target{width:480px;max-width:none}';
  if (variant === 'mask') css += 'html,body{overflow-x:hidden}';
  if (variant === 'hidden') css += '#target{display:none}';
  if (variant === 'child-hidden') css += '#target span:first-child{visibility:hidden}';
  if (variant === 'transparent') css += '#target span{color:transparent}';
  if (variant === 'transparent-fill') css += '#target span{-webkit-text-fill-color:transparent}';
  if (variant === 'transparent-modern') css += '#target span{color:rgb(0 0 0 / 0)}';
  if (variant === 'filter-opacity') css += '#target{filter:opacity(0)}';
  if (variant === 'filter-near-zero') css += '#target{filter:opacity(1%)}';
  if (variant === 'paint-same-color') css += '#target{background:#fff}#target span{color:#fff}';
  if (variant === 'paint-brightness') css += '#target{background:#000;color:#fff;filter:brightness(0)}';
  if (variant === 'paint-overlay') css += '#target{position:relative}#target::after{content:"";position:absolute;inset:0;background:#fff;z-index:99;pointer-events:none}';
  if (variant === 'clipped') css += '#target{height:10px;overflow:hidden}';
  if (variant === 'tiny') css += '#target span{font-size:1px}';
  if (variant === 'disabled') css += '#checkout{pointer-events:none}';
  let target = variant === 'removed' ? contents.replace('<span>Wireless connectivity</span>', '') : contents;
  if (variant === 'large') target = '<section id="target">' + '<span>Bounded</span>'.repeat(301) + '</section>';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${target}${checkout}</body></html>`;
}
const options = (variant: string) => ({ url: `${url}/${variant}`, outputDirectory: path.join(directory, variant), targetSelector: '#target', interaction: { selector: '#checkout', expectedDialog: 'Checkout test only' } });

before(async () => {
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  directory = await mkdtemp(path.join(root, 'artifacts', 'phase3-browser-'));
  server = createServer((request, response) => {
    if (request.url === '/purchase') { attemptedPurchases++; response.end('No real purchase'); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html(new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object'); url = `http://127.0.0.1:${address.port}`;
  baseline = await captureRepairContent(options('overflow'));
  assert(baseline.results.every((result) => result.status === 'complete'), JSON.stringify(baseline));
}, { timeout: 60000 });
after(async () => { await new Promise<void>((resolve) => server?.close(() => resolve())); });

test('deterministic infrastructure: matching content, screenshots and guarded clicks pass all original viewports', async () => {
  const after = await captureRepairContent(options('responsive'));
  assert.equal(RepairContentResultSchema.safeParse(after).success, true);
  assert.equal(compareRepairContent(baseline, after).passed, true, JSON.stringify(compareRepairContent(baseline, after)));
  assert.deepEqual(after.results.map((result) => result.width), [320, 375, 390, 768, 1440]);
  for (const result of after.results) {
    assert.equal(result.status, 'complete'); assert.equal(result.interaction.clickReceived, true);
    assert.equal(result.interaction.dialogMatched, true); assert.equal(result.interaction.networkBlocked, true);
    const image = await readFile(path.join(options('responsive').outputDirectory, result.screenshot!));
    assert.deepEqual([...image.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    assert.equal(image.readUInt32BE(16), result.width); assert.equal(image.readUInt32BE(20), 900);
  }
  assert.equal(attemptedPurchases, 0, 'Guarded clicks must never send the simulated purchase request.');
  assert(!JSON.stringify(after).includes('Wireless connectivity'), 'Reports contain target hashes, not raw text.');
}, { timeout: 60000 });

test('deterministic infrastructure: hiding, removal, clipping, tiny text and document masking are rejected', async (t) => {
  for (const [variant, reason] of [
    ['hidden', 'TARGET_CONTENT_HIDDEN_OR_CLIPPED'], ['child-hidden', 'TARGET_CONTENT_HIDDEN_OR_CLIPPED'],
    ['transparent', 'TARGET_CONTENT_HIDDEN_OR_CLIPPED'], ['transparent-fill', 'TARGET_CONTENT_HIDDEN_OR_CLIPPED'],
    ['transparent-modern', 'TARGET_CONTENT_HIDDEN_OR_CLIPPED'], ['filter-opacity', 'TARGET_CONTENT_HIDDEN_OR_CLIPPED'],
    ['filter-near-zero', 'TARGET_CONTENT_HIDDEN_OR_CLIPPED'],
    ['removed', 'TARGET_CONTENT_CHANGED'], ['clipped', 'TARGET_CONTENT_HIDDEN_OR_CLIPPED'],
    ['tiny', 'TARGET_TEXT_SHRUNK'], ['mask', 'DOCUMENT_OVERFLOW_MASKED'],
  ]) await t.test(variant, async () => {
    const after = await captureRepairContent(options(variant));
    const comparison = compareRepairContent(baseline, after);
    assert.equal(comparison.passed, false);
    assert(comparison.reasons.some((item) => item.endsWith(reason)), JSON.stringify(comparison));
  });
}, { timeout: 120000 });

test('deterministic infrastructure: pointer-blocked checkout cannot pass interaction verification', async () => {
  const after = await captureRepairContent(options('disabled'));
  assert(after.results.every((result) => result.status === 'failed' && !result.interaction.passed));
  assert.equal(compareRepairContent(baseline, after).passed, false);
  assert.equal(attemptedPurchases, 0);
}, { timeout: 60000 });

test('deterministic infrastructure: changed paint cannot hide geometry-clean target text', async (t) => {
  for (const variant of ['paint-same-color', 'paint-brightness', 'paint-overlay']) await t.test(variant, async () => {
    const after = await captureRepairContent(options(variant));
    assert(after.results.every((result) => result.status === 'complete' && result.target!.withinViewportX));
    const comparison = compareRepairContent(baseline, after);
    assert.equal(comparison.passed, false);
    assert(comparison.reasons.some((reason) => reason.endsWith('TARGET_PAINT_CHANGED')), JSON.stringify(comparison));
    if (variant === 'paint-same-color') assert(after.results.every((result) => result.target!.text.some((text) => !text.visible)));
    assert(after.results.every((result) => result.target!.text.every((text) => /^[a-f0-9]{64}$/.test(text.paintHash))));
    assert(!JSON.stringify(after).includes('background-color'), 'Raw paint descriptors must not be persisted.');
  });
}, { timeout: 60000 });

test('deterministic infrastructure: bounded content and missing/invalid targets fail explicitly', async () => {
  const bounded = await captureRepairContent({ ...options('large'), interaction: undefined });
  assert(bounded.results.every((result) => result.status === 'failed' && result.target === null));
  const missing = await captureRepairContent({ ...options('responsive'), targetSelector: '#missing' });
  assert(missing.results.every((result) => result.status === 'failed'));
  await assert.rejects(captureRepairContent({ ...options('responsive'), targetSelector: '' }));
}, { timeout: 60000 });

test('deterministic infrastructure: evidence binding rejects an unrelated target and permits a matching element alias', async () => {
  const binding = { viewportWidth: 320, selectors: ['section#target'] };
  const unrelated = await captureRepairContent({ ...options('responsive'), targetSelector: '#checkout', interaction: undefined, evidenceBinding: binding,
    outputDirectory: path.join(directory, 'unrelated-binding') });
  assert.equal(unrelated.results[0].status, 'complete');
  assert.deepEqual(unrelated.results[0].evidenceBinding, { required: true, matched: false });
  assert(unrelated.results.slice(1).every((result) => !result.evidenceBinding.required && result.evidenceBinding.matched));
  const alias = await captureRepairContent({ ...options('responsive'), interaction: undefined, evidenceBinding: binding,
    outputDirectory: path.join(directory, 'alias-binding') });
  assert.deepEqual(alias.results[0].evidenceBinding, { required: true, matched: true });
  assert.equal(compareRepairContent(alias, alias).passed, true);
  assert.equal(compareRepairContent(unrelated, unrelated).passed, false);
  assert(compareRepairContent(unrelated, unrelated).reasons.includes('320:EVIDENCE_TARGET_MISMATCH'));
}, { timeout: 60000 });
