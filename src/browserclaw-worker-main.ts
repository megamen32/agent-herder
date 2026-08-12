import { startConfiguredBrowserClawWorker } from "./browserclaw-worker.js";

startConfiguredBrowserClawWorker().catch((error) => {
  console.error(error instanceof Error ? error.message : "BrowserClaw worker failed to start");
  process.exitCode = 1;
});
