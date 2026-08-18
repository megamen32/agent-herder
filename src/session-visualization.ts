import type { SessionDetails } from "./types/index.js";

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Render canonical session data as a compact timeline/minimap, not a transcript. */
export function renderSessionGraph(details: SessionDetails): string {
  const data = jsonForHtml({
    schema: "agent-herder-session-graph/v1",
    evidence: "CANONICAL Agent Herder SessionDetails",
    session: details.session,
    lineage: details.lineage,
    children: details.children,
    history: details.history,
    messages: details.messages,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Herder session minimap · ${escapeHtml(details.session.title || details.session.id)}</title>
  <style>
    :root{color-scheme:dark;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#071018;color:#dce8ef;--line:#294151;--muted:#8da4b2;--accent:#4fd1c5;--user:#f3a261;--assistant:#63b3ed;--tool:#b794f4;--now:#f6c85f;--subagent:#b794f4}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#102330,#071018 55%)}
    header{padding:20px clamp(16px,3vw,42px) 14px;border-bottom:1px solid var(--line);background:#09151f}h1{margin:0 0 7px;font:700 21px/1.15 system-ui,sans-serif;color:#f4fbff}.subtitle{color:var(--muted);overflow-wrap:anywhere}.summary{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.pill{padding:4px 8px;border:1px solid var(--line);border-radius:999px;color:#c7d9e3;background:#0c1c28}.pill.accent{border-color:#267f78;color:#8ff5e9}
    main{display:grid;grid-template-columns:minmax(0,1fr) 270px;min-height:calc(100vh - 125px)}.map-shell{min-width:0;overflow:auto;padding:14px clamp(10px,2vw,28px) 28px}.map{display:block;width:100%;min-width:680px;height:auto;border:1px solid #1d3542;border-radius:8px;background:#08131c}.map text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.map-label{fill:#8da4b2;font-size:11px;letter-spacing:.08em}.session-node{fill:#4fd1c5;stroke:#071018;stroke-width:3}.subagent-node{fill:#b794f4;stroke:#071018;stroke-width:2}.subagent-link{stroke:#493d6c;stroke-width:1;opacity:.7}.event-line{stroke:#294151;stroke-width:2}.event-point{stroke:#071018;stroke-width:2}.event-point.user{fill:#f3a261}.event-point.assistant{fill:#63b3ed}.event-point.tool{fill:#b794f4}.event-point.system{fill:#8da4b2}.now-node{fill:#f6c85f;stroke:#071018;stroke-width:3}.duration-line{stroke:#547080;stroke-width:1;stroke-dasharray:3 3}.duration-text{fill:#8da4b2;font-size:10px}.subagent-anchor{text-decoration:none}.subagent-anchor:hover .subagent-node{fill:#fff}.legend{display:flex;gap:14px;flex-wrap:wrap;padding:10px 2px 0;color:#8da4b2;font-size:11px}.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}.legend .user{background:var(--user)}.legend .assistant{background:var(--assistant)}.legend .tool{background:var(--tool)}.legend .subagent{background:var(--subagent)}
    aside{padding:18px 16px;border-left:1px solid var(--line);background:#0a151e}aside h2{margin:0 0 12px;font:600 14px system-ui,sans-serif;color:#f4fbff}dl{margin:0}dt{margin-top:11px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}dd{margin:3px 0 0;overflow-wrap:anywhere;color:#e5f1f6}.notice{margin-top:18px;padding:9px;border:1px solid var(--line);border-radius:7px;color:var(--muted);font-size:10px}.main-link{display:inline-block;margin-top:14px;color:var(--accent);font-size:11px}
    @media(max-width:760px){main{display:block}aside{border:0;border-top:1px solid var(--line)}.map-shell{padding-left:8px;padding-right:8px}}
  </style>
</head>
<body>
  <header>
    <h1>Agent Herder session minimap</h1>
    <div class="subtitle" id="subtitle"></div>
    <div class="summary" id="summary"></div>
  </header>
  <main>
    <section class="map-shell"><svg class="map" id="map" role="img" aria-label="Compact session timeline and subagent graph"></svg><div class="legend"><span><i class="user"></i>user</span><span><i class="assistant"></i>assistant</span><span><i class="tool"></i>tool</span><span><i class="subagent"></i>subagent</span></div></section>
    <aside><h2>Canonical overview</h2><div id="inspector"></div></aside>
  </main>
  <script id="session-data" type="application/json">${data}</script>
  <script>
    const DATA = JSON.parse(document.getElementById("session-data").textContent);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => {
      if (char === "&") return "&amp;";
      if (char === "<") return "&lt;";
      if (char === ">") return "&gt;";
      if (char === '"') return "&quot;";
      return "&#39;";
    });
    const session = DATA.session;
    const children = DATA.children || [];
    const messages = [...(DATA.messages || [])].sort((left, right) => {
      const leftTime = Date.parse(left.timestamp || "");
      const rightTime = Date.parse(right.timestamp || "");
      if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
      return leftTime - rightTime;
    });
    const timeOf = (value) => { const parsed = Date.parse(value || ""); return Number.isFinite(parsed) ? parsed : null; };
    const formatTime = (value) => { const parsed = timeOf(value); return parsed === null ? "time unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(parsed); };
    const duration = (seconds) => seconds < 60 ? Math.round(seconds) + "s" : Math.floor(seconds / 60) + "m " + Math.round(seconds % 60) + "s";
    const roleOf = (message) => message.role === "user" ? "user" : message.role === "tool" ? "tool" : message.role === "system" ? "system" : "assistant";
    const knownTimes = messages.map((message) => timeOf(message.timestamp)).filter((value) => value !== null);
    const fromTime = knownTimes.length ? new Date(Math.min(...knownTimes)).toISOString() : session.lastActivity;
    const durationGaps = [];
    for (let index = 1; index < messages.length; index += 1) {
      const previous = timeOf(messages[index - 1].timestamp);
      const current = timeOf(messages[index].timestamp);
      if (previous !== null && current !== null && (current - previous) / 1000 > 30) durationGaps.push({ index, seconds: (current - previous) / 1000 });
    }
    document.title = "Agent Herder session minimap · " + (session.title || session.id);
    document.getElementById("subtitle").textContent = session.harness + " · " + session.id + " · " + DATA.evidence;
    document.getElementById("summary").innerHTML = [
      [session.status, "pill"], [messages.length + " points", "pill accent"], [children.length + " subagents", "pill"],
      [durationGaps.length + " gaps >30s", "pill"], ["history: " + DATA.history.source, "pill"],
    ].map(([text, className]) => '<span class="' + className + '">' + esc(text) + '</span>').join("");
    document.getElementById("inspector").innerHTML = '<dl>' +
      '<dt>Title</dt><dd>' + esc(session.title || "—") + '</dd>' +
      '<dt>Harness</dt><dd>' + esc(session.harness) + '</dd>' +
      '<dt>Status</dt><dd>' + esc(session.status) + '</dd>' +
      '<dt>FROM</dt><dd>' + esc(formatTime(fromTime)) + '</dd>' +
      '<dt>NOW</dt><dd>' + esc(formatTime(new Date().toISOString())) + '</dd>' +
      '<dt>Lineage</dt><dd>' + esc(DATA.lineage.kind) + (DATA.lineage.parentId ? '<br>parent: ' + esc(DATA.lineage.parentId) : '') + '</dd>' +
      '<dt>Subagents</dt><dd>' + children.length + '</dd>' +
      '</dl><div class="notice">Compact minimap only. Full message detail remains on the main Agent Herder page. Nodes and subagents expose details through hover/title and thread links.</div><a class="main-link" href="/">Back to Agent Herder</a>';
    const svg = document.getElementById("map");
    const ns = "http://www.w3.org/2000/svg";
    const childColumns = Math.min(7, Math.max(1, children.length));
    const childRows = Math.max(1, Math.ceil(children.length / childColumns));
    const graphTop = 34;
    const graphHeight = children.length ? 44 + childRows * 28 : 54;
    const timelineTop = graphTop + graphHeight + 20;
    const timelineHeight = messages.length > 200 ? 820 : Math.max(360, messages.length * 14);
    const width = 980;
    const height = timelineTop + timelineHeight + 58;
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    const text = (x, y, value, className) => '<text x="' + x + '" y="' + y + '" class="' + className + '">' + esc(value) + '</text>';
    let markup = text(18, 20, "SESSION / SUBAGENTS", "map-label");
    const rootX = 42;
    const rootY = graphTop + 12;
    markup += '<circle cx="' + rootX + '" cy="' + rootY + '" r="8" class="session-node"><title>' + esc(session.title || session.id) + '</title></circle>';
    markup += text(60, rootY + 4, session.harness + " · " + session.id, "map-label");
    children.forEach((child, index) => {
      const column = index % childColumns;
      const row = Math.floor(index / childColumns);
      const x = 230 + column * 105;
      const y = graphTop + 40 + row * 28;
      const title = child.title || child.id;
      const threadUrl = child.harness === "codex" ? "codex://threads/" + encodeURIComponent(child.id) : "#";
      markup += '<line x1="' + rootX + '" y1="' + rootY + '" x2="' + x + '" y2="' + y + '" class="subagent-link" />';
      markup += '<a class="subagent-anchor" href="' + esc(threadUrl) + '"' + (threadUrl === "#" ? "" : ' target="_blank" rel="noreferrer"') + '><circle cx="' + x + '" cy="' + y + '" r="5" class="subagent-node"><title>' + esc(title + " · " + child.id) + '</title></circle></a>';
    });
    const lineX = 42;
    markup += text(18, timelineTop - 9, "FROM", "map-label");
    markup += '<text x="78" y="' + (timelineTop - 9) + '" class="map-label">' + esc(formatTime(fromTime)) + '</text>';
    markup += '<line x1="' + lineX + '" y1="' + timelineTop + '" x2="' + lineX + '" y2="' + (timelineTop + timelineHeight) + '" class="event-line" />';
    const pointStep = messages.length > 1 ? timelineHeight / (messages.length - 1) : timelineHeight;
    const markerSet = new Set(durationGaps.map((gap) => gap.index));
    messages.forEach((message, index) => {
      const y = timelineTop + index * pointStep;
      const role = roleOf(message);
      const radius = messages.length > 500 ? 2 : 4;
      const title = (message.role + " · " + formatTime(message.timestamp) + (message.text ? " · " + message.text.slice(0, 180) : ""));
      markup += '<circle cx="' + lineX + '" cy="' + y + '" r="' + radius + '" class="event-point ' + role + '"><title>' + esc(title) + '</title></circle>';
      if (markerSet.has(index) && pointStep >= 16) {
        const gap = durationGaps.find((item) => item.index === index);
        const previousY = timelineTop + (index - 1) * pointStep;
        const midpoint = (previousY + y) / 2;
        markup += '<line x1="' + (lineX + 13) + '" y1="' + previousY + '" x2="' + (lineX + 13) + '" y2="' + y + '" class="duration-line" />';
        markup += text(68, midpoint + 4, duration(gap.seconds), "duration-text");
      }
    });
    markup += text(18, timelineTop + timelineHeight + 19, "NOW", "map-label");
    markup += '<circle cx="' + lineX + '" cy="' + (timelineTop + timelineHeight) + '" r="7" class="now-node"><title>' + esc(formatTime(new Date().toISOString())) + '</title></circle>';
    markup += '<text x="78" y="' + (timelineTop + timelineHeight + 19) + '" class="map-label">' + esc(formatTime(new Date().toISOString())) + '</text>';
    svg.innerHTML = markup;
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] || char));
}
