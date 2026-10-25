/** Authority derived from the validated owner MCP transport, never from tool JSON. */
export const TRUSTED_MESH_MCP_CLIENT_ID = "agent-herder-owner-mcp";
export const TRUSTED_MESH_MCP_SCOPE = "agent-herder:mesh-deliver";

const trustedIngressBrand = Symbol("trusted-mesh-ingress");

export type TrustedMeshIngress = Readonly<{
  principal: typeof TRUSTED_MESH_MCP_CLIENT_ID;
  senderVerified: false;
  [trustedIngressBrand]: true;
}>;

/** The caller address remains attribution. Only authenticated transport metadata creates this capability. */
export function trustedMeshIngressFromMcpAuthInfo(value: unknown): TrustedMeshIngress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const auth = value as { token?: unknown; clientId?: unknown; scopes?: unknown };
  if (typeof auth.token !== "string" || !auth.token.trim()
    || auth.clientId !== TRUSTED_MESH_MCP_CLIENT_ID
    || !Array.isArray(auth.scopes) || !auth.scopes.includes(TRUSTED_MESH_MCP_SCOPE)) return undefined;
  return Object.freeze({
    principal: TRUSTED_MESH_MCP_CLIENT_ID,
    senderVerified: false as const,
    [trustedIngressBrand]: true as const,
  });
}

/** The owner-launched stdio MCP process is itself the authenticated local boundary.
 * Tool arguments still provide attribution only; they cannot mint this capability. */
export function trustedMeshIngressForOwnerStdio(): TrustedMeshIngress {
  return Object.freeze({
    principal: TRUSTED_MESH_MCP_CLIENT_ID,
    senderVerified: false as const,
    [trustedIngressBrand]: true as const,
  });
}

export function isTrustedMeshIngress(value: unknown): value is TrustedMeshIngress {
  return Boolean(value && typeof value === "object" && (value as Partial<TrustedMeshIngress>)[trustedIngressBrand] === true);
}
