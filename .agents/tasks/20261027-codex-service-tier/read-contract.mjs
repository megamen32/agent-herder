// Read-only installed MCP contract observation; no tools/call or inference.
import fs from 'node:fs';
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const client = new Client({name:'herder-service-tier-contract-reader',version:'1'},{versionNegotiation:{mode:'auto'}});
try {
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18787/mcp'),{
  requestInit:{credentials:'omit',redirect:'error'},
 }),{timeout:10000});
 const {tools}=await client.listTools();
 const wanted=['create_session','new_or_resume','fleet_create_session'];
 const receipt={observedAt:new Date().toISOString(),tools:wanted.map(name=>{
  const tool=tools.find(t=>t.name===name);
  return {name,found:!!tool,serviceTier:tool?.inputSchema?.properties?.serviceTier};
 })};
 fs.writeFileSync('.tmp/codex-service-tier-20261027/contract.json',JSON.stringify(receipt,null,2));
 console.log(JSON.stringify(receipt));
} finally {await client.close();}
