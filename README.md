# VisionFix AI — StressProof

A local-first developer tool that inspects React + Vite applications, discovers responsive layout bugs, proposes source-code repairs in an isolated copy, and verifies those repairs using Playwright.

---

## Current Status: Phase 0 (Foundation)

This repository currently implements **Phase 0 only**.

### What Phase 0 Implements:
- Minimal TypeScript monorepo using npm workspaces (`@visionfix/core`, `@visionfix/cli`, `@visionfix-fixture/broken-shop`).
- Unified TypeScript build and typecheck configuration.
- Minimal CLI printing application name, version, and phase.
- Deliberately broken React + Vite fixture (`fixtures/broken-shop`) featuring an intentional 480px fixed-width container causing horizontal overflow on a 320px viewport.
- Playwright smoke test script that starts the fixture, awaits server readiness, launches headless Chromium at 320px, deterministically asserts document overflow, captures screenshot evidence, and cleanly shuts down.
- Meta Model API integration with Zod configuration validation, timeout handling, safe credential masking, and smoke test script.
- Repository operating rules (`AGENTS.md`) and architectural documentation (`docs/`).

### What Remains Unimplemented (Future Phases):
- Multi-viewport responsive scanner (Phase 1).
- React source mapping and Meta LLM layout diagnosis (Phase 2).
- Isolated workspace patching and automated repair loop (Phase 3).
- Layout stress testing and visual proof reports (Phase 4).
- Comprehensive benchmark evaluation (Phase 5).

---

## Prerequisites
- **Node.js**: `v20+` or `v24+` (verified on Node `v24.21.0`).
- **npm**: `v10+` or `v12+` (verified on npm `12.1.0`).
- **Operating System**: Windows, macOS, or Linux (cross-platform compatible scripts).

---

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Install Playwright Chromium Browser
```bash
npx playwright install chromium
```

---

## Configuring Local Credentials (Meta API)

To configure access for the Meta Model API smoke test:

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   *(On Windows PowerShell: `Copy-Item .env.example .env`)*

2. Open `.env` in your editor and configure the variables:
   ```env
   META_BASE_URL=https://api.meta.ai/v1
   META_API_KEY=your_actual_bearer_token_here
   META_MODEL=muse-spark-1.3
   ```

> ⚠️ **SECURITY RULES**:
> - Never paste your API key or secrets into public chats or commit them to Git.
> - `.env` is listed in `.gitignore` and must remain local to your machine.
> - The smoke test loads credentials safely and masks keys when displaying diagnostic info.

---

## Available Commands

### Build & Typecheck
```bash
# Typecheck all packages and fixtures
npm run typecheck

# Build all packages
npm run build
```

### CLI
```bash
# Run CLI via package script
npm run cli -- --version

# Or run directly via Node
node packages/cli/bin/visionfix.js --version
```

### Broken Shop Fixture
```bash
# Start Vite development server (port 5173)
npm run fixture:dev

# Build fixture for production
npm run fixture:build

# Preview production build
npm run fixture:preview
```

### Playwright Smoke Test
Starts the broken shop fixture, opens it in headless Chromium at 320px, verifies horizontal overflow, and saves a screenshot to `artifacts/broken-shop-320px.png`:
```bash
npm run test:smoke:playwright
```

### Meta Model API Smoke Test
Validates local configuration and executes a minimal real request to the configured Meta Model API endpoint. The test only reports `PASSED` when the response contains textual model output; missing configuration exits with status 2 (`BLOCKED`) and API/network failures exit with status 1 (`FAILED`):
```bash
npm run test:smoke:meta
```
Configure `META_API_KEY`, `META_BASE_URL`, and `META_MODEL` in a local, ignored `.env` file. The documented defaults are `https://api.meta.ai/v1` and `muse-spark-1.3`; `META_API_KEY` must be a valid token from the Meta Model API dashboard. Never paste credentials into chat or commit `.env`.
