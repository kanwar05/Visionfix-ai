# Verification results — Phase 1

Verified on 2026-10-30 (Asia/Calcutta), Windows PowerShell, Node v24.21.0 and npm 12.1.0.

**Phase 1 PASSED:** the public `npm test` command built the packages and fixture, then passed **35/35 real-browser/CLI tests**, with zero failures, skipped tests or cancellations. The existing Phase 0 Playwright smoke check also passed. **Meta API: BLOCKED / unverified**, retained from Phase 0; no model request was made in this phase.

Implementation and initial verification occurred in the ignored isolated copy `artifacts/phase1-workspace/`. The reviewed Phase 1 tool changes were then applied to this repository as requested, and the public test command and typecheck were verified here. Target-project inspection copies only package.json into a temporary directory; tests run the target fixture from another isolated copy. Target source and credential files are never collected for scans.

## Files created or modified

Created:

- `packages/core/src/scan-schema.ts`: exported Zod schemas/types, version, widths, tolerance and candidate bound.
- `packages/core/src/scan-project.ts`: local URL and isolated manifest validation.
- `packages/core/src/browser-scan.ts`: browser lifecycle, readiness, navigation policy, screenshots and failures.
- `packages/core/src/overflow.ts`: generic DOM geometry evidence and candidate grouping.
- `packages/core/src/scan.ts`: scan orchestration, output isolation, report serialization and exit-code policy.
- `tests/healthy.html`: controlled responsive layout with an intentional contained carousel.
- `tests/scan.test.ts`: real Chromium, validation, preservation and CLI regressions.

Modified:

- `package.json`, `package-lock.json`, `packages/core/package.json`: ordered build, tests and runtime Playwright dependency declaration; no new dependency package was introduced.
- `packages/core/src/index.ts`, `packages/core/src/config.ts`: Phase 1 exports and lazy Meta credential loading so scan imports never load .env.
- `packages/cli/src/index.ts`, `packages/cli/bin/visionfix.js`: async scan command, help, safe formatting and exit codes.
- `README.md`, `docs/PHASES.md`, `docs/ARCHITECTURE.md`, `docs/RESULTS.md`: supported behavior, boundaries, commands and actual evidence.

The original broken-shop source, smoke scripts, AGENTS.md and credential template are unchanged. The existing ignored .env was not opened, overwritten, copied or retried during Phase 1. No changes were pushed.

## Commands actually executed

Commands are shown in their PowerShell spelling. Public commands also work with `npm` instead of `npm.cmd`.

| Command | Location | Outcome |
|---|---|---|
| `node --version`; `npm.cmd --version` | Isolated implementation copy | PASSED: v24.21.0 / 12.1.0 |
| `npm.cmd run build` | Isolated implementation copy | PASSED after fixing core-before-CLI build order; fixture production build succeeded |
| `npm.cmd run typecheck` | Isolated implementation copy and repository root | PASSED, exit 0 |
| `npm.cmd run --workspace=@visionfix/core typecheck` | Isolated implementation copy | PASSED, exit 0 |
| `npm.cmd run --workspace=@visionfix/core build` | Isolated implementation copy | PASSED, exit 0 |
| `node --import tsx --test tests/scan.test.ts` | Isolated implementation copy | PASSED: 34/34 before adding the final reload regression |
| `npm.cmd test` | Repository root | PASSED, exit 0: ordered build followed by 35/35 tests; test duration 23.56 seconds |
| `npm.cmd run cli -- --version` | Both locations | PASSED, exit 0; version 0.1.0 / Phase 1 |
| `npm.cmd run cli -- --help` | Repository root | PASSED, exit 0 |
| `npm.cmd run cli -- scan --help` | Isolated implementation copy; also exercised through CLI tests | PASSED, exit 0 |
| `npm.cmd run test:smoke:playwright` | Isolated implementation copy | PASSED, exit 0: 320px client / 517px scroll / 197px overflow, real PNG; browser and fixture process closed |
| `git -c core.autocrlf=false diff --check` | Repository root | PASSED |
| `git diff --exit-code -- fixtures/broken-shop scripts/smoke-playwright.ts scripts/smoke-meta.ts .env.example` | Repository root | PASSED: no changes |
| `git check-ignore .env artifacts/phase1-workspace` | Repository root | PASSED: both remain ignored |

Dependencies and Chromium were already installed. Neither `npm install` nor `npx playwright install chromium` was rerun.

The test suite invokes `node packages/cli/bin/visionfix.js` against test-owned running URLs and validates actual process exit codes: healthy = 0, broken = 1, unreachable/invalid configuration = 2. CLI errors do not echo a credential sentinel.

## Failures encountered and resolved

- Initial workspace commands attempted CLI compilation before fresh core declarations existed. The build now orders core before CLI; typecheck generates core declarations first.
- Sandboxed Vite/esbuild config resolution was denied, and sandboxed tsx failed with `uv_os_get_passwd ENOMEM` before test execution. Retrying the exact required build/test/smoke commands with approved execution outside that sandbox succeeded. These environmental failures were not counted as passing browser checks.
- An early test used an output parent equal to its copied target-project directory. The scanner correctly rejected it. The test now uses a separate report parent.
- One intermediate broken-shop scan was correctly `partial` because cold Vite dependency optimization reloaded the document during readiness. The test harness now establishes its separately running fixture's readiness; production readiness also retries only recognized execution-context replacement errors within one five-second budget. A deterministic one-reload browser regression passes.
- Review exposed incorrect handling of body scrollers, restored visibility and fixed descendants. Real-browser regression tests now cover the corrected behavior.
- Ordinary Playwright routing alone did not prevent every HTTP redirect hop. Chromium response interception now checks every top-level redirect Location before following it. Controlled direct/chained/script redirects received **zero requests** at the disallowed 127.0.0.2 destination. Nested document navigation fails closed, including the cross-local-host iframe regression.

There are no outstanding failed Phase 1 checks. Negative test pages intentionally produce failed reports; the tests pass by verifying those explicit failures.

## Actual scan evidence

Both reports below are from the final repository-root `npm test` run. Each is schema-valid with status `complete`, all five viewports, no failed checks and five existing PNG screenshots.

| Viewport | Broken document width | Broken overflow | Broken candidates | Healthy document width | Healthy overflow / candidates |
|---|---:|---:|---:|---:|---|
| 320 × 900 | 517px | 197px | 1 | 320px | 0px / 0 |
| 375 × 900 | 517px | 142px | 1 | 375px | 0px / 0 |
| 390 × 900 | 517px | 127px | 1 | 390px | 0px / 0 |
| 768 × 900 | 768px | 0px | 0 | 768px | 0px / 0 |
| 1440 × 900 | 1440px | 0px | 0 | 1440px | 0px / 0 |

- [Actual broken-shop report](../artifacts/phase1-tests-euYZfy/reports/broken-shop/593fbe53-5aad-488e-a4ad-4e5b5960532a/report.json), scan ID `593fbe53-5aad-488e-a4ad-4e5b5960532a`; CLI exit 1.
- [Actual healthy report](../artifacts/phase1-tests-euYZfy/reports/healthy/7a251764-ef06-442c-9d9d-cbe3570146cc/report.json), scan ID `7a251764-ef06-442c-9d9d-cbe3570146cc`; CLI exit 0.
- [Broken 320px screenshot](../artifacts/phase1-tests-euYZfy/reports/broken-shop/593fbe53-5aad-488e-a4ad-4e5b5960532a/screenshots/320.png).
- [Healthy 320px screenshot](../artifacts/phase1-tests-euYZfy/reports/healthy/7a251764-ef06-442c-9d9d-cbe3570146cc/screenshots/320.png).

Artifacts are deliberately ignored and remain local. The test-owned HTTP URLs use temporary ports and no longer run after cleanup. The CLI integration scans independently confirmed the same exit-code policy; their reports are under the same run's `cli-reports/` directory.

The broken 320px candidate is a 480px-wide div with structural locator, bounding rectangle, width/min/max-width, overflow, layout and transform evidence. Its candidate status does not prove the CSS root cause. Tests use fixture expectations; production detection has no fixture identifiers.

## Exact manual verification

From the repository root, set up a fresh installation using separate commands:

```powershell
npm install
npx playwright install chromium
npm run build
npm run typecheck
npm test
```

Terminal 1: start broken-shop separately and leave it running:

```powershell
npm run fixture:dev
```

Terminal 2: execute this single line, which works in Windows PowerShell:

```powershell
npm run cli -- scan --project ./fixtures/broken-shop --url http://127.0.0.1:5180
```

Expected: complete scan, overflow at 320/375/390px, exit 1, and the printed report path under `artifacts/scans/<scan-id>/report.json`. In PowerShell inspect `$LASTEXITCODE` immediately after the command. Open the report and its relative `screenshots/<width>.png` files. Candidate evidence is bounded to 20 entries per viewport; document overflow uses a 1px tolerance.

To inspect the healthy controlled page, run this separate server in another terminal:

```powershell
node node_modules/vite/bin/vite.js tests --host 127.0.0.1 --port 5181 --strictPort
```

Then run:

```powershell
npm run cli -- scan --project ./fixtures/broken-shop --url http://127.0.0.1:5181/healthy.html --output ./artifacts/manual-healthy
```

Expected: complete scan, zero overflow/candidates at all widths, exit 0, and five real PNGs. The existing fixture manifest supplies the supported React/Vite project declaration for this controlled HTML page; URL/project association is supplied by the operator and is not established by the scanner.

Stop the target server with Ctrl+C, then repeat its scan command. Expected: explicit failed viewports, overall failed status and exit 2. Reject configuration independently with:

```powershell
npm run cli -- scan --project ./missing-project --url http://127.0.0.1:5180
npm run cli -- scan --project ./fixtures/broken-shop --url https://example.com
```

Both exit 2. Scanning never starts the missing server.

Exit codes: **0** = complete without detected issues; **1** = complete with document overflow/candidates; **2** = invalid configuration or incomplete/failed scan. Reports contain schema version, scan ID, timestamps, target URL, project metadata, all configured viewports, evidence, errors and relative screenshot paths.

## Known limitations and privacy

- Light DOM geometry only. Shadow-root and iframe contents are not traversed. Nested document/popup network navigations are blocked with explicit failures; inherited empty about:blank/srcdoc frames may remain.
- A snapshot does not discover arbitrary delayed rendering, scroll-triggered lazy content, all clipping/overlap or CSS root causes. Complex absolute-position clipping, rotated transforms and clip paths can affect candidate precision.
- Navigation has a 10-second timeout; readiness has one 5-second budget; screenshots have a 10-second timeout. These bounds are not an OS execution sandbox for hostile synchronous page scripts.
- Screenshots are always viewport-only at scale 1 (maximum 1440 × 900); document evidence can describe elements below the image. Candidate lists are capped at 20 and mark truncation.
- The URL allowlist is **not a network sandbox**. External subresources and application-side network activity are outside this restriction. Service workers are blocked for repeatability.
- Screenshots, URLs/query strings, project paths and computed styles can contain sensitive information. Reports are local and ignored; review before sharing.
- No AI diagnosis, source mapping, repairs or dashboard is implemented. No external model request occurs during a scan.

## Retained Phase 0 Meta status: BLOCKED

The earlier real Meta API check had no verified textual model response. Missing/invalid local credentials remain an actionable blocker; an earlier invalid-token HTTP401 was not proof of successful integration. Phase 1 did not open local credentials or rerun the API request.

To verify separately, obtain a valid token from Meta's dashboard, set it locally in the existing ignored .env (do not overwrite an existing credential file), and run `npm run test:smoke:meta`. Only a real successful textual model response can change this status to PASSED. Never paste credentials into chat or logs.

Earlier Phase 0 tooling checks were already recorded as passing dependency/browser installation, build, typecheck, CLI version and Playwright smoke capture. This phase freshly reconfirmed the build, typecheck, CLI and Playwright smoke behavior described above; it does not claim new dependency installation or successful model integration.
