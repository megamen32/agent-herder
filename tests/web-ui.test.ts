import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");

describe("session tree project groups", () => {
  it("exposes create_session and new_or_resume through the web UI", () => {
    expect(html).toContain('id="createNamedSession"');
    expect(html).toContain('id="newOrResumeSession"');
    expect(html).toContain('"/api/sessions/new-or-resume"');
    expect(html).toContain("submitNamedSession");
  });

  it("preserves a collapsed CWD group when polling rerenders the tree", () => {
    expect(html).toContain("collapsedProjects");
    expect(html).toContain('addEventListener("toggle"');
    expect(html).toContain("data-project-key");
  });

  it("renders a compact provider summary instead of repeating one provider per session", () => {
    expect(html).toContain("uniqueProviders");
    expect(html).toContain("providers");
  });

  it("exposes sorting and grouping controls for the session tree", () => {
    expect(html).toContain('id="sortFilter"');
    expect(html).toContain('id="groupFilter"');
    expect(html).toContain('value="activity"');
    expect(html).toContain('value="project"');
    expect(html).toContain('value="status"');
    expect(html).toContain('value="none"');
  });

  it("applies the selected sort and grouping modes when rendering sessions", () => {
    expect(html).toContain("sortSessions");
    expect(html).toContain("state.sort");
    expect(html).toContain("state.grouping");
  });

  it("keeps the selected harness in state when rebuilding the harness options", () => {
    expect(html).toContain("const current = state.filters.harness");
    expect(html).toContain("new Set([...providers, current].filter(Boolean))");
    expect(html).toContain("elements.harnessFilter.value = current");
    expect(html).toContain('new URLSearchParams(location.search)');
    expect(html).toContain("function syncFiltersToQuery");
    expect(html).toContain("syncFiltersToQuery();");
    expect(html).toContain("state.adapters.map((adapter) => adapter.id)");
  });

  it("ignores an older polling response after a newer filtered request starts", () => {
    expect(html).toContain("sessionRequest: 0");
    expect(html).toContain("const request = ++state.sessionRequest");
    expect(html).toContain("if (request !== state.sessionRequest) return");
  });

  it("shows action state, disables state-incompatible controls, and keeps actions at the top", () => {
    expect(html).toContain("actionStatus");
    expect(html).toContain("canStop");
    expect(html).toContain('position: sticky;\n      top: 0');
    expect(html).toContain("renderActionSection");
  });

  it("provides the unified mobile chat shell", () => {
    expect(html).toContain('class="composer"');
    expect(html).toContain('placeholder="Message…"');
    expect(html).toContain('class="advanced-actions"');
    expect(html).toContain('class="detail-section chat-section"');
    expect(html).toContain("message-${esc(message.role");
    expect(html).toContain("sleeping (lazy)");
  });

  it("renders the newest logical message first", () => {
    expect(html).toContain("messages.slice().reverse()");
  });

  it("clears selected detail state when navigating back", () => {
    expect(html).toContain("function returnToTree");
    expect(html).toContain("state.selected = null");
    expect(html).toContain('addEventListener("popstate"');
    expect(html).toContain("history.pushState");
  });
});
