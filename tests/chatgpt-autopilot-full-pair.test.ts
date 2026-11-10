
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { chatgptMessagesApiScript } from "../src/adapters/browser-chat-api-scripts.js";
const id="12345678-abcd-4abc-8def-123456789abc";
function row(messageId:string,role:string,text:string){return {id:messageId,author:{role},content:{parts:[text]},channel:role==="assistant"?"final":undefined,status:role==="assistant"?"finished_successfully":undefined,end_turn:role==="assistant"?true:undefined};}
async function read(messages:unknown[]){
 const fetch=vi.fn(async(url:string)=>new Response(JSON.stringify(url==="/api/auth/session"
  ?{accessToken:"isolated-fixture",account:{id:"fixture-account"}}
  :{conversation_id:id,messages}),{status:200,headers:{"content-type":"application/json"}}));
 const result=await runInNewContext("("+chatgptMessagesApiScript(id)+")()",{fetch,location:{origin:"https://chatgpt.com"},TextEncoder,Date,JSON,Set});
 return {result,fetch};
}
describe("full mandatory ChatGPT messages for autopilot",()=>{
 it("preserves both messages beyond the old 14000 character limit",async()=>{
  const user="Полное требование ".repeat(3000)+"USER_END",answer="Подробный результат ".repeat(2500)+"ANSWER_END";
  const {result,fetch}=await read([row("u","user",user),row("a","assistant",answer)]);
  expect(JSON.parse(JSON.stringify(result.messages))).toMatchObject([{id:"u",text:user},{id:"a",text:answer}]);
  expect(fetch).toHaveBeenCalledTimes(2);
 });
 it("drops old messages before the latest pair and bounds UTF-8 output",async()=>{
  const history=Array.from({length:50},(_,i)=>row("old-"+i,i%2?"assistant":"user","Старое ".repeat(2000)));
  const user="Последняя просьба ".repeat(2000),answer="Последний ответ ".repeat(2000);
  const {result}=await read([...history,row("last-user","user",user),row("last-assistant","assistant",answer)]);
  expect(result.messages.at(-2).text).toBe(user.trim());expect(result.messages.at(-1).text).toBe(answer.trim());
  expect(result.messages.length).toBeLessThan(52);
  expect(Buffer.byteLength(JSON.stringify(result.messages),"utf8")).toBeLessThanOrEqual(512*1024);
 });
 it("preserves native completion evidence separately from final/commentary channel",async()=>{
  const partial={...row("partial","assistant","The final answer is still streaming"),status:"in_progress",end_turn:false};
  const {result}=await read([row("u","user","Please finish"),partial]);
  expect(JSON.parse(JSON.stringify(result.messages.at(-1)))).toMatchObject({
   id:"partial",phase:"final",completionStatus:"in_progress",endTurn:false,
  });
  const {result:complete}=await read([row("u","user","Please finish"),row("a","assistant","The result is complete")]);
  expect(JSON.parse(JSON.stringify(complete.messages.at(-1)))).toMatchObject({
   phase:"final",completionStatus:"finished_successfully",endTurn:true,
  });
 });
 it("does not invent native completion markers when the provider omitted them",async()=>{
  const assistant=row("a","assistant","Unproven final");
  delete assistant.status;delete assistant.end_turn;
  const {result}=await read([row("u","user","Please finish"),assistant]);
  const resultMessage=JSON.parse(JSON.stringify(result.messages.at(-1)));
  expect(resultMessage.phase).toBe("final");
  expect(resultMessage).not.toHaveProperty("completionStatus");
  expect(resultMessage).not.toHaveProperty("endTurn");
 });
 it("reports an oversized mandatory pair rather than silently truncating it",async()=>{
  const {result}=await read([row("u","user","Я".repeat(300_000)),row("a","assistant","Готово")]);
  expect(result.error).toBe("mandatory_message_context_too_large");
  expect(result).not.toHaveProperty("messages");
 });
});
