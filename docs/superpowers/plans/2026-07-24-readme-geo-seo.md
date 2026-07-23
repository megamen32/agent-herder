# README GEO SEO and Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Herder's npm and GitHub documentation simple, memorable, and discoverable for people looking for an MCP server that monitors and coordinates OpenCode, Claude Code, Codex, and Qoder sessions.

**Architecture:** Keep one canonical English README as the short landing page, with the Russian README mirroring the same promise and first-run path. Put search-oriented terms in package metadata and explicit sections, while keeping every claim tied to an existing tool, adapter, or command in the repository.

**Tech Stack:** Markdown, npm `package.json`, Vitest documentation-contract test, existing TypeScript MCP server.

## Global Constraints

- Preserve the one-line install command: `npx -y agent-herder`.
- Describe only capabilities currently exposed by the MCP server.
- Keep the first screen useful: name, promise, install, supported harnesses, and minimal configuration.
- Do not add runtime dependencies or change MCP behavior.
- Preserve the existing Chinese README and unrelated working-tree files.

---

### Task 1: Lock the public README contract

**Files:**
- Modify: `tests/package-publish.test.ts`

- [ ] **Step 1: Add assertions for the public landing-page phrases and install command**

Assert that `README.md` contains the exact package name, `npx -y agent-herder`, the MCP/server terms, all four harness names, and the public tool names `find_parent`, `list_children`, and `get_transcript`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run tests/package-publish.test.ts`

Expected: FAIL because the current README does not yet have the new landing-page contract.

### Task 2: Rewrite the landing pages for clarity and GEO SEO

**Files:**
- Modify: `README.md`
- Modify: `README.ru.md`
- Modify: `package.json`

- [ ] **Step 1: Replace the English README opening with a concise promise, install block, use cases, and tool map**

Lead with “Agent Herder — MCP control center for coding agents”, then show `npx -y agent-herder`, a minimal MCP JSON snippet, supported harnesses, three concrete use cases, and a compact tool table. Keep advanced environment variables and development details below the first-run path.

- [ ] **Step 2: Mirror the first-run path in Russian**

Use plain Russian copy with the same command, configuration shape, search terms, and tool names; remove outdated claims that are not present in the English page.

- [ ] **Step 3: Strengthen npm metadata without changing runtime behavior**

Keep the package name and entrypoint, update the description to mention “MCP server”, “monitor”, “coordinate”, “parent/child sessions”, and all supported harnesses, and add focused npm keywords for MCP session inspection and transcript search.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- --run tests/package-publish.test.ts`

Expected: PASS.

### Task 3: Verify the published-facing artifact

**Files:**
- Test: `tests/package-publish.test.ts`
- Verify: `README.md`, `README.ru.md`, `package.json`

- [ ] **Step 1: Run all tests and the TypeScript build**

Run: `npm test -- --reporter=dot` and `npm run build`.

Expected: all tests pass and TypeScript exits successfully.

- [ ] **Step 2: Validate the npm tarball contents**

Run: `npm publish --dry-run --access public --registry=https://registry.npmjs.org`.

Expected: the dry run includes `README.md`, `README.ru.md`, `package.json`, `dist/index.js`, and the animated SVG, without publishing.

- [ ] **Step 3: Check formatting, status, and commit**

Run: `git diff --check`, inspect `git status --short`, then commit only the README, metadata, plan, and test changes with:

```bash
git add README.md README.ru.md package.json tests/package-publish.test.ts docs/superpowers/plans/2026-07-24-readme-geo-seo.md
git commit -m "Improve README discoverability and onboarding"
```
