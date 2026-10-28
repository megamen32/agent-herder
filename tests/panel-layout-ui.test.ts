import { describe, expect, it } from "vitest";
import { PANEL_LAYOUT_STORAGE_KEY, defaultPanelLayout, initialPanelLayout, isEmbeddedLhc, readPanelLayout, writePanelLayout } from "../src/web-ui/ui-layout.js";

/** A browser storage that keeps the choice of the owner. */
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

describe("the layout of the panel", () => {
  it("starts an LHC iframe at the chat without replacing the owner's stored layout", () => {
    const store=storage();
    const owner={chatListOpen:true,headerOpen:true,inspectorOpen:true,listFilter:'waiting' as const};
    writePanelLayout(owner,store);
    expect(initialPanelLayout('?from=lhc',true,store)).toEqual({...owner,chatListOpen:false,headerOpen:false,inspectorOpen:false});
    expect(readPanelLayout(store)).toEqual(owner);
    expect(isEmbeddedLhc('?from=lhc',true)).toBe(true);
    expect(initialPanelLayout('?from=lhc',false,store)).toEqual(owner);
    expect(initialPanelLayout('',true,store)).toEqual(owner);
    expect(isEmbeddedLhc('?from=lhc',false)).toBe(false);
    expect(isEmbeddedLhc('',true)).toBe(false);
  });
  it("folds the header of the session by default", () => {
    const layout = defaultPanelLayout();
    expect(layout.headerOpen).toBe(false);
    expect(layout.chatListOpen).toBe(true);
  });

  it("remembers the choice of the owner", () => {
    const store = storage();
    writePanelLayout({ chatListOpen: false, headerOpen: true, inspectorOpen: false, listFilter: "all" }, store);
    expect(readPanelLayout(store)).toEqual({ chatListOpen: false, headerOpen: true, inspectorOpen: false, listFilter: "all" });
  });

  it("remembers the slice of the list the owner chose", () => {
    const store = storage();
    writePanelLayout({ chatListOpen: true, headerOpen: false, inspectorOpen: true, listFilter: "waiting" }, store);
    expect(readPanelLayout(store).listFilter).toBe("waiting");
  });

  it("keeps the layout of the session when the browser stored nothing", () => {
    expect(readPanelLayout(storage())).toEqual(defaultPanelLayout());
  });

  it("ignores a stored value that makes no sense", () => {
    const store = storage();
    store.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify({ chatListOpen: "да" }));
    expect(readPanelLayout(store)).toEqual(defaultPanelLayout());
  });

  it("survives a browser that refuses to store", () => {
    const broken = {
      getItem: () => { throw new Error("no storage"); },
      setItem: () => { throw new Error("no storage"); },
      removeItem: () => { throw new Error("no storage"); },
      clear: () => { throw new Error("no storage"); },
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(() => writePanelLayout(defaultPanelLayout(), broken)).not.toThrow();
    expect(readPanelLayout(broken)).toEqual(defaultPanelLayout());
  });
});
