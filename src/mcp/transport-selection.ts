import {serveStdio} from '@modelcontextprotocol/server/stdio';
import type {McpServer} from '@modelcontextprotocol/server';

/** A managed HTTP singleton has no stdin consumer. Standalone CLI clients keep
 * the existing stdio transport when no HTTP listener has been requested. */
export function startSelectedStdio(webPort:string|undefined,factory:()=>McpServer,onerror:(error:Error)=>void):boolean {
  if(webPort)return false;
  serveStdio(factory,{onerror});
  return true;
}
