import {describe,expect,it} from "vitest";
import {HerderEventBus} from "../src/herder-events.js";
import {createNativeTurnReceiptPublisher} from "../src/native-turn-receipts.js";
import type {HarnessEvent} from "../src/types/index.js";

const publish = createNativeTurnReceiptPublisher();
const event=(kind:HarnessEvent["kind"],data:Record<string,unknown>={}):HarnessEvent=>({
  kind, harness:"opencode",sessionId:"ses_native_fixture",at:"2026-10-31T19:05:00.000Z",
  data,
});

describe("native turn receipts",()=>{
  it("never treats accepted input or idle as completed",()=>{
    const bus=new HerderEventBus();
    expect(publish(bus,event("message.updated",{turnId:"turn123"}))).toBe(false);
    expect(publish(bus,event("turn.completed"))).toBe(false);
    expect(publish(bus,event("turn.completed",{}))).toBe(false);
    expect(bus.latestSequence()).toBe(0);
  });
  it("publishes completion under the started span id when no turnId exists",()=>{
    const bus=new HerderEventBus();
    expect(publish(bus,event("turn.started",{nativeEventId:"evt_a"}))).toBe(true);
    expect(publish(bus,event("turn.completed",{nativeEventId:"evt_b"}))).toBe(true);
    const receipts=bus.listAfter(0);
    expect(receipts.map(e=>e.uri)).toEqual([
      "herder://native-turns/opencode/ses_native_fixture/evt_a",
      "herder://native-turns/opencode/ses_native_fixture/evt_a",
    ]);
    expect(receipts.map(e=>e.source)).toEqual([
      "native-turn:turn.started","native-turn:turn.completed",
    ]);
  });
  it("fails the same span and opens a new span on restart",()=>{
    const bus=new HerderEventBus();
    publish(bus,event("turn.started",{nativeEventId:"evt_s1"}));
    expect(publish(bus,event("turn.failed",{nativeEventId:"evt_f1"}))).toBe(true);
    // No span open: an unmatched completion is rejected.
    expect(publish(bus,event("turn.completed",{nativeEventId:"evt_x"}))).toBe(false);
    // A new started opens a new span.
    publish(bus,event("turn.started",{nativeEventId:"evt_s2"}));
    expect(publish(bus,event("turn.completed",{nativeEventId:"evt_c2"}))).toBe(true);
    const receipts=bus.listAfter(0);
    const uris=receipts.filter(e=>e.source!=="native-turn:turn.started").map(e=>e.uri);
    expect(uris).toEqual([
      "herder://native-turns/opencode/ses_native_fixture/evt_s1",
      "herder://native-turns/opencode/ses_native_fixture/evt_s2",
    ]);
  });
  it("an exact turnId keeps its own identity and closes the span",()=>{
    const bus=new HerderEventBus();
    publish(bus,event("turn.started",{turnId:"turn123"}));
    expect(publish(bus,event("turn.completed",{turnId:"turn123"}))).toBe(true);
    const receipts=bus.listAfter(0);
    expect(receipts.every(e=>e.uri==="herder://native-turns/opencode/ses_native_fixture/turn123")).toBe(true);
  });
  it("distinguishes sessions so one session's span never admits another",()=>{
    const bus=new HerderEventBus();
    const other=(data:Record<string,unknown>):HarnessEvent=>({
      kind:"turn.completed",harness:"opencode",sessionId:"ses_other",at:"2026-10-31T19:05:01.000Z",data,
    });
    publish(bus,event("turn.started",{nativeEventId:"evt_mine"}));
    expect(publish(bus,other({nativeEventId:"evt_theirs"}))).toBe(false);
    expect(publish(bus,event("turn.completed",{nativeEventId:"evt_mine_end"}))).toBe(true);
    const receipts=bus.listAfter(0).filter(e=>e.source!=="native-turn:turn.started");
    expect(receipts.map(e=>e.uri)).toEqual(["herder://native-turns/opencode/ses_native_fixture/evt_mine"]);
  });
});
