/** Native model identity syntax only; availability is checked against the owning adapter catalog. */
export function isRecoveryModelReference(model: string, harness?: "opencode" | "zcode" | "codex"): boolean {
  if (!model || model !== model.trim() || model.length > 256 || /[\u0000-\u0020\u007f\\]/u.test(model)) return false;
  if (harness === "codex") return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model);
  return /^(?:account:)?[A-Za-z0-9][A-Za-z0-9._:-]*\/[^/]+(?:\/[^/]+)*$/u.test(model);
}

export function quotaEvidenceModelReference(providerId: string, modelId: string): string | undefined {
  const provider = providerId.trim();
  const model = modelId.trim();
  const full = model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  return isRecoveryModelReference(full) ? full : undefined;
}
