# VisionFix AI — StressProof

Phase 1 implements local browser inspection and horizontal overflow detection for a separately running React + Vite application. The existing Phase 0 CLI, fixture, Playwright smoke test and Meta smoke-test command remain available. AI diagnosis, source mapping, repairs and dashboards are future work.

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

This is a rendered DOM geometry snapshot. It does not diagnose CSS, map source, detect general overlap/clipped text, repair files or create HTML reports. It does not traverse shadow roots or iframe contents, scroll to lazy content, expand carousels, or wait for arbitrary app-specific async work. Nested document navigation and popups fail explicitly; empty inherited about:blank/srcdoc frames may remain. Dynamic layouts, clipping shapes, rotated transforms, complex absolute-position clipping and other paint behavior can limit candidate precision. The 20-candidate cap is marked when truncated. Long pages may have evidence below the captured viewport. A bounded navigation/font timeout is not an operating-system execution limit for hostile page JavaScript.

## Phase 0 Meta check

The real Meta API smoke test remains **BLOCKED / unverified**. Phase 1 does not retry or claim a successful model call. Existing local credentials are preserved. To verify separately, configure a valid token locally in an ignored `.env` using `.env.example`, then run:

```powershell
npm run test:smoke:meta
```

Do not overwrite an existing credential file. Only the explicitly invoked Meta configuration check loads `.env`; scanning does not.
