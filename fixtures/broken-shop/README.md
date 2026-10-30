# Broken Shop Test Fixture

> **IMPORTANT**: This fixture is an automated test input and verification target for VisionFix AI. It is **NOT** the user interface or dashboard of the VisionFix product itself.

## Purpose
This minimal React + Vite application provides a deterministic responsive design bug to verify:
1. Local fixture build and preview execution.
2. Automated Playwright headless browser inspection.
3. Overflow detection assertions in smoke tests.

## Intentional Defect
- **Target Element**: `.product-specs-banner` in `src/App.tsx` / `src/styles.css`.
- **CSS Rule**: `width: 480px;` (hardcoded fixed width).
- **Responsive Failure**:
  - Target viewport: 320px width (typical narrow mobile device, e.g. iPhone SE).
  - Observed behavior: The 480px container forces document layout horizontal overflow.
  - Verification: `document.documentElement.scrollWidth` evaluates to `>= 480px` while `document.documentElement.clientWidth` is `320px`.
  - Symptom: Unintended horizontal scrolling and clipping on small screens.

## Running the Fixture Directly
```bash
# Start Vite dev server on port 5180
npm run fixture:dev

# Or build and preview production bundle
npm run fixture:build
npm run fixture:preview
```
