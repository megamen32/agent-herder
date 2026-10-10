type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type HerderTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "agent-herder.theme";

/** Тёмная — тема по умолчанию; светлая включается только явным выбором. */
export const DEFAULT_THEME: HerderTheme = "dark";

export const normalizeTheme = (value: unknown): HerderTheme => (value === "light" ? "light" : DEFAULT_THEME);

export const readTheme = (storage: WebStorage): HerderTheme => {
  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
};

export const writeTheme = (storage: WebStorage, theme: HerderTheme): void => {
  try {
    if (theme === DEFAULT_THEME) storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // несохранённый выбор всё равно применяется в этой сессии
  }
};

/** Переключение мгновенное: меняет атрибут у <html>, CSS перекрашивает всё без перезагрузки. */
export const applyTheme = (root: { dataset: DOMStringMap }, theme: HerderTheme): void => {
  root.dataset.theme = theme;
};