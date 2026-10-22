import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HerderEventBus, healthRefusalEvent, healthRefusalUri, publishHealthRefusal } from "../src/herder-events.js";

describe("the health refusal in the event journal", () => {
  it("states the class of the refusal and names the incident", () => {
    const event = healthRefusalEvent({ incidentId: "inc-42", reasonCode: "automation_disabled" });
    expect(event.kind).toBe("health");
    expect(event.reason_code).toBe("automation_disabled");
    expect(event.id).toBe("inc-42");
    expect(event.uri).toBe("herder://health/refusals/inc-42");
    expect(event.action).toBe("changed");
  });

  it("is read by the prefix of its uri, so one incident is read apart from another", () => {
    const events = new HerderEventBus();
    publishHealthRefusal({ incidentId: "inc-42", reasonCode: "automation_disabled" }, events);
    publishHealthRefusal({ incidentId: "inc-42", reasonCode: "model_not_permitted_for_project" }, events);
    publishHealthRefusal({ incidentId: "inc-43", reasonCode: "harness_not_allowed" }, events);

    const ofIncident = events.listAfter(0, 50, healthRefusalUri("inc-42"));
    expect(ofIncident).toHaveLength(2);
    expect(ofIncident.every((event) => event.kind === "health")).toBe(true);
    expect(ofIncident.map((event) => event.reason_code)).toEqual(["automation_disabled", "model_not_permitted_for_project"]);
    expect(events.listAfter(0, 50, healthRefusalUri("inc-43")).map((event) => event.reason_code)).toEqual(["harness_not_allowed"]);
  });

  it("keeps the refusal in the journal, with its own sequence and revision", () => {
    const directory = mkdtempSync(join(tmpdir(), "herder-health-events-"));
    try {
      const path = join(directory, "events.json");
      const events = new HerderEventBus({ persistencePath: path });
      const published = publishHealthRefusal({ incidentId: "inc-42", reasonCode: "automation_disabled" }, events);
      expect(published.sequence).toBeGreaterThan(0);
      expect(published.revision).toBe(1);

      const restored = new HerderEventBus({ persistencePath: path });
      const restoredEvents = restored.listAfter(0, 10, "herder://health/refusals/");
      expect(restoredEvents).toHaveLength(1);
      expect(restoredEvents[0]?.reason_code).toBe("automation_disabled");
      expect(restoredEvents[0]?.kind).toBe("health");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves the other events of the bus alone", () => {
    const events = new HerderEventBus();
    events.publish({ kind: "coordination", uri: "herder://coordination", action: "changed", id: "note-1" });
    publishHealthRefusal({ incidentId: "inc-42", reasonCode: "automation_disabled" }, events);

    const coordination = events.listAfter(0, 10, "herder://coordination");
    expect(coordination).toHaveLength(1);
    expect(coordination[0]?.kind).toBe("coordination");
    expect(coordination[0]?.reason_code).toBeUndefined();
    expect(events.listAfter(0, 10, "herder://health/refusals/")).toHaveLength(1);
  });

  it("refuses a refusal that states no class", () => {
    expect(() => healthRefusalEvent({ incidentId: "inc-42", reasonCode: "  " })).toThrow(/class of its refusal/);
  });

  it("names the source of the refusal when it has one", () => {
    const event = healthRefusalEvent({ incidentId: "inc-42", reasonCode: "automation_disabled", source: "work_disarmed" });
    expect(event.source).toBe("work_disarmed");
  });
});
