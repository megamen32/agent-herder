import type { ListToolsRequest, ListToolsResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { projectToolCatalog } from "./catalog-policy.js";

type ListHandler = (request: ListToolsRequest, context: ServerContext) => ListToolsResult | Promise<ListToolsResult>;

/**
 * SDK 2.0 has no advertise-only flag: disable() also rejects tools/call.
 * Capture its tools/list handler at the public setRequestHandler registration
 * seam, retaining the SDK's schema conversion, metadata and future list state.
 * No tools/call handler, tool registry or validator is replaced or inspected.
 * Registration must be synchronous and precede connect().
 */
export function withCatalogProjection<T>(server: McpServer, register: () => T): T {
  const protocol = server.server;
  const original = protocol.setRequestHandler;
  let installed = false;
  protocol.setRequestHandler = new Proxy(original, {
    apply(target, receiver, args) {
      if (args[0] !== "tools/list") return Reflect.apply(target, receiver, args);
      if (args.length !== 2 || typeof args[1] !== "function") {
        throw new Error("Unsupported SDK tools/list registration");
      }
      const handler = args[1] as ListHandler;
      installed = true;
      return Reflect.apply(target, receiver, ["tools/list", async (request: ListToolsRequest, context: ServerContext) =>
        projectToolCatalog(await handler(request, context))]);
    },
  });
  try {
    const result = register();
    if (!installed) throw new Error("Catalog projection must wrap initial tool registration");
    return result;
  } finally {
    protocol.setRequestHandler = original;
  }
}
