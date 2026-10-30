# Agent Operating Guidelines — VisionFix AI (StressProof)

This document defines non-negotiable repository rules and operating constraints for all AI coding agents working on VisionFix AI.

---

## 1. Scope Boundary
- **Implement only the explicitly requested phase.** Never start, scaffold, or implement modules for future phases until directed by the user.
- In Phase 0, focus strictly on establishing the TypeScript foundation, running the broken fixture, verifying Playwright headless screenshot capture, and validating the Meta model API smoke test.
- Do not create empty speculative modules, premature abstractions, or dashboard interfaces.

## 2. Developer Workspace Preservation
- **Preserve original developer project files during future repairs.**
- Any automated inspection, mutation, or repair must occur inside an isolated workspace copy (e.g. temporary directory or git worktree), never directly touching the developer's source files until explicitly confirmed and approved.
- Fixtures located in `fixtures/` are test inputs, not product interfaces or user projects.

## 3. Secret Protection and Credential Safety
- **Never expose credentials or commit `.env` files.**
- Keep `.env` and local credential files in `.gitignore`.
- Provide only `.env.example` with safe placeholder values in version control.
- Never print API keys, tokens, or authorization headers in terminal logs, test outputs, trace files, or chat responses.
- Mask or redact credentials when logging configuration objects.

## 4. Privacy & Model Data Minimization
- **Never send full repositories or secrets to external models.**
- External model API calls must only receive minimal, targeted context: specifically relevant DOM snippets, computed styles, viewport measurements, or visual crops necessary for responsive UI diagnosis.
- Filter out sensitive environment variables, secrets, and private repository files before assembling LLM prompts.

## 5. Command Execution Safety
- **Never execute model-generated shell commands directly.**
- All file manipulations, build steps, and repair operations must be executed deterministically via structured code routines and verified tool calls, not by passing raw LLM text into an arbitrary shell interpreter.

## 6. Generalization Over Overfitting
- **Do not hardcode detection logic or repairs for fixtures.**
- Fixtures (such as `fixtures/broken-shop`) exist to verify that tools function as intended.
- Scanner, diagnosis, and repair algorithms must remain generic and work across arbitrary React/web layouts rather than checking for fixture-specific identifiers or magic numbers.

## 7. Honest Reporting and Verification
- **Report checks honestly and stop after the requested phase.**
- Never replace a failed or blocked real check with a mocked success.
- If credentials, network access, or documentation are missing, explicitly report the step as `BLOCKED` with actionable remediation instructions.
- Record actual execution commands and outcomes truthfully in `docs/RESULTS.md`.
