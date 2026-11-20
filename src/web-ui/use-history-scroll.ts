import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Restore the visible message after React prepends a chronological page. */
export function useHistoryScroll(ref: RefObject<HTMLDivElement | null>, page: {order?: "latest"} | undefined) {
  const anchor = useRef<{node: Element; top: number} | undefined>(undefined);
  const lastTop = useRef(0);
  const rememberPosition = useCallback((followLatest = false) => {
    const box = ref.current;
    if (!box || (followLatest && box.scrollHeight - box.clientHeight - box.scrollTop < 120)) return;
    const top = box.getBoundingClientRect().top;
    const node = Array.from(box.querySelectorAll("[data-event-id]")).find(row => row.getBoundingClientRect().bottom > top);
    anchor.current = node ? {node, top: node.getBoundingClientRect().top - top} : undefined;
  }, [ref]);
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = undefined;
    const box = ref.current;
    if (!box || page?.order !== "latest") return;
    if (saved && box.contains(saved.node)) {
      box.scrollTop += saved.node.getBoundingClientRect().top - box.getBoundingClientRect().top - saved.top;
    } else {
      box.scrollTop = box.scrollHeight;
    }
    lastTop.current = box.scrollTop;
  }, [page, ref]);
  const scrolledUp = (box: HTMLDivElement) => {
    const previous = lastTop.current;
    lastTop.current = box.scrollTop;
    return box.scrollTop < previous && box.scrollTop <= 64;
  };
  return { rememberPosition, scrolledUp };
}

/** Re-read the tail only when the ordinary details poll observes a new message.
 * Keep a change pending while the user is loading an older page. */
export function useCodexHistoryUpdates(key: string, lastId: string | undefined, ready: boolean, refresh: () => void) {
  const previous = useRef<{ key: string; id: string } | undefined>(undefined);
  useEffect(() => {
    if (previous.current?.key !== key) previous.current = undefined;
    if (!key || lastId === undefined) return;
    if (!previous.current) {
      previous.current = { key, id: lastId };
    } else if (ready && previous.current.id !== lastId) {
      previous.current.id = lastId;
      refresh();
    }
  }, [key, lastId, ready, refresh]);
}
