import { describe, expect, it } from "vitest";
import { isLongVisibleMessage, readCollapseLongMessages, writeCollapseLongMessages } from "../src/web-ui/message-collapse.js";
import type { SessionMessageView } from "../src/types/index.js";
const message = (parts: SessionMessageView["parts"]): SessionMessageView => ({id:"answer",role:"assistant",text:"",parts});

describe("visible answer collapse", () => {
  it("keeps short answers short despite large hidden reasoning and tool output", () => {
    expect(isLongVisibleMessage(message([{type:"text",text:"Готово."},{type:"thinking",text:"x".repeat(100000)}, {type:"tool_result",output:"y".repeat(100000)}]),true)).toBe(false);
    expect(isLongVisibleMessage(message([{type:"text",text:"Готово.\n<system-reminder>"+"x".repeat(100000)+"</system-reminder>"}]),true)).toBe(false);
  });
  it("uses the selected JSON view when counting visible lines", () => {
    const compact = JSON.stringify(Array.from({length:30},(_,i)=>i));
    expect(isLongVisibleMessage(message([{type:"text",text:compact}]),false)).toBe(false);
    expect(isLongVisibleMessage(message([{type:"text",text:compact}]),true)).toBe(true);
  });
  it("recognizes long prose while leaving default automatic collapse off", () => {
    expect(isLongVisibleMessage(message([{type:"text",text:"x".repeat(1501)}]),false)).toBe(true);
    const values = new Map<string,string>();
    const storage = {getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
    expect(readCollapseLongMessages(storage)).toBe(false);
    writeCollapseLongMessages(storage,true);
    expect(readCollapseLongMessages(storage)).toBe(true);
    writeCollapseLongMessages(storage,false);
    expect(readCollapseLongMessages(storage)).toBe(false);
  });
});
