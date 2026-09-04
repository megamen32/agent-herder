import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
const reactSource = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");

describe("Codex session visualization", () => {
  it("exposes a new-tab visualization action for every selected harness", () => {
    expect(reactSource).toContain("/visualization`");
    expect(reactSource).toContain("const visualizationUrl = activeSession");
    expect(reactSource).toContain('target="_blank"');
    expect(reactSource).toContain(">Visualize</a>");
  });
});

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

describe("non-blocking session loading", () => {
  it("shows loading state while the newest turns arrive, then hydrates older history", () => {
    expect(reactSource).toContain("session-skeletons");
    expect(reactSource).toContain("Loading latest activity");
    expect(reactSource).toContain("loading older history and metrics");
    expect(reactSource).toContain("?limit=12&quick=1");
    expect(reactSource).toContain("?limit=50");
  });

  it("restores the selected session across page reloads", () => {
    expect(reactSource).toContain("agent-herder.active-session");
    expect(reactSource).toContain("window.localStorage.setItem");
  });
});


describe("browser load timings", () => {
  it("shows sessions, latest, and hydrate timings in the chat header", () => {
    expect(reactSource).toContain("Browser load timings");
    expect(reactSource).toContain("formatLoadTiming(sessionsTimingMs)");
    expect(reactSource).toContain("formatLoadTiming(latestTimingMs)");
    expect(reactSource).toContain("formatLoadTiming(hydrateTimingMs)");
  });
});

describe("activity statistics dashboard", () => {
  it("renders a dedicated statistics view with coverage, histogram, and refresh controls", () => {
    expect(reactSource).toContain("function StatisticsView");
    expect(reactSource).toContain("What different TTLs actually cover");
    expect(reactSource).toContain("Write revisit distribution");
    expect(reactSource).toContain("/api/statistics/activity?days=");
    expect(reactSource).toContain("Suggested inactivity lease");
  });
});
