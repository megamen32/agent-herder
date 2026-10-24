/**
 * The error of the read of a session, as the owner reads it.
 *
 * The panel speaks to the owner in the words of the owner. The code of the
 * backend is not a sentence: «Session not found» tells the owner nothing
 * about what to do, and it says nothing about the session that was chosen.
 * The text here names the state and the way out.
 */

/** The reason of the failure of the read, and what the owner does next. */
export type SessionOpenError = { reason: string; hint: string };

/** The error of the read of the session, as the owner reads it. */
export function sessionDetailsErrorText(error: string | undefined): SessionOpenError | null {
  if (!error) return null;
  if (/not found/i.test(error)) {
    return {
      reason: "Сессия не найдена на этой машине",
      hint: "Что делать: проверьте, что машина сессии подтверждена в кабинете флота, и откройте сессию на той машине.",
    };
  }
  if (/timeout|timed out|abort/i.test(error)) {
    return {
      reason: "Сессия не ответила вовремя",
      hint: "Что делать: повторите выбор сессии.",
    };
  }
  return {
    reason: `Не удалось открыть сессию: ${error}`,
    hint: "Что делать: проверьте, что herder отвечает, и повторите выбор сессии.",
  };
}

/**
 * The empty inspector, as the owner reads it.
 *
 * A session that was chosen and did not open is not «no session chosen»: the
 * owner chose one, and the panel says what happened to it.
 */
export function emptyInspectorText(activeKey: string | undefined, error: string | undefined): string {
  if (!activeKey) return "Сессия не выбрана.";
  const failure = sessionDetailsErrorText(error);
  if (!failure) return "Сессия выбрана, но ещё открывается.";
  return `${failure.reason}. ${failure.hint}`;
}
