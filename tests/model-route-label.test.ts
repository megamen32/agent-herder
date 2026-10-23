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
    expect(label?.reason).toContain("каталоге");
  });

  it("does not call a route working while the server could not confirm it", () => {
    // The catalog says which models exist, and the server says what the launch
    // will do. When the server has no proof of the route, the badge must not
    // say that the route works.
    const label = modelRouteLabel({
      modelId: "omniroute/minimax-combo-m3.1",
      confirmed,
      launch: { verdict: "unknown", reason: "unverified" },
    });
    expect(label?.state).toBe("не верифицирована");
    expect(label?.tone).toBe("error");
    expect(label?.reason).toContain("Сервер не подтвердил");
  });

  it("calls a route the server refused a refusal and names the reason", () => {
    const closed = modelRouteLabel({
      modelId: "omniroute/minimax-combo-m3.1",
      confirmed,
      launch: { verdict: "denied", reason: "closed-provider" },
    });
    expect(closed?.state).toBe("отказ");
    expect(closed?.tone).toBe("error");
    expect(closed?.reason).toContain("закрытый правилом владельца");
    const outside = modelRouteLabel({
      modelId: "omniroute/minimax-combo-m3.1",
      confirmed,
      launch: { verdict: "denied", reason: "not-allowed" },
    });
    expect(outside?.state).toBe("отказ");
    expect(outside?.reason).toContain("не входит в список разрешённых");
  });

  it("keeps the state of the catalog when the server confirmed the route", () => {
    const label = modelRouteLabel({
      modelId: "omniroute/minimax-combo-m3.1",
      confirmed,
      launch: { verdict: "allowed", reason: "verified" },
    });
    expect(label?.state).toBe("рабочая");
    expect(label?.tone).toBe("ok");
  });

  it("calls a model that is not in the catalog stale and says why", () => {
    const label = modelRouteLabel({ modelId: "omniroute/minimax-combo-m3", confirmed });
    expect(label?.state).toBe("устаревшая");
    expect(label?.tone).toBe("stale");
    expect(label?.reason).toContain("не верифицируется");
    expect(label?.reason).toContain("OpenCode");
  });

  it("calls a model of a paid plan paid and names the plan", () => {
    const label = modelRouteLabel({ modelId: "minimax-coding-plan/MiniMax-M3.1-Flash", confirmed });
    expect(label?.state).toBe("платная");
    expect(label?.tone).toBe("paid");
    expect(label?.reason).toContain("minimax-coding-plan");
  });

  it("says nothing while the catalog of the environment is unknown", () => {
    // An empty catalog is not a verdict: the environment has not answered
    // yet, and an unknown state is not a state.
    expect(modelRouteLabel({ modelId: "omniroute/minimax-combo-m3.1", confirmed: [] })).toBeUndefined();
    expect(modelRouteLabel({ modelId: "  ", confirmed })).toBeUndefined();
  });

  it("takes the stale verdict before the paid one", () => {
    const label = modelRouteLabel({ modelId: "minimax-coding-plan/never-confirmed", confirmed });
    expect(label?.state).toBe("устаревшая");
  });

  it("names the provider of a model id", () => {
    expect(modelProvider("omniroute/minimax-combo-m3.1")).toBe("omniroute");
    expect(modelProvider("minimax-coding-plan/MiniMax-M3.1-Flash")).toBe("minimax-coding-plan");
    expect(modelProvider("no-slash")).toBe("");
  });

  it("keeps the paid plans of the owner in one place", () => {
    expect(PAID_MODEL_PLANS).toContain("minimax-coding-plan");
  });
});

describe("the form of the models shows the state of the model", () => {
  it("draws the badge of the state next to the effective model", () => {
    expect(page).toContain("modelRouteLabel");
    expect(page).toContain("projects-model-state");
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
    expect(styles).toMatch(/projects-model-state-paid/);
    expect(styles).toMatch(/projects-model-state-error/);
  });
});
