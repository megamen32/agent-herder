/** Compatibility entrypoints cannot own a second executor or resume scheduler. */
export type LegacyResumeOperation =
  | "resume_bound_target"
  | "run_and_resume"
  | "attach_pid_and_resume"
  | "attach_query_and_resume"
  | "wait_and_resume"
  | "wait_job_status";

/** Supplied only by trusted Herder integration code, never inferred from env or PATH. */
export interface HerderLegacyFacade {
  invoke(operation: LegacyResumeOperation, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export function standaloneRetirement(operation: string) {
  return {
    ok: false,
    status: "rejected" as const,
    reason: "agent_resume_standalone_retired",
    operation,
    execution_owner: "agent-herder",
    detail: "Use the Agent Herder Resource and Automation APIs with a stable request key and the bound caller session. " +
      "Standalone Agent Resume no longer launches commands, watches processes, or resumes agents. " +
      "Existing receipts remain available for recovery; retry the same Herder execution instead of starting the command again.",
  };
}
