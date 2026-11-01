# Implementation phases — VisionFix AI

Only Phase 1 is implemented by this change. No Phase 2 work is started.

## Phase 0: Foundation (retained)

TypeScript npm workspaces, CLI/version/help, broken-shop React + Vite fixture, headless Playwright smoke capture, and configurable Meta smoke-test tooling. The real Meta API success check remains BLOCKED / unverified.

## Phase 1: Browser inspection and horizontal overflow detection (current)

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

## Phase 2: Diagnosis and source mapping (future)

Map browser evidence to source locations and use minimal targeted context for model diagnosis. Not implemented.

## Phase 3: Isolated repair and verification (future)

Propose and verify patches in isolated project copies, preserving original source until explicit approval. Not implemented.

## Phase 4: Stress testing and proof reports (future)

Broaden layout stresses and visual proof reporting. Not implemented.

## Phase 5: Evaluation (future)

Benchmark across a broader collection of applications. Not implemented.
