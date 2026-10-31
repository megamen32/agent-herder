import {describe,expect,it} from "vitest";
import {HerderEventBus} from "../src/herder-events.js";
import {publishNativeTurnReceipt} from "../src/native-turn-receipts.js";
import type {HarnessEvent} from "../src/types/index.js";

const event=(kind:HarnessEvent["kind"],turnId?:string):HarnessEvent=>({
  kind, harness:"opencode",sessionId:"ses_native_fixture",at:"2026-10-31T19:05:00.000Z",
  data:turnId?{turnId}:{},
});

describe("native turn receipts",()=>{
  it("never treats accepted input or idle as completed",()=>{
    const bus=new HerderEventBus();
    expect(publishNativeTurnReceipt(bus,event("message.updated","turn123"))).toBe(false);
    expect(publishNativeTurnReceipt(bus,event("turn.completed"))).toBe(false);
    expect(bus.latestSequence()).toBe(0);
  });
  it("distinguishes exact started, finished and failed turn IDs without text",()=>{
    const bus=new HerderEventBus();
    expect(publishNativeTurnReceipt(bus,event("turn.started","turn123"))).toBe(true);
    expect(publishNativeTurnReceipt(bus,event("turn.completed","turn123"))).toBe(true);
    expect(publishNativeTurnReceipt(bus,event("turn.failed","turn-other"))).toBe(true);
    const receipts=bus.listAfter(0);
    expect(receipts.map(e=>e.source)).toEqual([
      "native-turn:turn.started","native-turn:turn.completed","native-turn:turn.failed",
    ]);
    expect(receipts[0].uri).toBe("herder://native-turns/opencode/ses_native_fixture/turn123");
    expect(receipts[2].uri).toContain("turn-other");
    expect(JSON.stringify(receipts)).not.toContain("message");
  });
});
