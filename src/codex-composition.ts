import type { CodexAppServerAdapter } from "./adapters/codex-app-server.js";
import { trustedTransportPreflight, trustedTransportResolver, type TrustedOperatorProfile } from "./codex-trusted-transport.js";

export function createCodexAppServerConfig(profile: TrustedOperatorProfile | undefined, env: NodeJS.ProcessEnv = process.env): ConstructorParameters<typeof CodexAppServerAdapter>[0] {
  return { codexBin: env.CODEX_BIN, cwd: env.CODEX_CWD, modelIds: (env.CODEX_MODELS ?? "").split(",").map(x => x.trim()).filter(Boolean), trustedTransportResolver: trustedTransportResolver(profile), trustedTransportPreflight: trustedTransportPreflight(profile) };
}
