#!/usr/bin/env python3
"""Anchored, idempotent patcher: preserve user drafts across herder sends.

The ZAI and ChatGPT Mac mini CDP drivers refused to send when the composer
held any text ("composer is unavailable or has an existing draft"), so a
stale junk draft blocked every herder send and parked intros/messages in
deferred forever.

New behaviour: a draft no longer counts as busy. Before the herder's fill,
the current composer text is saved; after the submission (success or fail)
the saved draft is restored via the same fill tool. The save happens after
target selection so it is scoped to the target conversation's composer.

Run from the repo root on roomhacker-server-100. Aborts cleanly on any
missing/non-unique anchor; timestamped .bak-draftpreserve-<UTC> per file.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

REPO = Path("/home/roomhacker/agents-projects/agent-herder")
STAMP = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
BACKUP_SUFFIX = f".bak-draftpreserve-{STAMP}"

ZAI = "src/adapters/zai-cdp-driver.ts"
CGP = "src/adapters/chatgpt-mac-cdp-driver.ts"
ZT = "tests/zai-cdp-driver.test.ts"
CT = "tests/chatgpt-mac-cdp-driver.test.ts"

# ----------------------------------------------------------------- ZAI driver
ZAI_BUSY_OLD = '''  private busy(state: ZaiSnapshot): boolean {
    return state.phase !== "idle" || state.draftPresent ||
      Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS;
  }'''
ZAI_BUSY_NEW = '''  private busy(state: ZaiSnapshot): boolean {
    // A user draft is preserved and restored around the herder's send (see
    // readComposerDraft/restoreComposerDraft), so it no longer counts as
    // busy. Only an active generation or the post-send guard blocks the next send.
    return state.phase !== "idle" ||
      Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS;
  }'''

ZAI_HELPERS = '''  /** Read the user's own unsent draft so the herder's send can restore it
   * after submission instead of clobbering it. */
  private async readComposerDraft(pageId: number): Promise<string> {
    const result = parseChromeEvaluation<{ value: string }>(
      await this.tools.call("evaluate_script", { pageId, function: `() => {
        const editor = document.querySelector('textarea[placeholder="Send a Message"]');
        return { value: editor ? editor.value : "" };
      }` }),
    );
    return result.value ?? "";
  }

  /** Restore the captured draft (or clear the composer when there was none).
   * Skipped silently when the composer is not editable mid-generation; Z.ai
   * keeps its own per-conversation draft state in that case. */
  private async restoreComposerDraft(pageId: number, draft: string): Promise<void> {
    try {
      const snapshot = await this.tools.call("take_snapshot", { pageId });
      const uid = snapshot.match(/uid=([\\w-]+) textbox "Send a Message"/)?.[1];
      if (uid) await this.tools.call("fill", { pageId, uid, value: draft });
    } catch { /* composer not editable mid-generation */ }
  }

'''
ZAI_SENDMSG_ANCHOR = '  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {'

ZAI_CHECK1_OLD = '''      if (this.busy(state)) {
        if (state.phase === "generating" || Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS) {
          throw new Error("prompt is already running; ZAI queue must wait");
        }
        throw new Error("ZAI composer is unavailable or has an existing draft; message not sent");
      }'''
ZAI_CHECK1_NEW = '''      if (this.busy(state)) {
        if (state.phase === "generating" || Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS) {
          throw new Error("prompt is already running; ZAI queue must wait");
        }
        throw new Error("ZAI composer is unavailable; message not sent");
      }'''

ZAI_FILL_OLD = '''      if (!uid) throw new Error("ZAI message composer not found; message not sent");
      await this.tools.call("fill", { pageId: page.id, uid, value: text });'''
ZAI_FILL_NEW = '''      if (!uid) throw new Error("ZAI message composer not found; message not sent");
      // Preserve any user draft across the herder's send and restore it after.
      const savedDraft = await this.readComposerDraft(page.id);
      try {
        await this.tools.call("fill", { pageId: page.id, uid, value: text });'''

ZAI_RETURN_OLD = '''      if (confirmation.remaining === text || confirmation.origin !== ZAI_ORIGIN ||
        !ROUTE_PATTERN.test(confirmation.path)) {
        throw new Error("ZAI submission admission unknown: do not retry automatically");
      }
      return {};
    });
  }'''
ZAI_RETURN_NEW = '''      if (confirmation.remaining === text || confirmation.origin !== ZAI_ORIGIN ||
        !ROUTE_PATTERN.test(confirmation.path)) {
        throw new Error("ZAI submission admission unknown: do not retry automatically");
      }
      return {};
      } finally {
        await this.restoreComposerDraft(page.id, savedDraft).catch(() => undefined);
      }
    });
  }'''

ZAI_MODELMODEL_OLD = '      if (this.busy(state)) return { ok: false, error: "Z.ai model switch requires an idle chat without a personal draft" };'
ZAI_MODELMODEL_NEW = '      if (this.busy(state)) return { ok: false, error: "Z.ai model switch requires an idle chat" };'

# ------------------------------------------------------------- ChatGPT driver
CGP_BUSY_OLD = '''  private busy(s: Snapshot): boolean {
    return s.phase !== "idle" || s.draftPresent ||
      Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS;
  }'''
CGP_BUSY_NEW = '''  private busy(s: Snapshot): boolean {
    // A user draft is preserved and restored around the herder's send (see
    // readComposerDraft/restoreComposerDraft), so it no longer counts as
    // busy. Only an active generation or the post-send guard blocks the next send.
    return s.phase !== "idle" ||
      Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS;
  }'''

CGP_HELPERS = '''  /** Read the user's own unsent draft so the herder's send can restore it
   * after submission instead of clobbering it. */
  private async readComposerDraft(pageId: number): Promise<string> {
    const result = parseChromeEvaluation<{ value: string }>(
      await this.tools.call("evaluate_script", { pageId, function: `() => {
        const editor = document.querySelector('div[contenteditable="true"][role="textbox"][data-composer-markdown]');
        return { value: editor ? (editor.innerText || editor.textContent || "") : "" };
      }` }),
    );
    return result.value ?? "";
  }

  /** Restore the captured draft (or clear the composer when there was none).
   * Skipped silently when the composer is not editable mid-generation; ChatGPT
   * keeps its own per-conversation draft state in that case. */
  private async restoreComposerDraft(pageId: number, draft: string): Promise<void> {
    try {
      const snapshot = await this.tools.call("take_snapshot", { pageId });
      const uid = snapshot.match(/uid=([\\w-]+) textbox "(?:Спросить ChatGPT|Ask ChatGPT|Ask anything|Message ChatGPT)"/i)?.[1];
      if (uid) await this.tools.call("fill", { pageId, uid, value: draft });
    } catch { /* composer not editable mid-generation */ }
  }

'''
CGP_SENDMSG_ANCHOR = '  async sendMessage(input: { chatId: string; text: string; waitForCompletion?: boolean }): Promise<{ assistantText?: string }> {'

CGP_CHECK1_OLD = '''      if (this.busy(state)) {
        if (state.phase === "generating" || Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS) {
          throw new Error("prompt is already running; browser queue must wait");
        }
        throw new Error("ChatGPT composer unavailable or has a personal draft; message not sent");
      }'''
CGP_CHECK1_NEW = '''      if (this.busy(state)) {
        if (state.phase === "generating" || Date.now() - this.lastSubmittedAt < POST_SEND_GUARD_MS) {
          throw new Error("prompt is already running; browser queue must wait");
        }
        throw new Error("ChatGPT composer unavailable; message not sent");
      }'''

CGP_FILL_OLD = '''      if (!textbox) throw new Error("ChatGPT editor unavailable; message not sent");
      await this.tools.call("fill", { pageId: page.id, uid: textbox, value: text });'''
CGP_FILL_NEW = '''      if (!textbox) throw new Error("ChatGPT editor unavailable; message not sent");
      // Preserve any user draft across the herder's send and restore it after.
      const savedDraft = await this.readComposerDraft(page.id);
      try {
        await this.tools.call("fill", { pageId: page.id, uid: textbox, value: text });'''

CGP_RETURN_OLD = '''      this.lastSubmittedAt = Date.now();
      return {};
    });
  }'''
CGP_RETURN_NEW = '''      this.lastSubmittedAt = Date.now();
      return {};
      } finally {
        await this.restoreComposerDraft(page.id, savedDraft).catch(() => undefined);
      }
    });
  }'''

# ------------------------------------------------------------------- ZAI tests
ZT_CATCHALL_OLD = '    return evalJson({ ...this.page, draftPresent: Boolean(this.draft) || this.page.draftPresent });'
ZT_CATCHALL_NEW = '    return evalJson({ ...this.page, draftPresent: Boolean(this.draft) || this.page.draftPresent, value: this.draft });'

ZT_TITLE_OLD = '  it("refuses unknown UI, drafts, and unexpected origins; a stale pin falls back", async () => {'
ZT_TITLE_NEW = '  it("refuses unknown UI and unexpected origins; a stale pin falls back and a draft is preserved", async () => {'

ZT_DRAFT_ASSERT_OLD = '    await expect(protectedDriver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "no" })).rejects.toThrow(/draft/);'
ZT_DRAFT_ASSERT_NEW = '    // A user draft no longer blocks the herder\'s send; it is preserved and restored.\n    await expect(protectedDriver.sendMessage({ chatId: "sidebar:Test%20fixture", text: "no" })).resolves.toEqual({});'

ZT_PRESERVE_APPEND = r'''

describe("ZAI draft preservation", () => {
  it("saves a user draft before the herder's send and restores it after", async () => {
    const tools = new MockChromeTools();
    tools.draft = "user draft text";
    const fills: string[] = [];
    const origCall = tools.call.bind(tools);
    tools.call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "fill") fills.push(String(args.value));
      return origCall(name, args);
    };
    const driver = new ZaiCdpDriver(tools);
    await driver.sendMessage({ chatId: "route:123e4567-e89b-12d3-a456-426614174000", text: "herder msg" });
    expect(fills).toEqual(["herder msg", "user draft text"]);
  });
});
'''

# -------------------------------------------------------------- ChatGPT tests
CT_TITLE_OLD = '  it("will not write while generating, unknown, or when user has a draft", async () => {'
CT_TITLE_NEW = '  it("will not write while generating or unknown; a draft is preserved", async () => {'

CT_DRAFT_SUBCASE_OLD = '''    f.phase = "unknown";
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/unavailable/);
    f.phase = "idle"; f.draft = true;
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/personal draft/);
    expect(f.actions.every(a => ["list_pages","evaluate_script"].includes(a))).toBe(true);'''
CT_DRAFT_SUBCASE_NEW = '''    f.phase = "unknown";
    await expect(driver.sendMessage({ chatId: ID, text: "hold" })).rejects.toThrow(/unavailable/);
    // A user draft no longer blocks the herder's send (preserved + restored);
    // the dedicated preservation test below covers the save/restore sequence.
    expect(f.actions.every(a => ["list_pages","evaluate_script"].includes(a))).toBe(true);'''

CT_PRESERVE_APPEND = r'''

describe("ChatGPT draft preservation", () => {
  it("saves a user draft before the herder's send and restores it after", async () => {
    let composerValue = "user draft text";
    const fills: string[] = [];
    const tools: ChromePageTools = {
      call: async (name, args = {}) => {
        if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/c/" + ID + ")";
        if (name === "take_snapshot") return 'uid=1_42 textbox "Спросить ChatGPT" focusable multiline';
        if (name === "fill") { fills.push(String(args.value)); composerValue = String(args.value); return "ok"; }
        if (name === "evaluate_script") {
          const fn = String(args.function);
          if (fn.includes("editor.innerText")) return json({ value: composerValue });
          if (fn.includes("const expected")) { composerValue = ""; return json({ submitted: true }); }
          return json({ origin: "https://chatgpt.com", path: "/c/" + ID, authenticated: true, composer: true,
            phase: "idle", draftPresent: false, chats: [{ id: ID, title: "Fixture chat" }] });
        }
        throw Error("unexpected tool: " + name);
      },
    };
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0);
    await driver.sendMessage({ chatId: ID, text: "herder msg" });
    expect(fills).toEqual(["herder msg", "user draft text"]);
  });
});
'''

REPLACEMENTS: dict[str, list[tuple[str, str, str]]] = {
    ZAI: [
        (ZAI_BUSY_OLD, ZAI_BUSY_NEW, "zai busy() drops draftPresent"),
        (ZAI_SENDMSG_ANCHOR, ZAI_HELPERS + ZAI_SENDMSG_ANCHOR, "zai readComposerDraft/restoreComposerDraft helpers"),
        (ZAI_CHECK1_OLD, ZAI_CHECK1_NEW, "zai sendMessage busy-check else message"),
        (ZAI_FILL_OLD, ZAI_FILL_NEW, "zai sendMessage save draft + open try"),
        (ZAI_RETURN_OLD, ZAI_RETURN_NEW, "zai sendMessage finally restore draft"),
        (ZAI_MODELMODEL_OLD, ZAI_MODELMODEL_NEW, "zai changeModel error message"),
    ],
    CGP: [
        (CGP_BUSY_OLD, CGP_BUSY_NEW, "chatgpt busy() drops draftPresent"),
        (CGP_SENDMSG_ANCHOR, CGP_HELPERS + CGP_SENDMSG_ANCHOR, "chatgpt readComposerDraft/restoreComposerDraft helpers"),
        (CGP_CHECK1_OLD, CGP_CHECK1_NEW, "chatgpt sendMessage busy-check else message"),
        (CGP_FILL_OLD, CGP_FILL_NEW, "chatgpt sendMessage save draft + open try"),
        (CGP_RETURN_OLD, CGP_RETURN_NEW, "chatgpt sendMessage finally restore draft"),
    ],
    ZT: [
        (ZT_CATCHALL_OLD, ZT_CATCHALL_NEW, "zai mock returns composer value"),
        (ZT_TITLE_OLD, ZT_TITLE_NEW, "zai test title"),
        (ZT_DRAFT_ASSERT_OLD, ZT_DRAFT_ASSERT_NEW, "zai draft no longer blocks send"),
    ],
    CT: [
        (CT_TITLE_OLD, CT_TITLE_NEW, "chatgpt test title"),
        (CT_DRAFT_SUBCASE_OLD, CT_DRAFT_SUBCASE_NEW, "chatgpt draft sub-case removed"),
    ],
}

APPENDS: dict[str, tuple[str, str]] = {
    ZT: ("ZAI draft preservation", ZT_PRESERVE_APPEND),
    CT: ("ChatGPT draft preservation", CT_PRESERVE_APPEND),
}


def main() -> int:
    problems: list[str] = []
    contents: dict[str, str] = {}
    for rel in REPLACEMENTS:
        path = REPO / rel
        if not path.is_file():
            problems.append(f"missing file {rel}")
            continue
        text = path.read_text(encoding="utf-8")
        contents[rel] = text
        for old, new, name in REPLACEMENTS[rel]:
            if text.count(new) and text.count(old) == 0:
                print(f"[skip] {rel}: {name} already applied")
                continue
            count = text.count(old)
            if count != 1:
                problems.append(f"{rel}: anchor for '{name}' found {count}, expected 1")
    for rel, (marker, block) in APPENDS.items():
        if marker in contents.get(rel, ""):
            print(f"[skip] {rel}: append '{marker}' already present")
            APPENDS[rel] = (marker, "")
    if problems:
        print("ABORT: anchors failed verification:")
        for p in problems:
            print("  -", p)
        return 1

    changed: list[str] = []
    for rel, pairs in REPLACEMENTS.items():
        text = contents[rel]
        before = text
        for old, new, name in pairs:
            if old in text:
                text = text.replace(old, new, 1)
                print(f"[ok] {rel}: {name}")
        marker, block = APPENDS.get(rel, ("", ""))
        if block:
            if not text.endswith("\n"):
                text += "\n"
            text += block
            print(f"[ok] {rel}: appended '{marker}' test")
        if text != before:
            src = REPO / rel
            backup = REPO / (rel + BACKUP_SUFFIX)
            backup.write_text(before, encoding="utf-8")
            src.write_text(text, encoding="utf-8")
            changed.append(rel)
            print(f"[write] {rel} (backup {backup.name})")

    print()
    print("SUMMARY:", "changed " + ", ".join(changed) if changed else "nothing to do (idempotent no-op)")
    print("BACKUP SUFFIX:", BACKUP_SUFFIX)
    return 0


if __name__ == "__main__":
    sys.exit(main())
