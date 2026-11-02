// Side-effect imports: each adapter file calls registerHarnessRuntimeCapabilities()
// at module load, populating the accumulator that harnessRuntimeCapabilities()
// reads. Import this once from any test that exercises a harness by name.
import "../src/adapters/codex-app-server.js";
import "../src/adapters/opencode.js";
import "../src/adapters/claude.js";
import "../src/adapters/qoder.js";
import "../src/adapters/hermes/adapter.js";
import "../src/adapters/zcode.js";
import "../src/adapters/fast-agent.js";
import "../src/adapters/minimax-code.js";
import "../src/adapters/browser-chat.js";
