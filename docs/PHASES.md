# Implementation phases — VisionFix AI

Phase 3 isolated CSS repair and independent verification are implemented. The reviewed changes were applied to the main developer workspace at the user's explicit request. The restarted `artifacts/phase3-restart/` review copy and previous attempt are preserved for reference. Phase 0–2 behavior is retained. Stop after Phase 3.

## Phase 0: Foundation (retained)

TypeScript npm workspaces, CLI/version/help, broken-shop React + Vite fixture, headless Playwright smoke capture, and configurable Meta smoke-test tooling. The real Meta API success check remains BLOCKED / unverified.

## Phase 1: Browser inspection and horizontal overflow detection (retained)

- Validate a React + Vite package manifest through an isolated temporary copy, and accept a separately running local HTTP URL.
- Never run target scripts, install dependencies, collect source/.env files, or modify the target project.
- Attempt 320, 375, 390, 768 and 1440 × 900px, scale 1, in fresh Chromium contexts.
- Bound readiness/fonts and screenshot capture; disable motion; capture explicit navigation and browser failures.
- Measure document-level horizontal overflow separately from bounded, grouped candidate elements with geometry and computed-style evidence.
- Exclude hidden or correctly contained scroll-region content; retain oversized scroll containers.
- Produce schema-validated JSON and relative PNG paths in an ignored per-scan directory.
- Expose CLI help, optional output parent and documented 0/1/2 exit codes.
- Verify real geometry, healthy carousel behavior, failures, schema/screenshots and source preservation.

The local URL rule is not a network sandbox. Reports can contain sensitive rendered information. See README.md for limitations and docs/RESULTS.md for actual checks.

## Phase 2: Diagnosis and source mapping (retained)

- Validate an existing Phase 1 report and safely resolve one completed failing viewport's PNG.
- Prepare bounded browser data and relevant CSS/JSX/TSX source snippets from an isolated source snapshot; never modify target sources.
- Preserve ambiguity/missing mappings, source paths, inclusive lines and reviewed content hashes.
- Save a local manifest, screenshot and review digest without API/configuration access.
- Require a separate explicit `--allow-model-upload`, verify integrity, and send only the reviewed bounded evidence.
- Use the configured Meta model's officially documented multimodal Chat Completions format; block unavailable credentials/access/image support.
- Validate model JSON with Zod and independently reject invented evidence, paths, lines and quotes.
- Save separate diagnosis status/output and explain that any likely cause remains a model hypothesis.
- Preserve existing `.env` files and credentials. Phase 2 diagnosis itself never applies a patch or executes a repair.

Live verification status and exact executed commands are recorded in RESULTS.md. Unit test mocks do not establish live model success.

## Phase 3: Isolated CSS repair and independent verification (current)

- Prepare a sealed, locally reviewable plan from validated Phase 2 evidence/diagnosis, explicit existing CSS file approvals and developer-reviewed execution/assertion configuration.
- Require separate explicit model-upload and trusted-project-execution authorization. Missing configuration produces a blocker, never a fabricated repair.
- Limit each run to one issue, one proposal attempt, two existing CSS files, bounded context and 80 changed lines. Validate structured model output and exact unified diff application independently.
- Reject invented/unsafe paths, symlinks, stale source hashes, creation/deletion/renames, binary changes, unrelated files, manifests, scripts, tests and credentials.
- Copy the current supported source state and existing dependencies physically into a separate, short run-owned OS temporary directory. Record its absolute location in the repair report and run-owned `workspace-location.json`; retain the copy for review. Reports, logs, diffs and screenshots remain beside the prepared evidence. Exclude secrets and generated/unnecessary inputs; never install dependencies or run install hooks or create writable links to original source.
- Build and serve only that working copy through reviewed executable/argument arrays, an allowlisted environment, bounded logs/timeouts and a separate strict loopback port with run-owned readiness proof.
- Reproduce the baseline failure before requesting/applying a proposal; stop inconclusively when it cannot be reproduced.
- Require a successful after-build, all five retained Phase 1 viewports, resolved target overflow, no new/worsened geometry issues, visible retained target content and matching screenshots.
- Keep content and optional guarded interaction assertions outside model control. The shop configuration requires visible/enabled checkout, actual click delivery and its expected dialog without a purchase.
- Reject hiding/removal/clipping or document-overflow masking. Preserve review artifacts, stop only run-owned process trees and restore failed CSS changes only inside the run-owned copy.
- Bind the configured target to the reviewed overflowing candidates. Preserve computed text paint conservatively: reject foreground/background, filter, blending, shadow or painted-overlay changes rather than accepting hidden content as a layout repair. Saved paint evidence contains hashes, and does not establish universal visual correctness.
- Save schema-validated input/source hashes, model/provider status, reviewable diff, builds, URLs, screenshots, assertions, cleanup and `verified`/`rejected`/`blocked`/`inconclusive`/`failed` results.

Source isolation is not an OS or network security sandbox. The initial execution MVP supports trusted local React + Vite projects using Node, Vite preview and default `dist` output with existing dependencies. The short working-copy layout avoids Windows executable cwd path limits without requiring system long-path setting changes; Windows Job Object supervisors use separate short run-owned helpers with bounded cleanup. `verified` means the configured checks passed, not universal correctness. Test-supplied deterministic proposals are infrastructure verification, not live AI repairs. There is no automatic application to the original target and no dashboard or GitHub integration. Actual test outcomes, original-source preservation evidence and live model availability are recorded in RESULTS.md.

## Phase 4: Stress testing and proof reports (future)

Broaden layout stresses and visual proof reporting. Not implemented.

## Phase 5: Evaluation (future)

Benchmark across a broader collection of applications. Not implemented.
