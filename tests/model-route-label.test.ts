/**
 * The state of a model of a project is named before the route is saved.
 *
 * The names of the models drift, and the difference between a working id, a
 * stale one and a paid one is invisible in the panel until the owner is told
 * it in words.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  modelProvider,
  modelRouteLabel,
  PAID_MODEL_PLANS,
} from "../src/web-ui/model-route-label.js";

const page = readFileSync(new URL("../src/web-ui/projects-settings.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/web-ui/projects-screen.css", import.meta.url), "utf8");

const confirmed = [
  "omniroute/minimax-combo-m3.1",
  "omniroute/minimax/MiniMax-M3.1-Flash",
  "minimax-coding-plan/MiniMax-M3.1-Flash",
];

describe("the state of a model of a project is named in words", () => {
  it("calls a model of the catalog of the environment working", () => {
    const label = modelRouteLabel({ modelId: "omniroute/minimax-combo-m3.1", confirmed });
    expect(label?.state).toBe("рабочая");
    expect(label?.tone).toBe("ok");
    expect(label?.reason).toContain("подтверждает");
  });

  it("calls a model that is not in the catalog stale and says why", () => {
    const label = modelRouteLabel({ modelId: "omniroute/minimax-combo-m3", confirmed });
    expect(label?.state).toBe("устаревшая");
    expect(label?.tone).toBe("stale");
    expect(label?.reason).toContain("не верифицируется");
    expect(label?.reason).toContain("OpenCode");
  });

  it("says nothing while the catalog of the environment is unknown", () => {
    // An empty catalog is not a verdict: the environment has not answered
    // yet, and an unknown state is not a state.
    expect(modelRouteLabel({ modelId: "omniroute/minimax-combo-m3.1", confirmed: [] })).toBeUndefined();
    expect(modelRouteLabel({ modelId: "  ", confirmed })).toBeUndefined();
  });

  it("names the provider of a model id", () => {
    expect(modelProvider("omniroute/minimax-combo-m3.1")).toBe("omniroute");
    expect(modelProvider("minimax-coding-plan/MiniMax-M3.1-Flash")).toBe("minimax-coding-plan");
    expect(modelProvider("no-slash")).toBe("");
  });

  it("names the state in words, not only in colour", () => {
    // The badge carries the word of the state, so the meaning is readable
    // without the colour.
    expect(page).toContain("label.state");
  });

  it("paints the tones of the badge in both themes", () => {
    expect(styles).toContain("projects-model-state");
    expect(styles).toMatch(/projects-model-state-ok/);
    expect(styles).toMatch(/projects-model-state-stale/);
  });
});
