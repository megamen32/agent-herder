import type { S21Ownership } from "../s21-resource-ownership.js";

const operations: Record<string, string> = {
  "tproxy-keepalive": "запись трафика приложения Rutube",
  "system:agentcall-tts-google": "подготовка речи голосового помощника",
  "system:agentcall-tts": "подготовка голосового уведомления",
  "system:agentcall-gatewayd": "восстановление телефонной связи",
  "system:agentcall-sip-watchdog": "восстановление телефонной связи",
};
const harnessNames: Record<string, string> = {
  codex: "Codex", claude: "Claude", opencode: "OpenCode", hermes: "Hermes",
  zcode: "ZCode", "fast-agent": "Fast Agent", qoder: "Qoder", chatgpt: "ChatGPT",
};

export function s21OwnershipView(value: S21Ownership | null) {
  if (!value || value.status === "unavailable") return { label: "Проверка телефона недоступна", detail: value?.message ?? "Проверяю аренду S21…", href: null, technical: null };
  if (value.status === "free") return { label: "Телефон свободен", detail: "Samsung S21 доступен для новой аренды.", href: null, technical: null };
  const actor = value.actor;
  if (!actor) return { label: "Проверка телефона недоступна", detail: "Владелец аренды не подтверждён.", href: null, technical: null };
  const operation = Object.hasOwn(operations, actor.task) ? operations[actor.task] : "другая задача";
  const harness = actor.harness && Object.hasOwn(harnessNames, actor.harness) ? harnessNames[actor.harness] : null;
  const detail = actor.type === "legacy" ? "Сессия не записана"
    : actor.type === "system" ? "Владелец: системная служба"
    : `Владелец: агент${harness ? ` ${harness}` : ""}`;
  // Operation aliases describe the work, never infer a legacy actor's origin.
  return { label: `Телефон занят: ${operation}`, detail, href: actor.sessionUrl,
    technical: { owner: actor.task, purpose: actor.purpose, systemUnit: actor.systemUnit } };
}
