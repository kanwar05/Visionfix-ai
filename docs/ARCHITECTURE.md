# Architecture Overview — VisionFix AI (StressProof)

VisionFix AI is a local-first developer tool designed to automatically detect, diagnose, repair, and verify responsive layout bugs in modern web applications (specifically React + Vite projects).

---

## 1. High-Level Future Pipeline Flow

The envisioned end-to-end workflow operates in six sequential stages:

```
[Local Developer Project]
         │
         ▼
[Browser Evidence Collector]  (Playwright: Headless rendering, DOM metrics, scrollWidth vs clientWidth, visual crops)
         │
         ▼
[Meta Model Diagnosis]        (Targeted DOM/CSS snippets + computed styles sent to Meta Llama model)
         │
         ▼
[Isolated Patch Generator]    (Source mapping & AST repair applied in an isolated workspace copy)
         │
         ▼
[Independent Verification]   (Playwright re-evaluates repaired layout across mobile & desktop viewports)
         │
         ▼
[Local Report & Handoff]     (Diff preview, before/after evidence screenshots, pass/fail proof metrics)
```

---

## 2. Source-File Isolation vs. Process-Security Sandboxing

It is critical to distinguish between two different concepts of isolation:

1. **Source-File Isolation (Workspace Safety)**:
   - When VisionFix AI inspects and proposes source code changes, it **never** mutates the developer's original project working tree directly.
   - Instead, VisionFix creates an isolated working copy (such as a temporary directory or Git worktree). Mutations, dependency builds, and repair validations occur solely within this isolated copy.
   - Only after automated visual verification succeeds and the developer reviews the diff is the patch presented for adoption.

2. **Process-Security Sandboxing (Execution Boundary)**:
   - Source-file isolation guarantees that developer files are not corrupted, but it is **not** an operating system security jail or root sandbox.
   - Scripts, build commands (e.g. `npm run build`), and browser processes run with the user's execution privileges on the host system.
   - VisionFix strictly adheres to repository rules: it never executes unreviewed, model-generated shell scripts, and only runs deterministic pre-configured build/test routines.

---

## 3. Privacy Boundary and Data Minimization

VisionFix is local-first, but diagnosing complex visual layout issues leverages the Meta Model API. Users must understand what leaves the machine:

- **What Stays Local**:
  - The developer's entire source repository, history, and directory tree.
  - Local environment variables, API tokens, and secret files.
  - Server-side application logic, database schemas, and backend code.

- **What Leaves the Machine (Transmitted to Meta Model API)**:
  - Minimal, selected visual and layout evidence:
    - Specific DOM subtrees of offending elements.
    - Relevant CSS rules and computed layout properties (`width`, `min-width`, `flex`, `overflow`).
    - Viewport dimensions and scroll measurements.
    - If multimodal models are used in later phases: targeted cropped visual screenshots of the overflowing component.
  - All transmissions use standard HTTPS encryption directly to the user-configured `META_BASE_URL`.
