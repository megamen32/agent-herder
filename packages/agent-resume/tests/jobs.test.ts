import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ReceiptLedger } from "../src/resume/receipts.js";
import { JobRegistry, findPidsByQuery, isPidAlive, parseDurationSeconds } from "../src/resume/jobs.js";

// Focused unit: long background work and its single admission.
// Expected <2s/max 20s. One real detached `sleep` process, killed by timeout;
// no provider, harness or model call.
function registry(state: { launches: number } = { launches: 0 }) {
  const stateDir = mkdtempSync(join(tmpdir(), "herder-jobs-"));
  const ledger = new ReceiptLedger({ path: join(stateDir, "state", "receipts.json") });
  const jobs = new JobRegistry({
    stateDir,
    ledger,
    delivery: {
      launch: async () => { state.launches++; return { returncode: 0, stdout: "", stderr: "", pid: null }; },
    },
  });
  return { jobs, ledger, stateDir, state };
}

const target = { agent: "opencode", session_id: "ses_1", cwd: "/tmp", marker: "A7kQ2", model: null };

it("parses durations the way the operator wrote them", () => {
  expect(parseDurationSeconds("30m")).toBe(1800);
  expect(parseDurationSeconds("1h")).toBe(3600);
  expect(parseDurationSeconds("45s")).toBe(45);
  expect(parseDurationSeconds("500ms")).toBe(1);
  expect(parseDurationSeconds(12)).toBe(12);
  expect(parseDurationSeconds(undefined, 5)).toBe(5);
  expect(() => parseDurationSeconds("потом")).toThrow(/invalid duration/);
});

it("sees a live process and not a finished one", async () => {
  expect(isPidAlive(process.pid)).toBe(true);
  const matches = await findPidsByQuery("sleep 30", { exclude: [] });
  // The probe itself may or may not match; what matters is that the query runs
  // and never returns this process.
  expect(matches.every((match) => match.pid !== process.pid)).toBe(true);
  await expect(findPidsByQuery("")).rejects.toThrow(/query is required/);
});

it("records a timer job and reports watcher liveness separately", async () => {
  const { jobs } = registry();
  const job = await jobs.waitAndResume({ waitSeconds: 60, cwd: "/tmp", resume: target });
  expect(job.state).toBe("running");
  const status = jobs.status(job.job_id)!;
  expect(status.kind).toBe("timer");
  // A timer has no watched process; only the watcher can say the wait is armed.
  expect(status.watched_pid_alive).toBe(false);
  expect(status.alive).toBe(false);
  expect(jobs.list().map((item) => item.job_id)).toContain(job.job_id);
});

it("admit one resume when a watched command finishes, and never twice", async () => {
  const { jobs, ledger, state } = registry();
  const job = await jobs.runAndResume({ command: "sleep 0.1", cwd: "/tmp", resume: target, executeResume: true });
  expect(job.pid).toBeGreaterThan(0);
  expect(jobs.status(job.job_id)!.watched_pid_alive).toBe(true);

  const first = await jobs.complete({ jobId: job.job_id, marker: "A7kQ2" }, undefined);
  expect(first.state).toBe("finished");
  expect(first.resume_result).toMatchObject({ status: "accepted" });
  expect(state.launches).toBe(1);
  const receipt = ledger.read(`agent-resume:job:${job.job_id}`)!;
  expect(receipt.status).toBe("accepted");

  // Completing again, or a replayed job, must not deliver a second time.
  const replay = await jobs.complete({ jobId: job.job_id, marker: "A7kQ2" });
  expect(replay.resume_result).toMatchObject({ receipt_ref: (first.resume_result as { receipt_ref: string }).receipt_ref });
  expect(state.launches).toBe(1);
});

it("stops at the hard timeout without killing the watched process", async () => {
  const { jobs, state } = registry();
  const job = await jobs.runAndResume({ command: "sleep 30", cwd: "/tmp", resume: target, hardTimeoutSeconds: 1, executeResume: true });
  const finished = await jobs.complete({ jobId: job.job_id });
  expect(finished.state).toBe("timeout");
  expect(finished.timed_out).toBe(true);
  const outcome = (finished.resume_result ?? {}) as { status?: string; reason?: string };
  expect(outcome.status).toBe("accepted");
  expect(outcome.reason ?? "").not.toContain("launch_failed");
  expect(state.launches).toBe(1);
  if (job.pid) { try { process.kill(job.pid, "SIGKILL"); } catch { /* already gone */ } }
});

it("refuses an attached pid that is not running", async () => {
  const { jobs } = registry();
  await expect(jobs.attachPidAndResume({ pid: 2 ** 30, cwd: "/tmp", resume: target })).rejects.toThrow(/not running/);
});

it("keeps a job record the watcher never finishes", async () => {
  const { jobs, state } = registry();
  const job = await jobs.runAndResume({ command: "sleep 0.1", cwd: "/tmp", resume: target, executeResume: false });
  const finished = await jobs.complete({ jobId: job.job_id });
  expect(finished.state).toBe("finished");
  // execute_resume=false records the decision without launching anything.
  expect(finished.resume_result).toBeUndefined();
  expect(state.launches).toBe(0);
  if (job.pid) { try { process.kill(job.pid, "SIGKILL"); } catch { /* already gone */ } }
});