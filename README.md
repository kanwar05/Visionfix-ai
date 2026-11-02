# VisionFix AI — StressProof

Phase 3 adds one-attempt CSS repair in a separate project copy, controlled builds/previews, and independent browser verification to the retained Phase 0–2 commands. Original target files are never automatically patched. No dashboard, GitHub integration or additional stress-test phase is implemented.

The reviewed Phase 3 implementation was applied to the main developer workspace at the user's explicit request. The restarted `artifacts/phase3-restart/` review copy and previous attempt are retained for reference. Run the commands below from the main repository root.

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

Do not overwrite an existing credential file. Only explicitly invoked Meta commands (the smoke check, authorized diagnosis upload or authorized repair attempt) load `.env`; scanning and local preparation do not.

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

## Prepare, review and run an isolated CSS repair

Phase 3 requires a sealed Phase 2 evidence manifest and a **successful, independently validated diagnosis** for the same issue. A blocked diagnosis is not a usable repair input. Obtain a real diagnosis with the scan/diagnose commands above; do not create or relabel a test response as live output. An unavailable Meta configuration blocks a model-powered repair rather than generating a substitute patch.

The MVP supports one issue and one attempt per prepared run, with at most two explicitly approved existing CSS files. Each file must already have a supported source mapping in the reviewed Phase 2 evidence. There is no CLI option for supplying a deterministic test patch, no automatic retry, and no command that applies a repair to the original target.

Repair bounds are **16 KiB per approved CSS file / 32 KiB total context**, **32 KiB unified diff**, and **80 added plus removed lines** across at most two files; plan JSON is capped at 128 KiB. Context is rejected when oversized rather than silently truncated. Source isolation permits 2,000 files, 32 MiB total and 4 MiB per file. Existing dependency copies permit 30,000 files, 400 MiB total and 32 MiB per file. Logs are capped at 64 KiB per process and marked when truncated; build timeouts cannot exceed 120 seconds and preview readiness cannot exceed 30 seconds. These bounds are independent of model output.

First create a fresh developer-reviewed execution configuration. The [example configuration](examples/repair-execution.example.json) is for the shop demonstration: it approves `src/styles.css`, targets the specs content, and requires the checkout button to remain visible, enabled, receive a click and show the expected dialog. Its selectors are developer inputs; the repair algorithm contains no fixture selectors or fixes. Change these assertions for another application.

From the checkout root, in Windows PowerShell, create a local configuration from that safe example and set actual executable/dependency paths:

```powershell
New-Item -ItemType Directory -Path ./artifacts -Force | Out-Null
$execution = Get-Content -Raw -LiteralPath ./examples/repair-execution.example.json | ConvertFrom-Json
$nodeExecutable = (Get-Command node).Source
$execution.build.executable = $nodeExecutable
$execution.server.executable = $nodeExecutable
$execution.dependencyDirectory = (Resolve-Path -LiteralPath ./node_modules).Path
$configPath = Join-Path (Resolve-Path -LiteralPath ./artifacts).Path ('repair-execution-' + [guid]::NewGuid().ToString() + '.json')
$execution | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8
Get-Content -LiteralPath $configPath
```

Review the native executable and argument arrays before authorizing execution. The example builds with Node and `node_modules/vite/bin/vite.js build`, then serves `node_modules/vite/bin/vite.js preview`. The default Vite `dist` output is required. VisionFix appends fixed loopback host, the configured separate port and `--strictPort`; these flags must not be supplied in the reviewed server arguments. It rejects an occupied port instead of attaching to another server. Choose a port different from the original application's port; the example uses **5192**, while the original shop uses 5180. Dependency paths relative to the config are resolved from the config file's directory.

Using `$evidence` and `$prepared` from the completed diagnosis workflow above, prepare a repair plan locally:

```powershell
$diagnosis = Join-Path $prepared.FullName 'diagnosis.json'
npm.cmd run cli -- repair --project ./fixtures/broken-shop --evidence $evidence --diagnosis $diagnosis --config $configPath --prepare
$repairRun = Get-ChildItem -LiteralPath $prepared.FullName -Directory -Filter 'repair-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$plan = Join-Path $repairRun.FullName 'repair-plan.json'
Get-Content -LiteralPath $plan
```

Preparation makes no API request, runs no project code and installs no dependencies. It verifies the diagnosis/evidence references, compares the reviewed snippets against current CSS, and records full-file hashes plus bounded redacted CSS context, execution configuration and independent assertions. The plan and its digest are saved in a new `repair-<uuid>` directory beside the prepared evidence. Review the full CSS context and the already-reviewed screenshot before transmission. The local plan includes local paths and execution settings; only the approved browser/image/diagnosis/CSS context is supplied to the model, without these execution controls or a full repository.

After review, upload and project execution require **both** explicit permissions:

```powershell
npm.cmd run cli -- repair --plan $plan --allow-model-upload --allow-project-execution
$LASTEXITCODE
Get-Content -LiteralPath (Join-Path $repairRun.FullName 'repair-report.json')
```

Omitting either permission blocks the attempt before input/configuration access or execution. An authorized attempt consumes its run identity, including an attempt that becomes blocked or rejected. After changing credentials, sources, evidence, configuration or assertions, prepare and review a new plan. The digest detects changed local inputs; it is not a signature against someone who can replace both the plan and digest.

The flow verifies reviewed input hashes, checks Meta configuration and creates a physical working copy in a short, run-owned directory under the OS temporary directory, outside the target. Its absolute location is recorded in `repair-report.json` as `workspace` and in the run's `workspace-location.json`. Reports, logs, diffs and before/after screenshots stay beside the prepared evidence. Keeping the executable working directory short avoids Windows path-length failures without requiring changes to system long-path settings. It copies current disk state, including supported untracked source files, rather than an old Git HEAD. Secrets, `.env`, `.git`, tests, reports, build/generated outputs and unnecessary files are excluded. Source symlinks are unsupported, and no writable source or dependency links are created. Only supported source/configuration and common asset extensions are copied; projects requiring other inputs may be blocked or fail the baseline build.

**Dependencies:** the reviewed `dependencyDirectory` must already contain React and Vite. Existing dependency files are copied physically into the isolated copy's `node_modules`; workspace symlink aliases and dependency credential files are skipped. VisionFix never runs an install command or install hook. Missing, unsupported or oversized dependencies are an explicit blocker. Install or manage dependencies yourself before preparing a new run.

Before requesting a patch, the unmodified copy must build and reproduce the original failure with the configured target content and interaction. Failure to reproduce stops as `inconclusive`; no patch is applied. The model then proposes a structured explanation and unified diff. Independent validation rejects unsupported paths, traversal, symlinks, binary changes, creation/deletion/renames, unrelated files, stale hashes, oversized changes, new resource-loading CSS and any hunk that does not match exactly. Manifests, scripts, tests and credentials are never patch targets. Model output cannot choose execution commands, permissions, allowed paths or acceptance assertions.

After applying an accepted proposal **only to the working copy**, VisionFix requires another successful build and reruns the original failing width and all five Phase 1 widths, 320/375/390/768/1440 × 900. It rejects unresolved target overflow, newly introduced or worsened Phase 1 geometry candidates, hidden/removed/clipped target content, substantial text shrinking, document overflow masking, missing screenshots and configured interaction regressions. The configured target must contain the actual reviewed overflow candidates at the original failing width. Before/after screenshots use matching viewports. These checks cover the selected content and geometry; they do not establish every behavior or visual property of an application.

The layout-only MVP also preserves text paint at matching text nodes: changes to computed foreground/fill colors, ancestor backgrounds, filters, blending, shadows or painted pseudo-element overlays are rejected conservatively as `TARGET_PAINT_CHANGED`. Clear opaque foreground/background equality is treated as hidden text. This policy prevents a geometry-clean proposal from hiding content through changed paint, and may reject an otherwise legitimate repair that also changes visual styling. Paint descriptors are bounded to 256 KiB and are saved only as hashes. These assertions are not a proof of universal visual correctness.

The optional developer-configured interaction is an actual guarded DOM click: native submission is prevented, browser network requests are blocked during the click, WebSockets are closed, and dialogs are dismissed. The shop example requires the checkout dialog assertion and performs no real purchase. Omitting `interaction` means no click behavior is tested; a verified result then covers only the other configured checks. Keep the interaction configured for the shop demonstration.

Build/server commands run from the short isolated working directory with `shell: false`, native executable/argument arrays, bounded timeouts and capped sanitized logs. An environment allowlist omits inherited Meta credentials, Node options and npm hooks. A random run-owned preview file proves readiness on the recorded loopback URL. Windows uses a run-owned Job Object, and POSIX uses a process group, to terminate only the run-owned process tree, including descendants. The fixed Windows supervisor and its structured process specification use a separate short, run-owned temporary helper directory; only that helper is removed after confirmed process termination. The physical project copy remains available for review. Cleanup failure prevents a verified result.

**Trusted execution is not a security sandbox.** A copied project still runs trusted build/configuration code with the current OS user's permissions and may access external files or networks. Review the code and execution configuration before granting `--allow-project-execution`. Text filtering is best effort; screenshot pixels are not redacted. Do not place credentials in execution arguments/configuration, and never delete, overwrite, display or log existing credential files.

| Repair exit code | Meaning |
|---|---|
| 0 | Local plan preparation succeeded, or configured repair checks passed (`verified`) |
| 1 | Proposal or after-patch verification was rejected (`rejected`) |
| 2 | Invalid inputs, execution, cleanup or reporting failure (`failed`) |
| 3 | Missing authorization/configuration/dependencies or unsupported case (`blocked`) |
| 4 | Baseline failure/content/interaction could not be reproduced (`inconclusive`) |

The schema-validated `repair-report.json` records input/source hashes, actual model/provider/request status, proposal and `proposal.diff`, changed files, the absolute run-owned working-copy location, baseline and after-build outcomes, verification URLs, viewport and interaction results, relative screenshot/log paths, cleanup and final reasons. A failed or rejected attempt preserves evidence/diff and restores approved CSS only inside its own working copy. The physical copy is retained for review at the location recorded in the report and `workspace-location.json`. Original target files remain unchanged in every case, and applying the exported diff later is a separate developer action.

`verified` means only that the configured checks passed. Deterministic proposals used by infrastructure tests are labeled `deterministic-test` with `requestMade: false`; they do not prove a live AI repair. See [actual Phase 3 outcomes](docs/RESULTS.md) for a successful deterministic repair, a rejected bad proposal, preservation evidence and any live Meta blocker.

```powershell
npm.cmd run cli -- repair --help
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:repair
```
