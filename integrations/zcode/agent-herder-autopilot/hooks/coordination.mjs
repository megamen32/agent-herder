#!/usr/bin/env node
// One coordination policy for every hook channel; native aliases normalized centrally.
process.env.AGENT_HERDER_HARNESS = "zcode";
await import("../../../../scripts/coordination-hook.mjs");
