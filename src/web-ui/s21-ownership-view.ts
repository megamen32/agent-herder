import type { S21Ownership } from "../s21-resource-ownership.js";
export function s21OwnershipView(value: S21Ownership | null) {
  if (!value || value.status === "unavailable") return { label: "Проверка телефона недоступна", detail: value?.message ?? "Проверяю аренду S21…", href: null };
  if (value.status === "free") return { label: "Телефон свободен", detail: "Samsung S21 доступен для новой аренды.", href: null };
  const actor = value.actor;
  if (!actor) return { label: "Проверка телефона недоступна", detail: "Владелец аренды не подтверждён.", href: null };
  const detail = actor.type === "legacy" ? "Сессия не записана" : actor.type === "system" ? `Системная задача · ${actor.systemUnit}` : `${actor.harness} · сессия`;
  return { label: `Телефон занят: ${actor.task}`, detail: `${detail} · ${actor.purpose}`, href: actor.sessionUrl };
}
