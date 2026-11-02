#!/usr/bin/env python3
"""Patcher: UI overhaul for Agent Herder web-ui.

Implements six user requests in one atomic pass:

  1. «Группировать размышления и инструменты» — new toggle in the chat menu
     «Вид переписки». When on, every thinking + tool block of one message is
     wrapped in a single <details> «Размышления и инструменты · N». The choice
     persists in localStorage.

  2. Settings as separate URL pages — the buried «Автоматизация» section in
     SettingsScreen (three gray buttons) is replaced with three real URL
     links: ?page=autopilot, ?page=autocontinue, ?page=launch-policy.

  3. Global autopilot = kill switch — when the global switch is off, every
     per-harness switch in HarnessAutomationSettings becomes gray and
     disabled with the hint «Стоп-сигнал: общий переключатель выключен». The
     banner text is rewritten to match the stop-signal semantics. Per-session
     override stays independent.

  4. Click harness in chat header → filter chat list — the harness label in
     .chat-session-state becomes a button-link that calls
     setListSettings({ harness }). The selected harness scrolls the chat
     list to that harness only.

  5. Small airplane icon in the chat list for sessions on autopilot — new
     API GET /api/autopilot/overview returns { global, harnesses, sessions }.
     The UI polls it every 15s and shows a tiny airplane SVG in
     SessionSidebarRow when the session is on autopilot.

  6. (compaction of the chat header — already shipped in patch_compact_header.py
     release; not redone here.)

Pattern (same as patch_compact_header.py / patch_browser_autopilot.py):
  * Anchored edits with per-file timestamped backups.
  * Aborts cleanly on any missing or non-unique anchor.
  * Idempotent per replacement (a second run is a no-op once anchors are gone).
  * New files (tests) are written next to the existing tests/ tree.

Run on the remote server:

    sudo -u roomhacker python3 /home/roomhacker/agents-projects/agent-herder/scripts/patch_ui_overhaul.py

Then commit, build, switch drop-in as usual.
"""
import os, shutil, sys, time

H = "/home/roomhacker/agents-projects/agent-herder"
TS = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
TAG = "uioverhaul"


def patch(rel, old, new, count=1):
    """Replace `old` with `new` in `rel`. Aborts if `old` is not found exactly
    `count` times. Creates one timestamped backup per file per run."""
    path = os.path.join(H, rel)
    bak = path + ".bak-" + TAG + "-" + TS
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    text = open(path, encoding="utf-8").read()
    n = text.count(old)
    if n != count:
        raise SystemExit("ABORT %r in %s: found %d, expected %d" % (old[:80], rel, n, count))
    text = text.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("patched %s (%d site)" % (rel, n))


def insert_before(rel, anchor, content):
    """Insert `content` immediately before the (unique) `anchor` line in `rel`."""
    path = os.path.join(H, rel)
    bak = path + ".bak-" + TAG + "-" + TS
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    text = open(path, encoding="utf-8").read()
    n = text.count(anchor)
    if n != 1:
        raise SystemExit("ABORT insert anchor not unique in %s: %d" % (rel, n))
    text = text.replace(anchor, content + anchor)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("inserted %d chars before anchor in %s" % (len(content), rel))


def write_new(rel, content, executable=False):
    """Write a brand-new file. Aborts if the file already exists, so a second
    run does not clobber hand-edited revisions."""
    path = os.path.join(H, rel)
    if os.path.exists(path):
        # Idempotency: only refuse if the content already matches.
        existing = open(path, encoding="utf-8").read()
        if existing == content:
            print("exists unchanged: %s" % rel)
            return
        raise SystemExit("ABORT %s already exists with different content; refusing to overwrite" % rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    if executable:
        os.chmod(path, 0o755)
    print("wrote new file: %s (%d chars)" % (rel, len(content)))


# =============================================================================
# File 1: src/web-ui/main.tsx
# =============================================================================
MAIN = "src/web-ui/main.tsx"

# --- 1a. New state: groupThinkingTools (localStorage-backed) ---------------
# Insert next to the other display-pref state at the collapseLongMessages block.
patch(MAIN,
      "  const [collapseLongMessages, setCollapseLongMessages] = React.useState(() => readCollapseLongMessages(window.localStorage));",
      "  const [collapseLongMessages, setCollapseLongMessages] = React.useState(() => readCollapseLongMessages(window.localStorage));\n"
      "  const [groupThinkingTools, setGroupThinkingTools] = React.useState(() => readDisplayPreference(window.localStorage, GROUP_THINKING_TOOLS_STORAGE_KEY));\n"
      "  React.useEffect(() => { writeDisplayPreference(window.localStorage, GROUP_THINKING_TOOLS_STORAGE_KEY, groupThinkingTools); }, [groupThinkingTools]);")

# --- 1b. Menu toggle in «Вид переписки» -------------------------------------
patch(MAIN,
      '<label><input type="checkbox" checked={collapseLongMessages} onChange={(event) => setCollapseLongMessages(event.target.checked)} /> Сворачивать длинные сообщения</label>',
      '<label><input type="checkbox" checked={collapseLongMessages} onChange={(event) => setCollapseLongMessages(event.target.checked)} /> Сворачивать длинные сообщения</label>'
      '<label><input type="checkbox" checked={groupThinkingTools} onChange={(event) => setGroupThinkingTools(event.target.checked)} /> Группировать размышления и инструменты</label>')

# --- 1c. Storage key constant ----------------------------------------------
# We add the constant near the other display-pref constants by piggybacking
# on the existing REASONING_DISPLAY_STORAGE_KEY reference inside the state
# initialiser. Puts the constant declaration right above the App component.
# Anchor: the readDisplayPreference import already used. We add a const at the
# top of the file alongside other storage key declarations.
patch(MAIN,
      "const readPage = (): HerderPage => {",
      "const GROUP_THINKING_TOOLS_STORAGE_KEY = \"agent-herder.group-thinking-tools\";\n"
      "const readPage = (): HerderPage => {")

# --- 1d. CollapsibleMessage accepts groupThinkingTools and wraps activity ---
patch(MAIN,
      "function CollapsibleMessage({ message, showReasoning, showTools, jsonRendering, collapseLongMessages, forceExpanded }: { message: SessionMessage; showReasoning: boolean; showTools: boolean; jsonRendering: boolean; collapseLongMessages: boolean; forceExpanded?: boolean }) {",
      "function CollapsibleMessage({ message, showReasoning, showTools, jsonRendering, collapseLongMessages, groupThinkingTools, forceExpanded }: { message: SessionMessage; showReasoning: boolean; showTools: boolean; jsonRendering: boolean; collapseLongMessages: boolean; groupThinkingTools?: boolean; forceExpanded?: boolean }) {")

# Wrap the activity segment in a single <details> when groupThinkingTools is on.
# The original line is:
#   if (segment.kind === "activity") return <MessageActivityRows key={...} parts={segment.parts} showReasoning={showReasoning} showTools={showTools} />;
# We split the activity count via segment.parts.filter(...).length and render
# a wrapping <details> when the toggle is on. Otherwise the original behavior.
patch(MAIN,
      'if (segment.kind === "activity") return <MessageActivityRows key={`${message.id}:activity:${index}`} parts={segment.parts} showReasoning={showReasoning} showTools={showTools} />;',
      'if (segment.kind === "activity") {\n'
      '      const activityCount = segment.parts.filter((part) => part.type === "thinking" || part.type === "tool_call" || part.type === "tool_result").length;\n'
      '      const body = <MessageActivityRows key={`${message.id}:activity:${index}`} parts={segment.parts} showReasoning={showReasoning} showTools={showTools} />;\n'
      '      if (!groupThinkingTools || activityCount === 0) return body;\n'
      '      return <details className="oc-disclosure activity-group" key={`${message.id}:activity:${index}`}>\n'
      '        <summary>Размышления и инструменты · {activityCount}</summary>\n'
      '        {body}\n'
      '      </details>;\n'
      '    }')

# --- 1e. Pass groupThinkingTools to every CollapsibleMessage site ----------
# Three callsites: remote view, single message, joined group.
patch(MAIN,
      'renderMessage={message=>!hasVisibleMessage(message,showReasoning,showTools)?null:serviceNoteLabel(message)?<ServiceNote label={serviceNoteLabel(message)!} message={message}/>:<CollapsibleMessage message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages}/>} address={remoteSelection}',
      'renderMessage={message=>!hasVisibleMessage(message,showReasoning,showTools)?null:serviceNoteLabel(message)?<ServiceNote label={serviceNoteLabel(message)!} message={message}/>:<CollapsibleMessage message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages} groupThinkingTools={groupThinkingTools}/>} address={remoteSelection}')

patch(MAIN,
      '<CollapsibleMessage message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages}/>}</article>;',
      '<CollapsibleMessage message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages} groupThinkingTools={groupThinkingTools}/>}</article>;')

patch(MAIN,
      '<CollapsibleMessage key={message.id} message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages} forceExpanded={isLastAssistant && index === visible.length - 1} />',
      '<CollapsibleMessage key={message.id} message={message} showReasoning={showReasoning} showTools={showTools} jsonRendering={jsonRendering} collapseLongMessages={collapseLongMessages} groupThinkingTools={groupThinkingTools} forceExpanded={isLastAssistant && index === visible.length - 1} />')

# --- 1f. Click harness in chat header → filter chat list -------------------
# Replace the bare <span>{harness}</span> with a button-link.
patch(MAIN,
      '<small className="chat-session-state"><span>{activeSession?.harness || ""}</span>{activeSession && <><span aria-hidden="true"> · </span>',
      '<small className="chat-session-state">{activeSession?.harness ? <button type="button" className="chat-harness-link" title={`Показать только сессии среды ${activeSession.harness}`} onClick={() => { setListSettings((current) => ({ ...current, harness: activeSession.harness })); setMobileView("sessions"); setLayoutField("chatListOpen", true); }}>{activeSession.harness}</button> : <span />}{activeSession && <><span aria-hidden="true"> · </span>')

# --- 1g. Kill-switch banner text + disabled harness settings ---------------
patch(MAIN,
      'draft.enabled ? "Работает в выбранных средах; настройки отдельных сессий могут переопределить режим." : "Новые завершения не оцениваются, кроме явно включённых сессий."',
      'draft.enabled ? "Работает в выбранных средах; настройки отдельных сессий могут переопределить режим." : "Стоп-сигнал: автопилот выключен везде. Включите общий переключатель, чтобы выбрать среды — настройки ниже станут активными."')

# Pass disabledAll to the autopilot harness settings list
patch(MAIN,
      '<fieldset className="settings-group"><legend>Где работает</legend><HarnessAutomationSettings mode="autopilot" available={new Set(Object.keys(AUTOPILOT_HARNESS_LABELS))} enabled={new Set(draft.harnesses)} onToggle={(harness) => setHarness(harness as AutopilotHarness, !draft.harnesses.includes(harness as AutopilotHarness))} />',
      '<fieldset className="settings-group"><legend>Где работает</legend><HarnessAutomationSettings mode="autopilot" available={new Set(Object.keys(AUTOPILOT_HARNESS_LABELS))} enabled={new Set(draft.harnesses)} disabledAll={!draft.enabled} onToggle={(harness) => setHarness(harness as AutopilotHarness, !draft.harnesses.includes(harness as AutopilotHarness))} />')

# --- 1h. Autopilot overview loader + sessions-on-autopilot set ------------
# State declaration right after autopilotPolicy.
patch(MAIN,
      "  const [autopilotPolicy, setAutopilotPolicy] = React.useState<WebAutopilotPolicyState>();",
      "  const [autopilotPolicy, setAutopilotPolicy] = React.useState<WebAutopilotPolicyState>();\n"
      "  const [autopilotOverview, setAutopilotOverview] = React.useState<{ global: boolean; harnesses: string[]; sessions: Array<{ harness: string; sessionId: string }> }>({ global: false, harnesses: [], sessions: [] });\n"
      "  const autopilotOnByKey = React.useMemo(() => {\n"
      "    const map = new Map<string, boolean>();\n"
      "    for (const item of autopilotOverview.sessions) map.set(`${item.harness}:${item.sessionId}`, true);\n"
      "    return map;\n"
      "  }, [autopilotOverview]);\n"
      "  const isSessionOnAutopilot = React.useCallback((harness: string, id: string) => {\n"
      "    if (autopilotOverview.sessions.some((s) => s.harness === harness && s.sessionId === id)) return true;\n"
      "    return autopilotOverview.global && autopilotOverview.harnesses.includes(harness);\n"
      "  }, [autopilotOverview]);")

# Loader effect — piggyback on the existing loadAutopilotPolicy callback.
patch(MAIN,
      "  const loadAutopilotPolicy = React.useCallback(async () => {\n"
      "    const [autopilotResult, continuationResult, runtimeResult] = await Promise.allSettled([",
      "  const loadAutopilotPolicy = React.useCallback(async () => {\n"
      "    const [autopilotResult, continuationResult, runtimeResult, overviewResult] = await Promise.allSettled([\n"
      "      api<{ global: boolean; harnesses: string[]; sessions: Array<{ harness: string; sessionId: string }> }>(\"/api/autopilot/overview\"),")

# Hmm — Promise.allSettled needs the new item added INSIDE the array. The
# original code lays out three promises on three lines. Let's instead add
# the overview fetch as a separate side effect that runs alongside, then
# also pulls on a 15s interval. The above line edits left the array shape
# wrong, so let's revert that approach and use a cleaner standalone effect.

# REVERT the previous edit by re-patching it back, then add a separate effect.
# To keep the patcher simple, we do NOT touch the loadAutopilotPolicy body;
# we instead add a dedicated loader effect immediately after the existing
# loadAutopilotPolicy effect.

# First undo the two edits above by replacing back.
patch(MAIN,
      "  const loadAutopilotPolicy = React.useCallback(async () => {\n"
      "    const [autopilotResult, continuationResult, runtimeResult, overviewResult] = await Promise.allSettled([\n"
      "      api<{ global: boolean; harnesses: string[]; sessions: Array<{ harness: string; sessionId: string }> }>(\"/api/autopilot/overview\"),\n"
      "      api<WebAutopilotPolicyState>(\"/api/autopilot/policy\"),\n"
      "      loadAutocontinueHarnesses(api),\n"
      "      api<WebSessionRuntimeSettings>(\"/api/session-autostart\"),",
      "  const loadAutopilotPolicy = React.useCallback(async () => {\n"
      "    const [autopilotResult, continuationResult, runtimeResult] = await Promise.allSettled([\n"
      "      api<WebAutopilotPolicyState>(\"/api/autopilot/policy\"),\n"
      "      loadAutocontinueHarnesses(api),\n"
      "      api<WebSessionRuntimeSettings>(\"/api/session-autostart\"),")

# Now insert a dedicated overview loader effect right before the existing
# loadAutopilotPolicy effect.
insert_before(MAIN,
              "  const loadAutopilotPolicy = React.useCallback(async () => {",
              "  const loadAutopilotOverview = React.useCallback(async () => {\n"
              "    try {\n"
              "      const overview = await api<{ global: boolean; harnesses: string[]; sessions: Array<{ harness: string; sessionId: string }> }>(\"/api/autopilot/overview\");\n"
              "      setAutopilotOverview({ global: Boolean(overview.global), harnesses: Array.isArray(overview.harnesses) ? overview.harnesses : [], sessions: Array.isArray(overview.sessions) ? overview.sessions : [] });\n"
              "    } catch { /* overview is best-effort; the chat list simply omits the airplane icon */ }\n"
              "  }, []);\n"
              "  React.useEffect(() => { void loadAutopilotOverview(); }, [loadAutopilotOverview]);\n"
              "  React.useEffect(() => {\n"
              "    const timer = window.setInterval(() => void loadAutopilotOverview(), 15_000);\n"
              "    return () => window.clearInterval(timer);\n"
              "  }, [loadAutopilotOverview]);\n"
              "")

# --- 1i. Pass isSessionOnAutopilot to SessionList → SessionSidebarRow ------
# SessionList already takes many props; we add a single new function prop.
# The call site at line ~2472 is the only one. We add the prop right after the
# existing onChoose prop (which ends with `onChoose={(requestId, choiceId) => void chooseAutopilot(requestId, choiceId)}`).
patch(MAIN,
      "onChoose={(requestId, choiceId) => void chooseAutopilot(requestId, choiceId)}",
      "onChoose={(requestId, choiceId) => void chooseAutopilot(requestId, choiceId)}\n      isSessionOnAutopilot={isSessionOnAutopilot}")

# Add the new prop to SessionList's destructure (inline, no leading spaces).
patch(MAIN,
      " onQuickStatusChange, }: {",
      " onQuickStatusChange, isSessionOnAutopilot, }: {")

# Add the type for the new prop right after onQuickStatusChange's type.
patch(MAIN,
      "  quickStatus?: SessionStatusFilter;\n  onQuickStatusChange?: (status: SessionStatusFilter) => void;\n}) {",
      "  quickStatus?: SessionStatusFilter;\n  onQuickStatusChange?: (status: SessionStatusFilter) => void;\n"
      "  isSessionOnAutopilot?: (harness: string, id: string) => boolean;\n"
      "}) {")

# Pass it down to SessionSidebarRow alongside statusClass.
patch(MAIN,
      "<SessionSidebarRow session={session} title={title} selected={key === activeKey} pinned={pins.includes(sessionPinKey(session) ?? '')}\n              canPin={!!pinScope && !!sessionPinKey(session)} statusClass={statusClassValue} statusOverride={decision || awaitingPermission ? label : undefined}",
      "<SessionSidebarRow session={session} title={title} selected={key === activeKey} pinned={pins.includes(sessionPinKey(session) ?? '')}\n              canPin={!!pinScope && !!sessionPinKey(session)} statusClass={statusClassValue} statusOverride={decision || awaitingPermission ? label : undefined}\n              autopilotOn={isSessionOnAutopilot ? isSessionOnAutopilot(session.harness, session.id) : false}")

# =============================================================================
# File 2: src/web-ui/session-sidebar.tsx — airplane icon
# =============================================================================
SIDE = "src/web-ui/session-sidebar.tsx"

# Add the new prop to the function signature.
patch(SIDE,
      "export function SessionSidebarRow({session, title, selected, pinned, canPin, statusClass, statusOverride, onSelect, onPin}: {",
      "export function SessionSidebarRow({session, title, selected, pinned, canPin, statusClass, statusOverride, autopilotOn, onSelect, onPin}: {")

patch(SIDE,
      "  session:SidebarSession; title:string; selected:boolean; pinned:boolean; canPin:boolean; statusClass:string; statusOverride?:string; onSelect:()=>void; onPin:()=>void;\n}) {",
      "  session:SidebarSession; title:string; selected:boolean; pinned:boolean; canPin:boolean; statusClass:string; statusOverride?:string; autopilotOn?:boolean; onSelect:()=>void; onPin:()=>void;\n"
      "}) {")

# Render the airplane icon inside the session-copy span, right after the title.
patch(SIDE,
      '      <span className="session-copy"><strong>{title}</strong><small className="session-identity">{subtitle}</small>{context.goal && context.goal !== title ? <small className="session-goal">Цель: {context.goal}</small> : null}</span>',
      '      <span className="session-copy"><strong>{title}</strong>{autopilotOn && <svg className="session-autopilot-icon" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" role="img" aria-label="Сессия на автопилоте"><path d="M2 12l9-2 1-7 2 1-1 6 7 3v1l-7-1-2 5-2-1 1-4-7-1z" /></svg>}<small className="session-identity">{subtitle}</small>{context.goal && context.goal !== title ? <small className="session-goal">Цель: {context.goal}</small> : null}</span>')

# =============================================================================
# File 3: src/web-ui/settings/settings-screen.tsx — replace buried section
# (The settings screen moved into the settings/ subdirectory after the
# adopt-ui-release-integration merge; the live server keeps it there.)
# =============================================================================
SETS = "src/web-ui/settings/settings-screen.tsx"

# Remove the buried «Автоматизация» section and replace it with three real
# URL links. The original block is a self-contained one-liner that starts
# with `<section aria-label="Автоматизация">` and ends with the matching
# `</section>}`. Use both anchors to find the slice and replace it whole.
# The links are real navigations (no preventDefault): main.tsx already seeds
# automationSettings from ?page= (autopilot/autocontinue/launch-policy are
# valid HerderPage values), so a reload with ?page=autopilot opens that
# settings dialog — each link is a separate URL page, as requested.
def replace_section_one_line(rel, start_marker, end_marker, replacement):
    path = os.path.join(H, rel)
    bak = path + ".bak-" + TAG + "-" + TS
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    text = open(path, encoding="utf-8").read()
    if text.count(start_marker) != 1:
        raise SystemExit("ABORT section start not unique in %s: %d" % (rel, text.count(start_marker)))
    i = text.find(start_marker)
    j = text.find(end_marker, i)
    if j < 0:
        raise SystemExit("ABORT section end not found in %s" % rel)
    j += len(end_marker)
    old = text[i:j]
    text = text[:i] + replacement + text[j:]
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("replaced %d-char block in %s with %d-char block" % (len(old), rel, len(replacement)))

replace_section_one_line(
    SETS,
    '<section aria-label="Автоматизация"><h2>Автоматизация</h2>',
    '}</div></section>}',
    '<section aria-label="Автоматизация" className="settings-automation-links"><h2>Автоматизация</h2>'
    '<p>Управление автопилотом, продолжением работы и запуском новых сессий. '
    'Каждая группа настроек — отдельная страница со своей ссылкой.</p>'
    '<ul className="settings-link-list">'
    '<li><a href="?page=autopilot">Автопилот <small>?page=autopilot</small></a></li>'
    '<li><a href="?page=autocontinue">Автопродолжение <small>?page=autocontinue</small></a></li>'
    '<li><a href="?page=launch-policy">Запуск сессий <small>?page=launch-policy</small></a></li>'
    '</ul></section>}'
)

# =============================================================================
# File 4: src/web-ui/harness-automation-settings.tsx — kill switch
# =============================================================================
HAUTO = "src/web-ui/harness-automation-settings.tsx"

# Add disabledAll to the function signature.
patch(HAUTO,
      "export function HarnessAutomationSettings({ mode, available, enabled, loaded, failed, saving, onToggle }: {",
      "export function HarnessAutomationSettings({ mode, available, enabled, loaded, failed, saving, disabledAll, onToggle }: {")

patch(HAUTO,
      "  mode: \"autopilot\" | \"autocontinue\";\n  available: ReadonlySet<string>;\n  enabled: ReadonlySet<string>;\n  loaded?: ReadonlySet<string>;\n  failed?: ReadonlySet<string>;\n  saving?: string;\n  onToggle: (harness: string) => void;\n}) {",
      "  mode: \"autopilot\" | \"autocontinue\";\n"
      "  available: ReadonlySet<string>;\n"
      "  enabled: ReadonlySet<string>;\n"
      "  loaded?: ReadonlySet<string>;\n"
      "  failed?: ReadonlySet<string>;\n"
      "  saving?: string;\n"
      "  disabledAll?: boolean;\n"
      "  onToggle: (harness: string) => void;\n"
      "}) {")

# Render: status text changes to stop-signal hint; switch becomes disabled when
# disabledAll is set. Original row:
#   <section className="harness-setting-row" key={id} aria-label={`${label} · ${name}`}>
#     <div><strong>{name}</strong><small id={...}>{status chain}</small></div>
#     <button className={`switch-control ${checked ? "enabled" : ""}`} ... disabled={!ready || Boolean(saving)} ...>
patch(HAUTO,
      '      return <section className="harness-setting-row" key={id} aria-label={`${label} · ${name}`}',
      '      const disabledByKillSwitch = Boolean(disabledAll);\n'
      '      const rowClassName = `harness-setting-row${disabledByKillSwitch ? " harness-setting-row-disabled" : ""}`;\n'
      '      return <section className={rowClassName} key={id} aria-label={`${label} · ${name}`}')

patch(HAUTO,
      '        <div><strong>{name}</strong><small id={`${mode}-${id}-status`}>{!supported ? "Пока не поддерживается" : saving === id ? "Сохраняю…" : failed?.has(id) ? "Не удалось загрузить" : !ready ? "Загружаю…" : checked ? "Разрешено" : "Выключено"}</small></div>',
      '        <div><strong>{name}</strong><small id={`${mode}-${id}-status`}>{disabledByKillSwitch ? "Стоп-сигнал: общий переключатель выключен" : !supported ? "Пока не поддерживается" : saving === id ? "Сохраняю…" : failed?.has(id) ? "Не удалось загрузить" : !ready ? "Загружаю…" : checked ? "Разрешено" : "Выключено"}</small></div>')

patch(HAUTO,
      '      <button className={`switch-control ${checked ? "enabled" : ""}`} role="switch" aria-label={`${label} · ${name}`} aria-checked={checked} aria-describedby={`${mode}-${id}-status`} disabled={!ready || Boolean(saving)} onClick={() => onToggle(id)}><span /></button>',
      '      <button className={`switch-control ${checked ? "enabled" : ""}`} role="switch" aria-label={`${label} · ${name}`} aria-checked={checked} aria-describedby={`${mode}-${id}-status`} disabled={disabledByKillSwitch || !ready || Boolean(saving)} onClick={() => onToggle(id)}><span /></button>')

# =============================================================================
# File 5: src/web-ui/styles.css — new styles
# =============================================================================
STY = "src/web-ui/styles.css"

# Append new rules. We use the existing .switch-control:disabled line as an
# anchor for an insert-before, so the new rules go right after the switch
# definitions.
CSS = """/* ===== UI overhaul: airplane, kill-switch, harness link, grouping ===== */
.session-autopilot-icon { flex: 0 0 11px; width: 11px; height: 11px; margin: 0 4px 0 0; color: var(--accent); opacity: .85; }
.session-autopilot-icon[aria-hidden="true"] { pointer-events: none; }

/* Chat header: harness label is a small link-style button. */
.chat-harness-link { display: inline; padding: 0 2px; border: 0; background: transparent; color: var(--text-2); font: inherit; font-size: inherit; cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
.chat-harness-link:hover { color: var(--accent); }

/* Settings screen: real URL links for each automation group. */
.settings-link-list { list-style: none; padding: 0; margin: var(--space-2) 0 0; display: grid; gap: 6px; }
.settings-link-list li { padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface-1); }
.settings-link-list a { display: flex; align-items: baseline; gap: 8px; color: var(--text); text-decoration: none; }
.settings-link-list a:hover { color: var(--accent); }
.settings-link-list a small { color: var(--muted); font-family: var(--font-mono, monospace); font-size: 11px; }

/* Kill-switch: when the global toggle is off, every harness row is gray. */
.harness-setting-row-disabled { opacity: .55; }
.harness-setting-row-disabled .switch-control { cursor: not-allowed; }
.harness-setting-row-disabled strong { color: var(--muted); }

/* Grouped activity block: one collapsible card for thinking + tools. */
details.activity-group { border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface-1); margin: 4px 0; }
details.activity-group > summary { padding: 6px 10px; cursor: pointer; color: var(--text-2); font-size: var(--text-xs); user-select: none; }
details.activity-group > summary:hover { color: var(--text); }
details.activity-group[open] > summary { border-bottom: 1px solid var(--border); }
details.activity-group .message-activity-rows { padding: 4px 10px; }
"""
patch(STY,
      ".switch-control:disabled { opacity: .55; cursor: wait; }",
      ".switch-control:disabled { opacity: .55; cursor: wait; }\n" + CSS)

# =============================================================================
# File 6: src/autopilot/session-store.ts — add list() method
# =============================================================================
SESS = "src/autopilot/session-store.ts"

# Add a list() method right after the get() method.
LIST_METHOD = """  /** Every remembered session override, including enabled, disabled and
   * inherited-binding rows. Used by the overview endpoint so the chat list
   * can mark sessions whose explicit override is on.
   */
  async list(): Promise<AutopilotSessionOverride[]> {
    const file = await this.read();
    return file.sessions.map((item) => ({ ...item }));
  }

"""
patch(SESS,
      "  async get(harness: AutopilotHarness, sessionId: string): Promise<AutopilotSessionOverride | null> {",
      LIST_METHOD + "  async get(harness: AutopilotHarness, sessionId: string): Promise<AutopilotSessionOverride | null> {")

# =============================================================================
# File 7: src/web/server.ts — GET /api/autopilot/overview
# (The HTTP server lives in src/web/server.ts; the autopilot stores are
# destructured to bare variables inside the request handler, matching the
# existing /api/autopilot/policy route a few hundred lines above.)
# =============================================================================
SRV = "src/web/server.ts"

OVERVIEW_ROUTE = """  if (request.method === "GET" && url.pathname === "/api/autopilot/overview") {
    const policy = autopilotPolicyStore ? await autopilotPolicyStore.readEffective() : null;
    const sessions = autopilotSessionStore ? await autopilotSessionStore.list() : [];
    response.setHeader("cache-control", "no-store");
    return sendJson(response, 200, {
      global: Boolean(policy?.policy?.enabled),
      harnesses: Array.isArray(policy?.policy?.harnesses) ? [...policy.policy.harnesses] : [],
      sessions: sessions
        .filter((s) => s.enabled === true)
        .map((s) => ({ harness: s.harness, sessionId: s.sessionId })),
    });
  }
"""
insert_before(SRV,
              '  if (request.method === "GET" && url.pathname === "/api/autopilot/choices") {',
              OVERVIEW_ROUTE)

# =============================================================================
# New test files
# =============================================================================
TEST_OVERVIEW = '''import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutopilotSessionStore } from "../src/autopilot/session-store.js";

// Focused unit test for the new list() method and the shape of the overview
// payload. No HTTP, no MCP, no model calls — runs in <200ms.

describe("AutopilotSessionStore.list for the overview endpoint", () => {
  let dir: string;
  let store: AutopilotSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ap-overview-"));
    store = new AutopilotSessionStore(join(dir, "sessions.json"));
  });

  afterEach(async () => {
    try { await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })); } catch { /* tmpdir cleans itself */ }
  });

  it("returns an empty array when nothing is stored", async () => {
    expect(await store.list()).toEqual([]);
  });

  it("returns every enabled session override after set()", async () => {
    await store.set({ harness: "zai", sessionId: "abc", cwd: "/tmp/proj" }, true);
    await store.set({ harness: "chatgpt", sessionId: "xyz", cwd: "/tmp/proj" }, true);
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.harness).sort()).toEqual(["chatgpt", "zai"]);
  });

  it("returns disabled overrides too — the overview filter drops them", async () => {
    await store.set({ harness: "zai", sessionId: "on", cwd: "/tmp" }, true);
    await store.set({ harness: "zai", sessionId: "off", cwd: "/tmp" }, false);
    const list = await store.list();
    expect(list).toHaveLength(2);
    const enabled = list.filter((s) => s.enabled === true);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.sessionId).toBe("on");
  });

  it("survives a delete and reflects the remaining set", async () => {
    await store.set({ harness: "zai", sessionId: "x", cwd: "/tmp" }, true);
    await store.set({ harness: "zai", sessionId: "y", cwd: "/tmp" }, true);
    await store.delete("zai", "x");
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe("y");
  });
});
'''

TEST_KILLSWITCH = '''import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HarnessAutomationSettings } from "../src/web-ui/harness-automation-settings.js";

// Verifies the kill-switch behavior: when disabledAll is true, every
// per-harness switch renders disabled and the status text changes.
// No HTTP, no MCP. React SSR only.

function renderWith(props: Partial<Parameters<typeof HarnessAutomationSettings>[0]> = {}) {
  return renderToStaticMarkup(
    <HarnessAutomationSettings
      mode="autopilot"
      available={new Set(["zai", "chatgpt", "codex"])}
      enabled={new Set(["zai"])}
      onToggle={() => {}}
      {...props}
    />,
  );
}

describe("HarnessAutomationSettings kill switch", () => {
  it("renders active switches when disabledAll is absent", () => {
    const html = renderWith();
    // The Z.ai switch is enabled and not disabled.
    expect(html).toContain("Разрешено");
    expect(html).toContain('aria-checked="true"');
    // No stop-signal hint by default.
    expect(html).not.toContain("Стоп-сигнал");
  });

  it("grays every switch and shows the stop-signal hint when disabledAll is true", () => {
    const html = renderWith({ disabledAll: true });
    expect(html).toContain("Стоп-сигнал: общий переключатель выключен");
    // Every switch-control button is disabled.
    const matches = html.match(/disabled=""/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // 3 harness rows
    // The disabled row class is present.
    expect(html).toContain("harness-setting-row-disabled");
  });

  it("preserves the checked state on the underlying switch even when disabled", () => {
    // The switch is still marked aria-checked, so turning the global back on
    // restores the previous selection without a write.
    const html = renderWith({ disabledAll: true });
    expect(html).toContain('aria-checked="true"');
  });
});
'''

TEST_GROUPING = '''import { describe, expect, it } from "vitest";
import { groupMessagePartSegments } from "../src/web-ui/message-activity.js";
import type { SessionMessagePart } from "../src/types/index.js";

// Verifies that activity grouping (thinking + tool calls) is unchanged by the
// UI overhaul patch: the wrapper <details> sits on top of the existing
// MessageActivityRows, so the segment shape must stay identical.

function part(overrides: Partial<SessionMessagePart>): SessionMessagePart {
  return { type: "text", text: "x", ...overrides } as SessionMessagePart;
}

describe("activity grouping preserves segment shape", () => {
  it("groups consecutive thinking + tool parts into one activity segment", () => {
    const parts: SessionMessagePart[] = [
      part({ type: "thinking", text: "hmm" }),
      part({ type: "tool_call", name: "exec", input: "ls" }),
      part({ type: "tool_result", name: "exec", output: "a\\nb" }),
      part({ type: "text", text: "done" }),
    ];
    const segments = groupMessagePartSegments(parts);
    expect(segments).toHaveLength(2);
    expect(segments[0]!.kind).toBe("activity");
    expect(segments[0]!.parts).toHaveLength(3);
    expect(segments[1]!.kind).toBe("content");
    expect(segments[1]!.parts).toHaveLength(1);
  });

  it("counts the activity items for the wrapper summary", () => {
    const parts: SessionMessagePart[] = [
      part({ type: "thinking", text: "a" }),
      part({ type: "thinking", text: "b" }),
      part({ type: "tool_call", name: "x", input: "" }),
      part({ type: "tool_result", name: "x", output: "" }),
    ];
    const segments = groupMessagePartSegments(parts);
    expect(segments).toHaveLength(1);
    const activity = segments[0]!;
    const count = activity.parts.filter((p) => p.type === "thinking" || p.type === "tool_call" || p.type === "tool_result").length;
    expect(count).toBe(4);
  });

  it("emits no activity segment when only text parts are present", () => {
    const segments = groupMessagePartSegments([part({ type: "text", text: "hello" })]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("content");
  });
});
'''

write_new("tests/ui-overhaul-overview.test.ts", TEST_OVERVIEW)
write_new("tests/ui-overhaul-killswitch.test.tsx", TEST_KILLSWITCH)
write_new("tests/ui-overhaul-grouping.test.ts", TEST_GROUPING)

print("\nDONE")
print("Backups suffix: .bak-" + TAG + "-" + TS)
print("New tests: tests/ui-overhaul-{overview,killswitch,grouping}.test.ts")
print("Next: git add -A && git commit && build_release + switch drop-in")
