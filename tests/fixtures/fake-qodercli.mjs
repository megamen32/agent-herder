import { appendFileSync } from "node:fs";

const counterFile = process.env.FAKE_QODER_COUNTER;
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("qodercli 1.0.0\n");
} else if (args.includes("--list-models")) {
  process.stdout.write("MODEL\nUltimate\nLite\n");
} else {
  if (counterFile) appendFileSync(counterFile, `${args.join(" ")}\n`);
  process.stdout.write(JSON.stringify({ type: "result", result: "ok", is_error: false }) + "\n");
}
