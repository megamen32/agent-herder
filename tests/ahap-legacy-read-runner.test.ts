import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { serveOpenCodeAhap } from "../src/ahap-opencode-runner.js";
import { serveZcodeAhap } from "../src/ahap-zcode-runner.js";
import { serveBrowserChatAhap } from "../src/ahap-browser-runner.js";

const scope = "a".repeat(64);
const rpc = (id: number, method: string, params = {}) => ({ jsonrpc: "2.0", id, method, params });
async function run(harness: string, adapter: any, calls: any[]) {
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", chunk => { text += chunk; });
  const serving = harness === "opencode" ? serveOpenCodeAhap(adapter, input, output, "v2")
    : harness === "zcode" ? serveZcodeAhap(adapter, input, output)
    : serveBrowserChatAhap(adapter, input, output, scope);
  input.end([rpc(1,"initialize",{harness,ahapVersion:"0.1"}),rpc(2,"init"), ...calls].map(x=>JSON.stringify(x)).join("\n")+"\n");
  await serving; return text.trim().split("\n").map(x=>JSON.parse(x));
}
for (const harness of ["opencode", "zcode", "chatgpt", "zai"]) {
  it(`${harness}: exposes available legacy reads, forwards filters and preserves raw bytes/provenance`, async () => {
    const raw = { bytes: new Uint8Array([0,255,195,40,10]), complete: false, source: {kind:"native-api",location:"fixture:exact",format:"jsonl"},timestampCoverage:"partial",limitations:["native page incomplete"] };
    const adapter = { type:harness,name:harness,browserFeatures:{},getAccountScope:()=>scope,init:vi.fn(),
      listSessions:vi.fn(async()=>[{id:"existing"}]),getRawTranscript:vi.fn(async()=>raw),listProjects:vi.fn(async()=>[{id:"project-exact",name:"fixture"}]) };
    const replies = await run(harness,adapter,[rpc(3,"listSessions",{options:{limit:7,cwd:"/tmp/project"}}),rpc(4,"getRawTranscript",{id:"existing"}),rpc(5,"listProjects")]);
    expect(replies[0].result.capabilities.methods).toEqual(expect.arrayContaining(["listSessions","getRawTranscript","listProjects"]));
    expect(adapter.listSessions).toHaveBeenCalledWith({limit:7,cwd:"/tmp/project"});
    expect(adapter.getRawTranscript).toHaveBeenCalledWith("existing");
    expect(replies[3].result).toEqual({bytes_base64:Buffer.from(raw.bytes).toString("base64"),complete:false,source:raw.source,timestampCoverage:"partial",limitations:raw.limitations});
    expect(replies[4].result).toEqual([{id:"project-exact",name:"fixture"}]);
  });
  it(`${harness}: null transcript stays null and invalid IDs never reach adapter`, async () => {
    const adapter = {type:harness,name:harness,browserFeatures:{},getAccountScope:()=>scope,init:vi.fn(),getRawTranscript:vi.fn(async()=>null)};
    const replies = await run(harness,adapter,[rpc(3,"getRawTranscript",{id:"missing"}),rpc(4,"getRawTranscript",{id:""})]);
    expect(replies[2].result).toBeNull(); expect(replies[3].error.code).toBe(-32602);
    expect(adapter.getRawTranscript).toHaveBeenCalledTimes(1);
    expect(replies[0].result.capabilities.methods).not.toContain("listProjects");
  });
}
it("a native adapter that ignores the requested page limit still answers inside the AHAP frame budget", async () => {
  const preview = "x".repeat(64 * 1024);
  const rows = Array.from({ length: 400 }, (_, index) => ({ id: `row-${index}`, cwd: "/tmp/project", lastMessage: preview }));
  const adapter = { init: vi.fn(), listSessions: vi.fn(async () => rows) };
  const replies = await run("opencode", adapter, [rpc(3, "listSessions", { options: { limit: 5 } })]);
  expect(replies[2].error).toBeUndefined();
  expect(replies[2].result).toHaveLength(5);
  expect(replies[2].result[0]).toMatchObject({ id: "row-0", cwd: "/tmp/project" });
});
it("oversized native export returns explicit bounded error and continues JSONL reads", async () => {
  const adapter={init:vi.fn(),getRawTranscript:vi.fn(async()=>({bytes:new Uint8Array(4*1024*1024),complete:true,source:{kind:"native-file",location:"fixture",format:"jsonl"},timestampCoverage:"native"})),listSessions:vi.fn(async()=>[{id:"still-readable"}])};
  const replies=await run("opencode",adapter,[rpc(3,"getRawTranscript",{id:"large"}),rpc(4,"listSessions")]);
  expect(replies[2].error).toMatchObject({code:-32001,data:{outcome:"read_failed",method:"getRawTranscript"}});
  expect(replies[2].error.message).toContain("No truncated transcript");
  expect(replies[3].result).toEqual([{id:"still-readable"}]);
});
