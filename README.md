# VisionFix AI — StressProof

Phase 2 adds reviewed evidence preparation, heuristic source mapping and a real configurable Meta multimodal diagnosis client to the Phase 1 scanner. The Phase 0 CLI, fixture and smoke commands remain available. No patches, repair execution, dashboard or GitHub integration are implemented.

## Setup

Use Node.js 20+ and npm 10+ (verification used Node 24.21.0 and npm 12.1.0). From the repository root, run these commands separately:

```powershell
npm install
npx playwright install chromium
npm run build
npm run typecheck
```

Build order is core, CLI, then broken-shop. Typecheck builds core declarations before checking the CLI.

## Run a scan

Start the target yourself in terminal 1 and leave it running:

```powershell
npm run fixture:dev
```

The existing broken-shop fixture listens on port **5180**. In terminal 2, from the repository root, use this single-line command (also valid in Windows PowerShell):

```powershell
npm run cli -- scan --project ./fixtures/broken-shop --url http://127.0.0.1:5180
```

For an existing application, start it normally yourself, then supply its project directory and running local URL. The scanner never installs dependencies, runs project scripts or starts the application. The project manifest and URL are supplied independently; the scanner cannot establish that a server belongs to that directory.

Optional output parent (every scan still gets its own UUID subdirectory):

```powershell
npm run cli -- scan --project ./fixtures/broken-shop --url http://127.0.0.1:5180 --output ./artifacts/manual-scans
npm run cli -- scan --help
npm run cli -- --help
npm run cli -- --version
```

Only absolute HTTP URLs on `localhost`, `127.0.0.1` or `[::1]` are accepted. HTTPS, other hosts and credential-bearing URLs are rejected. Every top-level HTTP redirect hop is checked before following it, including chains through local URLs. Nested document navigations and popup navigations are unsupported and blocked with explicit scan failures. A fresh Chromium context is used for each width, without saved browser credentials, cookies or localStorage.

The local URL restriction **is not a network sandbox**: pages can load external subresources or contact services, and the separately running application retains its own permissions. Scan only applications you trust.

## Evidence and report format

All scans attempt widths **320, 375, 390, 768 and 1440px**, at height **900px** and device scale factor **1**. Navigation has a 10-second timeout; readiness uses one 5-second budget for DOM/fonts and a short settle interval; screenshot capture has a 10-second timeout. Recognized execution-context replacement during a reload is retried only within that readiness budget. Animations and transitions are disabled; there is no networkidle wait. Navigation, readiness, browser and screenshot errors produce explicit failures.

Each ignored report directory contains `report.json` and `screenshots/<width>.png` for viewports that reach successful screenshot capture. Screenshots capture the viewport only, bounding image dimensions at 1440 × 900; geometry still measures the rendered document beyond the screenshot.

Exported Zod schemas and TypeScript types live in `packages/core/src/scan-schema.ts`. The report includes:

- Schema version `1.0.0`, UUID scan ID, ISO timestamps, target URL and validated project metadata.
- Tested viewports and overall `complete`, `partial` or `failed` status.
- Per-viewport status, document clientWidth/scrollWidth/overflow, candidate evidence and explicit errors.
- Relative screenshot paths, capture dimensions, a **1 CSS pixel** rounding tolerance and a **20 candidate** limit.

A complete scan means every check completed; it may still contain overflow. Partial means some viewports completed and others failed (or a scan-level error occurred). Failed means none completed. A failed viewport is never a healthy check. Browser error details are recorded as bounded categories with generic messages, so arbitrary page exception/console text is not copied into reports.

Document overflow is measured independently from **candidate contributors**. Candidates include a structural locator, tag, bounding rectangle, selected computed styles and width/overflow measurements. They are evidence, not proven CSS root causes. The detector groups overflowing descendants under their outermost overflowing branch, ignores hidden elements and clips descendant evidence at intentional scroll/clip regions. An oversized scroll container itself remains a candidate. Left-edge candidates can exist without an increased document scrollWidth.

Output defaults to `artifacts/scans/<scan-id>/`. A custom `--output` is the parent directory, must be outside the inspected project, and receives a per-scan `.gitignore`. Only `package.json` is copied to a temporary isolated inspection directory and parsed there; source files and `.env` are not collected or read. No external model calls occur during scanning.

**Privacy:** screenshots, URLs (including query strings), project paths and computed styles can contain sensitive information. Reports remain local and ignored by Git; review them before sharing.

| Exit code | Meaning |
|---|---|
| 0 | Complete scan, no detected document overflow or candidate issues |
| 1 | Complete scan, detected overflow/candidates |
| 2 | Invalid options/project/URL, or partial/failed scan |

## Verification

```powershell
npm test
npm run test:smoke:playwright
npm run fixture:build
npm run fixture:preview
```

`npm test` builds first, then runs real Chromium tests against test-owned HTTP pages and an isolated broken-shop copy. Tests verify responsive layouts, contained carousels, oversized scroll containers, hidden elements, grouping, rounding tolerance, local URL policy, redirects, failures, fresh browser state, source preservation and PNG/schema validity. Fixtures and `tests/healthy.html` are verification inputs.

See [actual results and manual steps](docs/RESULTS.md) and [phase boundaries](docs/PHASES.md).

## Current limitations

The scanner records a rendered DOM geometry snapshot. It does not detect general overlap/clipped text, repair files or create HTML reports. It does not traverse shadow roots or iframe contents, scroll to lazy content, expand carousels, or wait for arbitrary app-specific async work. Nested document navigation and popups fail explicitly; empty inherited about:blank/srcdoc frames may remain. Dynamic layouts, clipping shapes, rotated transforms, complex absolute-position clipping and other paint behavior can limit candidate precision. The 20-candidate cap is marked when truncated. Long pages may have evidence below the captured viewport. A bounded navigation/font timeout is not an operating-system execution limit for hostile page JavaScript.

## Phase 0 Meta check

The earlier Phase 0 smoke test remains **BLOCKED / unverified**. Its text-only command is separate from Phase 2's image diagnosis acceptance check recorded in docs/RESULTS.md. Existing local credentials are preserved. To verify separately, configure a valid token locally using the safe names in `.env.example`, then run:

```powershell
npm run test:smoke:meta
```

Do not overwrite an existing credential file. Only explicitly invoked Meta commands (the smoke check or authorized diagnosis upload) load `.env`; scanning and preparation do not.

## Prepare, review and upload diagnosis evidence

Keep the target running as above, and generate a fresh scan. The following commands work individually in Windows PowerShell, from the repository root (use `npm.cmd` if your PowerShell execution policy blocks `npm.ps1`):

```powershell
npm.cmd run build
npm.cmd run cli -- scan --project ./fixtures/broken-shop --url http://127.0.0.1:5180
$scan = Get-ChildItem -LiteralPath ./artifacts/scans -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
npm.cmd run cli -- diagnose --project ./fixtures/broken-shop --report (Join-Path $scan.FullName 'report.json') --prepare
$prepared = Get-ChildItem -LiteralPath $scan.FullName -Directory -Filter 'diagnosis-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$evidence = Join-Path $prepared.FullName 'manifest.json'
Get-Content -LiteralPath $evidence
Start-Process -FilePath (Join-Path $prepared.FullName 'screenshot.png')
```

Preparation performs **no API request or configuration load**. It validates the Phase 1 report, its project association and screenshot, then selects the first completed viewport containing measured overflow/candidates. Failed viewport scans are excluded. It reads only bounded approved source into a private temporary snapshot, parses the copy, and writes a new `diagnosis-<uuid>` directory next to the report. The original report and target source are preserved. Preparation requires the report outside the target project.

Review the complete manifest and image. They show precisely the browser geometry/styles, relative source snippets with inclusive line numbers, mapping confidence and PNG that will be sent. The request also contains a fixed diagnosis-only system instruction, output schema and configured model ID. It contains no full repository, target URL, absolute project path, tools or environment values. Authentication uses the configured token in a header that is never logged.

Only after review, run this separate explicit upload command:

```powershell
npm.cmd run cli -- diagnose --evidence $evidence --allow-model-upload
$LASTEXITCODE
Get-Content -LiteralPath (Join-Path $prepared.FullName 'diagnosis.json')
```

Configure `META_API_KEY`, `META_BASE_URL` and `META_MODEL` locally in the existing ignored `.env` or process environment. **Never delete, overwrite, display or log credential files.** Upload alone loads configuration. Defaults remain the existing `https://api.meta.ai/v1` and `muse-spark-1.3`; the endpoint and model are configurable. Phase 2 permits documented Muse Spark 1.1/1.2/1.3 models (including 1.3 contributor), HTTPS without embedded credentials/query/fragment, and the Chat Completions image format `image_url: { url: 'data:image/png;base64,...' }`. Unverified models block before transmission; no provider or model is substituted. Official [image guidance](https://dev.meta.ai/docs/image-understanding), [chat schema](https://dev.meta.ai/docs/api-reference/chat-completions/schemas), [models](https://dev.meta.ai/docs/models) and [structured output](https://dev.meta.ai/docs/structured-output) were checked on 2026-11-01.

`review.sha256` seals the exact manifest bytes; the manifest hashes the image and each reviewed snippet. Upload refuses changed evidence. The digest is a consistency check, not a signature against someone able to replace both files. To update evidence, prepare and review a new directory. Upload sends the reviewed snapshot; it does not reread or claim the target source is unchanged since preparation. Responses are bounded to 256 KiB and a 30-second deadline including body reading; redirects fail rather than forwarding credentials.

| Diagnosis exit code | Meaning |
|---|---|
| 0 | Local preparation succeeded, or a model diagnosis and references validated; diagnosis may be uncertain/unmapped |
| 2 | Invalid options/evidence, changed evidence, network/timeout/server failure, invalid JSON or unsupported references |
| 3 | Upload permission missing, missing credentials, unavailable access/model or unverified image support |

Authorized attempts on valid evidence save a separate `diagnosis.json` with `success`, `blocked` or `failed`, a stable code, limitations and any validated diagnosis. Consent refusal or invalid evidence creates no output. `grounded` means an evidence-supported hypothesis, never a verified root cause. Source references must cite supplied paths, existing reviewed line ranges and exact quotes; invented references fail. Ambiguous mappings cannot support grounded status. Suggested repairs are text only.

Source search is limited to CSS (including modules), JSX and TSX under `src`, `app`, `pages`, `components` and `styles`. Dotfiles, credential/secret-like names, dependencies, build/report/generated outputs and binary content are excluded. Escaping symlinks are rejected; internal source symlinks are skipped. Literal class/ID evidence is preferred. Structural Phase 1 selectors can suggest static JSX ancestry and CSS class matches, but these remain ambiguous. Dynamic rendering, imported component expansion, unusual CSS module transforms and CSS escapes can remain unmapped. No fixture identifiers are built into the locator.

Bounds: 2 MiB report, 4 MiB PNG, 512 KiB manifest, one viewport, five browser candidates, 200 source files / 2,000 entries, 128 KiB per source file / 1 MiB aggregate, and 20 snippets of at most 24 lines / 4 KiB each / 32 KiB aggregate. Evidence loaders additionally enforce reviewed snippet and total limits. Truncation is recorded. Only valid bounded RGB/RGBA PNG screenshots matching the viewport are accepted; hidden textual metadata is rejected.

**Privacy:** text filtering is best effort and cannot guarantee removal of every secret. Screenshot pixels are not redacted and can contain sensitive details. Review every snippet and the image before upload. Untrusted webpage/source/image contents are data, never instructions; the model receives no shell or filesystem tools. This is not an OS sandbox for concurrently hostile filesystem mutation.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:scan
npm.cmd run test:diagnose
```

Model responses are mocked only in clearly labeled unit tests. Those tests prove validation/error handling, not live integration. See docs/RESULTS.md for the actual multimodal acceptance outcome and remaining blockers.
