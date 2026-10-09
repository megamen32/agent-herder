import {describe,expect,it} from "vitest";
import {validateOwnerEvidence} from "../src/mesh/owner-proof.js";
const pin={hostId:"roomhacker-server-100",pid:123,entry:"/canonical/dist/index.js",startTicks:"100"};
describe("singleton native host proof (fast unit; expected 1s, maximum 10s)",()=>{
 it("rejects the known Mac loopback-forward without relabelling or native send",()=>{
  expect(()=>validateOwnerEvidence(pin,{hostId:"MacBook-Pro-User.local",platform:"darwin",listenerPid:123,listenerName:"ssh",entry:pin.entry,startTicks:"100",listenerAddress:"127.0.0.1:18787",requestedAddress:"127.0.0.1:18787"} as any)).toThrow("singleton_native_owner_identity_unverified");
 });
 it("requires the pinned same native process birth and entry, not an arbitrary loopback node",()=>{
  const proof={hostId:pin.hostId,platform:"linux",listenerPid:123,listenerName:"node",entry:pin.entry,startTicks:"100",listenerAddress:"127.0.0.1:18787",requestedAddress:"127.0.0.1:18787"};
  expect(()=>validateOwnerEvidence(pin,proof)).not.toThrow();expect(()=>validateOwnerEvidence(pin,{...proof,startTicks:"new"})).toThrow();
 });
 it("does not attest a node on another local IP/IPv6 while loopback is a forward",()=>{
  const proof={hostId:pin.hostId,platform:"linux",listenerPid:123,listenerName:"node",entry:pin.entry,startTicks:"100",requestedAddress:"127.0.0.1:18787"};
  expect(()=>validateOwnerEvidence(pin,{...proof,listenerAddress:"192.168.2.100:18787"} as any)).toThrow();
  expect(()=>validateOwnerEvidence(pin,{...proof,listenerAddress:"[::1]:18787"} as any)).toThrow();
 });
});
