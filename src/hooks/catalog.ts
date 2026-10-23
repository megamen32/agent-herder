/**
 * The hooks of the product and what each of them may forbid.
 *
 * The hooks are the ones of the plugin of the herder: the same five events
 * arrive from Claude Code, from Codex and from MiniMax Code. A hook that may
 * forbid is a hook that can refuse a tool call or hold the stop of a turn; a
 * hook that only carries the context of the session forbids nothing, and the
 * lever of the owner does not change what it does.
 */

/** The five events the plugin of the herder subscribes to. */
export type HookKind = "Stop" | "PreToolUse" | "PostToolUse" | "SessionStart" | "UserPromptSubmit";

/** Every kind of hook, in the order the owner reads them. */
export const HOOK_KINDS: readonly HookKind[] = [
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
];

/** What one hook of the product is and what it may forbid. */
export interface HookDescriptor {
  /** The name of the event the harness delivers. */
  kind: HookKind;
  /** The name of the hook as the owner reads it. */
  humanName: string;
  /** What the hook does. */
  purpose: string;
  /** Where the hook acts. */
  scope: string;
  /** True when the hook may forbid a tool call or hold the stop of a turn. */
  canProhibit: boolean;
  /** What the hook does when it forbids. */
  prohibition: string;
}

/** The catalog of the hooks of the product. */
export const HOOK_CATALOG: readonly HookDescriptor[] = [
  {
    kind: "Stop",
    humanName: "Хук остановки (Stop)",
    purpose: "Смотрит, нужно ли продолжить ход сессии, и может оставить сессию без остановки.",
    scope: "ход сессии",
    canProhibit: true,
    prohibition: "не даёт сессии остановиться и продолжает ход",
  },
  {
    kind: "PreToolUse",
    humanName: "Хук перед вызовом инструмента (PreToolUse)",
    purpose: "Проверяет вызов инструмента до его выполнения и может отказать в нём.",
    scope: "вызов инструмента",
    canProhibit: true,
    prohibition: "отказывает в вызове инструмента",
  },
  {
    kind: "PostToolUse",
    humanName: "Хук после вызова инструмента (PostToolUse)",
    purpose: "Отмечает выполненный вызов инструмента и может остановить ход после него.",
    scope: "вызов инструмента",
    canProhibit: true,
    prohibition: "останавливает ход после вызова инструмента",
  },
  {
    kind: "SessionStart",
    humanName: "Хук старта сессии (SessionStart)",
    purpose: "Передаёт сессии её контекст и входящие сообщения при старте.",
    scope: "старт сессии",
    canProhibit: false,
    prohibition: "ничего не запрещает",
  },
  {
    kind: "UserPromptSubmit",
    humanName: "Хук запроса пользователя (UserPromptSubmit)",
    purpose: "Принимает запрос пользователя и передаёт сессии её контекст.",
    scope: "запрос пользователя",
    canProhibit: false,
    prohibition: "ничего не запрещает",
  },
];

/** The descriptor of one kind of hook. */
export function hookDescriptor(kind: HookKind): HookDescriptor {
  const found = HOOK_CATALOG.find((hook) => hook.kind === kind);
  if (!found) throw new Error(`unknown hook kind: ${kind}`);
  return found;
}

/** Is this the name of a hook of the product? */
export function isHookKind(value: unknown): value is HookKind {
  return typeof value === "string" && (HOOK_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds of hook that may forbid something.
 *
 * Only these hooks are affected by the lever of the owner: the others carry
 * the context of the session and never refuse anything.
 */
export const PROHIBITING_HOOK_KINDS: readonly HookKind[] = HOOK_CATALOG
  .filter((hook) => hook.canProhibit)
  .map((hook) => hook.kind);
