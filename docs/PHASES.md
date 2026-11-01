# Implementation phases — VisionFix AI

Phase 2 diagnosis and source mapping are implemented. Reviewed changes were applied to the developer workspace at the user's explicit request. Stop after Phase 2.

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

## Phase 2: Diagnosis and source mapping (current)

- Validate an existing Phase 1 report and safely resolve one completed failing viewport's PNG.
- Prepare bounded browser data and relevant CSS/JSX/TSX source snippets from an isolated source snapshot; never modify target sources.
- Preserve ambiguity/missing mappings, source paths, inclusive lines and reviewed content hashes.
- Save a local manifest, screenshot and review digest without API/configuration access.
- Require a separate explicit `--allow-model-upload`, verify integrity, and send only the reviewed bounded evidence.
- Use the configured Meta model's officially documented multimodal Chat Completions format; block unavailable credentials/access/image support.
- Validate model JSON with Zod and independently reject invented evidence, paths, lines and quotes.
- Save separate diagnosis status/output and explain that any likely cause remains a model hypothesis.
- Preserve existing `.env` files and credentials; no patches, repairs, dashboard or GitHub integration.

Live verification status and exact executed commands are recorded in RESULTS.md. Unit test mocks do not establish live model success.

## Phase 3: Isolated repair and verification (future)

Propose and verify patches in isolated project copies, preserving original source until explicit approval. Not implemented.

## Phase 4: Stress testing and proof reports (future)

Broaden layout stresses and visual proof reporting. Not implemented.

## Phase 5: Evaluation (future)

Benchmark across a broader collection of applications. Not implemented.
