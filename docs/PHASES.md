# Implementation Roadmap & Phases — VisionFix AI

This document outlines the six defined phases of VisionFix AI — StressProof. Agents and developers must strictly follow the boundary of each phase and implement only the explicitly requested phase.

---

## Phase 0: Foundation (Current Phase)
**Goal**: Establish a minimal, working TypeScript monorepo foundation and verify core tooling capabilities without speculative features.
- npm workspaces setup (`packages/cli`, `packages/core`, `fixtures/broken-shop`).
- TypeScript compilation and typechecking configuration.
- Minimal CLI printing application name, version, and phase.
- Deliberately broken React + Vite shop fixture demonstrating 320px viewport overflow.
- Playwright smoke test launching Chromium, capturing screenshot evidence, and deterministically asserting overflow.
- Configurable Meta Model API integration with Zod validation, timeout handling, error categorization, and smoke test.
- Repository rules (`AGENTS.md`) and documentation (`docs/`, `README.md`).

---

## Phase 1: Responsive Scanner (Future Phase)
**Goal**: Build the automated multi-viewport layout scanner.
- Viewport sweep matrix (e.g., 320px, 375px, 414px, 768px, 1024px, 1280px).
- Automated detection of horizontal document overflow, clipped text, and element overlap.
- Bounding client rect and computed style extraction for defective elements.
- Generation of standardized structured issue representations.

---

## Phase 2: Diagnosis and Source Mapping (Future Phase)
**Goal**: Connect layout failures to source code locations using Meta LLM diagnosis.
- Source map resolution mapping rendered DOM elements back to React JSX component files.
- Assembly of minimal, targeted diagnostic prompts containing element DOM, computed styles, and parent tree constraints.
- Querying Meta Model API for root-cause diagnosis (e.g. rigid fixed width vs flex wrapping).

---

## Phase 3: Isolated Repair and Verification (Future Phase)
**Goal**: Propose and test automated source-code repairs in an isolated workspace.
- Temporary workspace creation (isolated copy / worktree) preserving the original project files.
- AST-guided or precision patch application to React components and CSS stylesheets.
- Re-running Playwright verification on the repaired bundle to verify that layout issues are resolved without regressions.

---

## Phase 4: Stress Testing and Proof Reports (Future Phase)
**Goal**: Stress-test edge cases and generate definitive proof reports.
- Viewport boundary stress testing (resizing animations, dynamic font scaling, localization text expansion).
- Generation of local visual proof reports featuring before/after screenshots and delta metrics.
- Export of portable HTML/JSON verification artifacts.

---

## Phase 5: Evaluation and Submission (Future Phase)
**Goal**: Benchmark performance and finalize production package.
- Comprehensive evaluation across diverse web application fixtures.
- Precision, recall, and repair success rate benchmarking.
- End-to-end documentation, demo recording, and submission readiness.
