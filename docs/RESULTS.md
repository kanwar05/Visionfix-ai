# Verification results — Phase 2

Verified on 2026-11-01 (Asia/Calcutta), Windows PowerShell, Node v24.21.0 and npm 12.1.0. Implementation and initial verification occurred in `artifacts/phase2-workspace/`. The reviewed Phase 2 changes were then applied to the developer workspace at the user's explicit request. Existing credential files were not displayed, copied, overwritten or deleted. The upload application alone attempted to load local configuration through the existing loader; no credential values or authorization headers were logged.

**Phase 2: PARTIALLY VERIFIED.** Local source mapping/evidence preparation and independent response validation are implemented. Build, typecheck and retained headless screenshot capture pass. The final `npm.cmd test` run passed **97/97 tests** (35 retained Phase 1 tests plus 62 Phase 2 tests), with zero failures, skips or cancellations. **Live Meta diagnosis: BLOCKED / MISSING_CONFIG (native CLI exit 3).** No external model request was made and no live model diagnosis was obtained. Mocked unit tests are not evidence of live integration.

## Files changed for Phase 2

- `AGENTS.md`: explicit prohibition on deleting, overwriting, displaying or logging existing `.env` files/credentials.
- `packages/core/src/source-locator.ts`: approved source snapshot, generic selector/static JSX ancestry/CSS module matching, relative bounded snippets and mapping uncertainty.
- `packages/core/src/privacy.ts`: best-effort text secret filtering that preserves line numbers.
- `packages/core/src/diagnosis-evidence.ts`: Phase 1 validation, safe PNG/source evidence preparation, local manifest, hashes and upload-time integrity checks.
- `packages/core/src/diagnosis-model.ts`: officially documented Meta image requests, explicit consent, bounded HTTP handling, structured diagnosis and independent evidence-reference validation.
- `packages/core/src/index.ts`, `packages/cli/src/index.ts`: Phase 2 exports, CLI workflow, summaries and 0/2/3 diagnosis exit codes. Phase 1 scan behavior and 0/1/2 exit codes remain independent of API configuration.
- `package.json`, `packages/core/package.json`, `package-lock.json`: Phase 2 test commands and existing TypeScript compiler package declared as a core runtime dependency for JSX parsing. No new library family/provider was introduced.
- `tests/source-locator.test.ts`, `tests/evidence.test.ts`, `tests/diagnosis-model.test.ts`, `tests/diagnosis-cli.test.ts`: required positive, negative, preservation, unit-mocked model and real-browser workflow coverage.
- `README.md`, `docs/PHASES.md`, `docs/RESULTS.md`: supported commands, boundaries, privacy, exit codes and actual outcomes.

No fixture source, existing Phase 1 implementation/tests, Phase 0 smoke script or credential template was changed. No repair, patch execution, dashboard or GitHub integration was implemented. No changes were committed or pushed.

## Commands actually executed

The initial commands below ran from `artifacts/phase2-workspace/` unless marked otherwise. Post-application checks are recorded separately below and ran from the repository root.

| Command/check | Actual outcome |
|---|---|
| `node --version`; `npm.cmd --version` | PASSED: v24.21.0 / 12.1.0 |
| `npm.cmd install --ignore-scripts --no-audit --no-fund` | PASSED: 83 packages installed in isolated copy |
| `npm.cmd install --workspace=@visionfix/core typescript@^5.8.2 --save-prod --ignore-scripts --no-audit --no-fund` | Initial sandbox registry EACCES; identical command with approved execution PASSED, 1 package added |
| `npm.cmd run build` | PASSED: core, CLI and fixture production builds. First attempt during parallel implementation failed because diagnosis-model.ts had not yet been created; resolved before checks |
| `npm.cmd run typecheck` | PASSED; core declarations and workspace checks |
| `node --import tsx --test tests/source-locator.test.ts` | PASSED: 10/10; sandbox tsx startup first failed with uv_os_get_passwd ENOMEM; approved execution passed |
| `node --import tsx --test tests/evidence.test.ts` | PASSED: 9/9 after adding oversize-style regression; same initial sandbox startup issue, approved execution passed |
| `node --import tsx --test tests/diagnosis-cli.test.ts` | PASSED: 2/2, including a real broken-shop scan, successful preparation, consent refusal, missing-config status and unchanged source/report hashes |
| `node --import tsx --test tests/diagnosis-model.test.ts` | PASSED: 41/41 clearly labeled mocked unit tests after fixing fixture identity; not live model verification |
| `npm.cmd test` | PASSED: final 97/97, exit 0, 23.18 seconds of test execution after ordered build; includes all 35 retained Phase 1 tests |
| `npm.cmd run cli -- diagnose --help` | PASSED: Phase 2 workflow and exit codes printed, exit 0 |
| `npm.cmd run test:smoke:playwright` | PASSED: actual 320px clientWidth / 517px scrollWidth / 197px overflow; real PNG, browser and fixture process closed |
| Inspect prepared `manifest.json`; view `screenshot.png` | PASSED: full reviewed evidence contains only the selected browser data, two relevant relative snippets and bounded PNG |
| Authorized isolated CLI from original repository cwd, shown below | BLOCKED: MISSING_CONFIG; native exit 3, saved separate diagnosis.json, no network/model request |
| Before application: `git status --short` at original repository root | PASSED: empty; all tracked developer files preserved before the approved transfer |
| `git diff --exit-code -- fixtures/broken-shop scripts/smoke-playwright.ts scripts/smoke-meta.ts .env.example` at original root | PASSED: no changes |
| `git check-ignore .env artifacts/phase2-workspace` at original root | PASSED: both ignored |
| `node artifacts/create-phase2-review.mjs` | PASSED: generated reviewed diff/hash inventory for 17 changed files; read-only `git apply --check` against original checkout passed |

An initial full run had 56 passing / 26 failing tests. Model test cases failed during synthetic fixture creation because `issueId: test-issue` violated the stricter evidence issue identity schema; those failures did not exercise or prove model handling. The test fixture was corrected to derive the issue ID from its scan ID and viewport. Review also required at least one browser reference for all accepted diagnoses and changed oversized browser styles from silent truncation to explicit rejection. Final results above supersede that failed run.

## Application to the developer workspace

The user explicitly authorized transferring Phase 2 into the actual Visionfix-ai project. The reviewed patch was applied, and all 17 changed files matched the reviewed contents after normalizing line endings. An initial byte-hash comparison reported differences caused by Git's CRLF conversion; the subsequent normalized-content comparison passed. The documentation was then updated to record application and point to the retained review artifacts. Credential files and target fixture sources were preserved.

| Command/check at repository root | Actual outcome |
|---|---|
| Apply reviewed patch and compare all 17 files | PASSED: normalized contents matched the reviewed implementation |
| `npm.cmd install --offline --ignore-scripts --no-audit --no-fund` | PASSED: 1 package added from the local cache |
| `npm.cmd test` | PASSED: 97/97 tests, zero failures, skips or cancellations; 24.14 seconds of test execution; ordered core, CLI and fixture production builds also passed |
| `npm.cmd run typecheck` | PASSED: exit 0 |
| `npm.cmd run cli -- --version` | PASSED: reports Phase 2 |
| `npm.cmd run cli -- diagnose --help` | PASSED: diagnosis workflow and exit codes printed |
| `git diff --check` | PASSED: no whitespace errors |
| `git diff --exit-code -- fixtures/broken-shop scripts/smoke-playwright.ts scripts/smoke-meta.ts .env.example` | PASSED: fixture sources, Phase 0 smoke scripts and credential template unchanged |

## Real broken-shop acceptance evidence

The real Chromium scan generated during the CLI workflow test used an isolated broken-shop source copy. The browser measured overflow at 320/375/390px and none at 768/1440px. The selected 320px candidate has left 37px, width 480px and right 517px against a 320px viewport, for 197px measured overflow.

Reviewed local artifacts retained under `artifacts/phase2-workspace/artifacts/`:

- [Original scan report](../artifacts/phase2-workspace/artifacts/phase2-cli-CFM0jj/scans/69893794-59f3-415f-9b53-9fb3399862b6/report.json), scan ID `69893794-59f3-415f-9b53-9fb3399862b6`.
- [Prepared manifest](../artifacts/phase2-workspace/artifacts/phase2-cli-CFM0jj/scans/69893794-59f3-415f-9b53-9fb3399862b6/diagnosis-7c1efad9-e092-4b36-b346-616b903df737/manifest.json).
- [Reviewed screenshot](../artifacts/phase2-workspace/artifacts/phase2-cli-CFM0jj/scans/69893794-59f3-415f-9b53-9fb3399862b6/diagnosis-7c1efad9-e092-4b36-b346-616b903df737/screenshot.png), 320 × 900, 28,521 bytes.
- [Actual blocked diagnosis output](../artifacts/phase2-workspace/artifacts/phase2-cli-CFM0jj/scans/69893794-59f3-415f-9b53-9fb3399862b6/diagnosis-7c1efad9-e092-4b36-b346-616b903df737/diagnosis.json).

The manifest maps the candidate conservatively as **ambiguous**, with `src/App.tsx:26–33` and `src/styles.css:73–83`. Those reviewed snippets contain the JSX class and corresponding 480px width rule. This is static source evidence, not an obtained model diagnosis or proof of root cause. The structural-to-source logic contains no fixture identifiers.

After reading the complete manifest and visually inspecting the PNG, the authorized check ran from the original repository root so the existing configuration loader could use the normal local configuration without copying any credential file:

```powershell
node ./artifacts/phase2-workspace/packages/cli/bin/visionfix.js diagnose --evidence ./artifacts/phase2-workspace/artifacts/phase2-cli-CFM0jj/scans/69893794-59f3-415f-9b53-9fb3399862b6/diagnosis-7c1efad9-e092-4b36-b346-616b903df737/manifest.json --allow-model-upload
```

It returned `BLOCKED: MISSING_CONFIG`. A second execution captured the native code explicitly using `$diagnosisExit = $LASTEXITCODE; Write-Output ('Diagnosis native exit code: ' + $diagnosisExit); exit $diagnosisExit`, confirming **3**. (PowerShell's first wrapper reported its own generic failure exit.) The safe output contains:

```json
{
  "status": "blocked",
  "code": "MISSING_CONFIG",
  "message": "Meta credentials/configuration are unavailable or invalid. Configure META_API_KEY, META_BASE_URL and META_MODEL locally; preserve existing .env files."
}
```

**Remediation:** configure a valid authorized Meta API key and documented image-capable model locally through process environment or the existing ignored credential file, without deleting/overwriting/displaying that file. Review evidence again and rerun the explicit upload command. Only a real successful multimodal response with independently valid source citations can complete live acceptance. Do not paste keys into chat. No fake diagnosis is supplied for this blocked check.

## Manual review commands and limitations

From the repository root:

```powershell
npm.cmd run build
npm.cmd run typecheck
npm.cmd test
npm.cmd run cli -- diagnose --help
```

Review the retained [source diff](../artifacts/phase2-workspace/artifacts/phase2-review.patch) and [17-file hash inventory](../artifacts/phase2-workspace/artifacts/phase2-review-files.json). The review generator used an explicit safe file allowlist, excluded credential files and checked application without modifying the original checkout. These artifacts record the pre-application diff and hashes. Application was subsequently explicitly authorized by the user; the documentation updates above record that transfer.

README.md has exact two-terminal Windows PowerShell commands for generating a new scan, preparing evidence, reviewing the manifest/image and explicitly uploading. `npm.cmd run test:scan` selects retained Phase 1 tests; `npm.cmd run test:diagnose` selects Phase 2 tests. Scan exit codes remain 0/1/2; diagnosis codes are 0 success (possibly uncertain/unmapped), 2 failed/invalid, 3 blocked.

Source mapping is heuristic, limited to approved CSS/JSX/TSX directories and bounded snapshot data. Current structural Phase 1 selectors produce ambiguous mappings; dynamic components, unusual CSS/module transforms and unsupported source locations may be unmapped. Sources may change after preparation: only the reviewed snapshot is uploaded and validated. Hashes detect evidence changes, not an attacker replacing evidence and digest together. Secret filtering cannot guarantee complete removal and screenshot pixels are not redacted. The model has no tools, output cannot execute commands, and even grounded diagnoses remain hypotheses. HTTPS endpoint/model are configurable; unknown image model support blocks rather than being guessed. Hostile concurrent filesystem mutation is outside an OS sandbox guarantee.

Official Meta image formats, model input support and structured output were verified against [image understanding](https://dev.meta.ai/docs/image-understanding), [chat schemas](https://dev.meta.ai/docs/api-reference/chat-completions/schemas), [models](https://dev.meta.ai/docs/models) and [structured output](https://dev.meta.ai/docs/structured-output). DevRelay tools were unavailable, so no challenge/account lookup or community-gateway results are claimed. A supplementary [first-person DEV discussion of untrusted data boundaries](https://dev.to/raju_dandigam/prompt-injection-is-a-data-flow-problem-across-retrieval-mcp-and-tools-4j7l) informed review; official documentation governs API implementation.

---

# Historical verification results — Phase 1

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
