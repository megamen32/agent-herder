/**
 * The layout of the panel: which of its three columns the owner sees.
 *
 * The panel has three columns — the list of chats on the left, the session
 * header above the chat, and the inspector on the right. Every one of them can
 * be hidden, and the choice belongs to the owner, so it is remembered in this
 * browser and read back on the next visit.
 */

/** The slice of the session list the owner looks at. */
export type PanelListFilter = "working" | "waiting" | "all";

export type PanelLayout = {
  /** The list of chats on the left. */
  chatListOpen: boolean;
  /** The session header above the chat, unfolded with its details. */
  headerOpen: boolean;
  /** The inspector on the right. */
  inspectorOpen: boolean;
  /** The slice of the session list: working, waiting for a task, or all. */
  listFilter: PanelListFilter;
};

export const PANEL_LAYOUT_STORAGE_KEY = "agent-herder.layout";

/** The layout a browser that never chose anything gets. */
export function defaultPanelLayout(): PanelLayout {
  // The list shows the working sessions by default: the counter above it
  // promises exactly that many, and the rest waits one click away.
  return { chatListOpen: true, headerOpen: false, inspectorOpen: true, listFilter: "working" };
}

/** The stored layout, or the default one when the browser stored nothing sane. */
export function readPanelLayout(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): PanelLayout {
  const fallback = defaultPanelLayout();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PanelLayout> | null;
    if (!parsed || typeof parsed !== "object") return fallback;
    const listFilter = parsed.listFilter === "working" || parsed.listFilter === "waiting" || parsed.listFilter === "all"
      ? parsed.listFilter
      : fallback.listFilter;
    return {
      chatListOpen: typeof parsed.chatListOpen === "boolean" ? parsed.chatListOpen : fallback.chatListOpen,
      headerOpen: typeof parsed.headerOpen === "boolean" ? parsed.headerOpen : fallback.headerOpen,
      inspectorOpen: typeof parsed.inspectorOpen === "boolean" ? parsed.inspectorOpen : fallback.inspectorOpen,
      listFilter,
    };
  } catch {
    return fallback;
  }
}

/** The chosen layout is remembered; a browser that refuses to store it keeps the layout of the session. */
export function writePanelLayout(layout: PanelLayout, storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): void {
  if (!storage) return;
  try {
    storage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify({
      chatListOpen: layout.chatListOpen,
      headerOpen: layout.headerOpen,
      inspectorOpen: layout.inspectorOpen,
      listFilter: layout.listFilter,
    }));
  } catch {
    /* a browser that refuses to store keeps the layout of the session */
  }
}
