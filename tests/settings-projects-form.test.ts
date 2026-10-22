import { describe, expect, it } from "vitest";

import { changesOf, editedRecordIds, profileDrafts, projectDrafts } from "../src/web-ui/settings/projects-section.js";
import { projectRoutes } from "../src/web-ui/settings/settings-screen.js";

/**
 * The projects and the AI profiles of the mesh.
 *
 * The profile of a project is a reference by id, and the escalation is a
 * reference to the object of the center: the form never carries a copy of
 * the rule of the escalation.
 */

describe("the projects and the profiles of the form", () => {
  it("reads the drafts of the profiles and the projects", () => {
    expect(profileDrafts([
      { id: "p1", humanName: "Профиль", action: "", scope: { kind: "mesh" }, harness: "codex", model: "model-a", fallbackModels: ["model-b"] },
    ])).toEqual([
      { id: "p1", humanName: "Профиль", harness: "codex", model: "model-a", fallbackModels: "model-b" },
    ]);
    expect(projectDrafts([
      { id: "c1", name: "Проект", path: "/tmp/project", profileId: "p1", escalation: { noticePlaceObjectId: "NP-42" } },
    ])).toEqual([
      { id: "c1", name: "Проект", path: "/tmp/project", profileId: "p1", escalationObjectId: "NP-42" },
    ]);
  });

  it("keeps the escalation a reference and never a rule", () => {
    const changes = changesOf(
      [{ id: "p1", humanName: "Профиль", harness: "codex", model: "model-a", fallbackModels: "" }],
      [{ id: "c1", name: "Проект", path: "/tmp/project", profileId: "p1", escalationObjectId: "NP-42" }],
    );
    const project = (changes.projects ?? [])[0] as Record<string, unknown>;
    expect(project.profileId).toBe("p1");
    // The escalation is the reference to the object of the center and nothing
    // else: a rule that arrives here would be a second copy.
    expect(project.escalation).toEqual({ noticePlaceObjectId: "NP-42" });
    expect(Object.keys(project.escalation as Record<string, unknown>)).toEqual(["noticePlaceObjectId"]);
  });

  it("names the records the change is about, so the precondition is exact", () => {
    expect(editedRecordIds(
      [{ id: "p1", humanName: "", harness: "codex", model: "", fallbackModels: "" }],
      [{ id: "c1", name: "", path: "", profileId: "", escalationObjectId: "" }],
    )).toEqual(["node-config/profile/p1", "project/c1"]);
  });

  it("shows the profile of a project route and the link to it", () => {
    const routes = projectRoutes({
      projectRoutes: [
        { project: "alpha", profileId: "p1" },
        { project: "beta" },
      ],
    });
    expect(routes).toEqual([
      { project: "alpha", profileId: "p1" },
      { project: "beta" },
    ]);
  });
});
