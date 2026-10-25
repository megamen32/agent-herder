import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { HooksProhibitionsStore } from "../../src/hooks/state.js";

/**
 * The optional hooks runtime of the herder is off until the owner turns it on.
 *
 * A test of the coordination context needs it on: the context is carried into
 * the session by a hook, and a hook that does not run carries nothing. The
 * switch is written into an isolated state directory, so the test never reads
 * the state of the machine and never changes it.
 */
export async function turnHooksRuntimeOn(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "herder-hooks-runtime-"));
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", directory);
  await HooksProhibitionsStore.at(directory).apply({ source: "owner", hooksEnabled: true });
}
