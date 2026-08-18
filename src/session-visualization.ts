import type { SessionDetails } from "./types/index.js";

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Render canonical Agent Herder session details as a self-contained timeline page. */
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
  <title>Agent Herder session timeline · ${escapeHtml(details.session.title || details.session.id)}</title>
  <style>
    :root{color-scheme:dark;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#071018;color:#dce8ef;--line:#294151;--muted:#8da4b2;--accent:#4fd1c5;--user:#f3a261;--assistant:#63b3ed;--tool:#b794f4;--now:#f6c85f}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#102330,#071018 55%)}
    header{padding:24px clamp(18px,4vw,56px) 18px;border-bottom:1px solid var(--line);background:#09151f}
    h1{margin:0 0 8px;font:700 24px/1.15 system-ui,sans-serif;color:#f4fbff}.subtitle{color:var(--muted);overflow-wrap:anywhere}.summary{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.pill,.child-chip{padding:5px 9px;border:1px solid var(--line);border-radius:999px;color:#c7d9e3;background:#0c1c28}.pill.accent{border-color:#267f78;color:#8ff5e9}
    main{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);min-height:calc(100vh - 150px)}.timeline{padding:22px clamp(18px,4vw,56px)}.rail{position:relative;max-width:900px;margin:0 auto;padding:0 0 8px 42px}.rail:before{content:"";position:absolute;left:13px;top:18px;bottom:28px;width:2px;background:var(--line)}
    .timeline-boundary{position:relative;min-height:30px;padding:0 0 12px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.timeline-boundary:before{content:"";position:absolute;left:6px;top:3px;width:12px;height:12px;border:3px solid #071018;border-radius:50%;background:var(--accent)}.timeline-boundary time{display:block;margin-top:2px;color:#dce8ef;font-size:12px;text-transform:none;letter-spacing:0}
    .timeline-event{position:relative;margin:0 0 16px;padding:13px 15px;border:1px solid var(--line);border-radius:9px;background:#0b1924;box-shadow:0 8px 22px #0004}.timeline-event:before{content:"";position:absolute;left:-37px;top:19px;width:12px;height:12px;border:3px solid #071018;border-radius:50%;background:var(--assistant)}.timeline-event.user:before{background:var(--user)}.timeline-event.tool:before{background:var(--tool)}
    .meta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:7px;color:var(--muted);font-size:11px}.role{font-weight:700;color:var(--assistant)}.timeline-event.user .role{color:var(--user)}.timeline-event.tool .role{color:var(--tool)}.body{white-space:pre-wrap;overflow-wrap:anywhere;color:#e9f2f6}.part{margin-top:9px;padding:9px;border-left:2px solid var(--tool);background:#08131c;color:#b8cbd5;white-space:pre-wrap;overflow:auto;max-height:260px}
    .duration-marker{position:relative;display:flex;align-items:center;min-height:var(--duration-space);margin:0 0 8px;color:var(--muted);font-size:11px}.duration-marker:before{content:"";position:absolute;left:8px;top:0;bottom:0;border-left:1px dashed #547080}.duration-marker span{margin-left:24px;padding:3px 7px;border:1px solid #35505e;border-radius:5px;background:#0a1822}.now-boundary{position:relative;padding-top:8px;color:var(--now);font-weight:700;text-transform:uppercase;letter-spacing:.08em}.now-boundary:before{content:"";position:absolute;left:6px;top:10px;width:14px;height:14px;border:3px solid #071018;border-radius:50%;background:var(--now);box-shadow:0 0 0 3px #f6c85f33}.now-boundary time{display:block;margin-top:3px;color:#e7d99a;font-size:12px;font-weight:400;text-transform:none;letter-spacing:0}
    aside{padding:22px 18px;border-left:1px solid var(--line);background:#0a151e}aside h2{margin:0 0 14px;font:600 15px system-ui,sans-serif;color:#f4fbff}dl{margin:0}dt{margin-top:12px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}dd{margin:3px 0 0;overflow-wrap:anywhere;color:#e5f1f6}.children{display:grid;gap:7px;margin-top:8px}.child-card{display:block;padding:8px;border:1px solid var(--line);border-radius:7px;background:#0c1c28;color:#dce8ef;text-decoration:none}.child-card:hover{border-color:var(--accent);color:#fff}.child-card strong,.child-card small{display:block;overflow-wrap:anywhere}.child-card small{margin-top:3px;color:var(--muted);font-size:10px}.notice{margin-top:20px;padding:10px;border:1px solid var(--line);border-radius:7px;color:var(--muted);font-size:11px}.empty{padding:30px 0;color:var(--muted)}
    @media(max-width:760px){main{display:block}aside{border:0;border-top:1px solid var(--line)}.rail{padding-left:30px}.rail:before{left:7px}.timeline-boundary:before,.now-boundary:before{left:0}.timeline-event:before{left:-25px}.duration-marker:before{left:2px}.duration-marker span{margin-left:16px}.duration-marker{display:none}}
  </style>
</head>
<body>
  <header>
    <h1>Agent Herder session timeline</h1>
    <div class="subtitle" id="subtitle"></div>
    <div class="summary" id="summary"></div>
  </header>
  <main>
    <section class="timeline"><div class="rail" id="timeline"></div></section>
    <aside><h2>Canonical session</h2><div id="inspector"></div></aside>
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
    const messages = [...(DATA.messages || [])].sort((left, right) => {
      const leftTime = Date.parse(left.timestamp || "");
      const rightTime = Date.parse(right.timestamp || "");
      if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
      return leftTime - rightTime;
    });
    const timestamp = (value) => {
      const parsed = Date.parse(value || "");
      return Number.isFinite(parsed) ? parsed : null;
    };
    const formatTime = (value) => {
      const parsed = timestamp(value);
      return parsed === null ? "time unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(parsed);
    };
    const duration = (seconds) => seconds < 60 ? Math.round(seconds) + "s" : Math.floor(seconds / 60) + "m " + Math.round(seconds % 60) + "s";
    const label = (value) => value || "—";
    document.title = "Agent Herder session timeline · " + (session.title || session.id);
    document.getElementById("subtitle").textContent = session.harness + " · " + session.id + " · " + DATA.evidence;
    document.getElementById("summary").innerHTML = [
      [session.status, "pill"], [messages.length + " messages", "pill accent"],
      [(DATA.children || []).length + " subagents", "pill"], ["history: " + DATA.history.source, "pill"],
    ].map(([text, className]) => '<span class="' + className + '">' + esc(text) + '</span>').join("");
    const knownTimes = messages.map((message) => timestamp(message.timestamp)).filter((value) => value !== null);
    const fromTime = knownTimes.length ? new Date(Math.min(...knownTimes)).toISOString() : session.lastActivity;
    document.getElementById("timeline").innerHTML = '<div class="timeline-boundary"><span>FROM</span><time>' + esc(formatTime(fromTime)) + '</time></div>';
    document.getElementById("inspector").innerHTML = '<dl>' +
      '<dt>Title</dt><dd>' + esc(label(session.title)) + '</dd>' +
      '<dt>Harness</dt><dd>' + esc(session.harness) + '</dd>' +
      '<dt>Status</dt><dd>' + esc(session.status) + '</dd>' +
      '<dt>Working directory</dt><dd>' + esc(session.cwd) + '</dd>' +
      '<dt>Lineage</dt><dd>' + esc(DATA.lineage.kind) + (DATA.lineage.parentId ? '<br>parent: ' + esc(DATA.lineage.parentId) : '') + '</dd>' +
      '<dt>Subagents</dt><dd><div class="children" id="subagents"></div></dd>' +
      '<dt>History</dt><dd>' + esc(DATA.history.source) + (DATA.history.warning ? '<br>' + esc(DATA.history.warning) : '') + '</dd>' +
      '</dl><div class="notice">Canonical Agent Herder SessionDetails; the timeline uses closed message timestamps. Duration markers appear only for gaps over 30 seconds when the desktop layout has room.</div>';
    const subagents = document.getElementById("subagents");
    subagents.innerHTML = (DATA.children || []).map((child) => {
      const threadUrl = child.harness === "codex" ? "codex://threads/" + encodeURIComponent(child.id) : "";
      const title = esc(child.title || child.id);
      const meta = esc((child.meta && child.meta.agentRole) || child.status || child.harness);
      return '<a class="child-card" href="' + (threadUrl ? esc(threadUrl) : "#") + '"' + (threadUrl ? ' target="_blank" rel="noreferrer"' : "") + '><strong>' + title + '</strong><small>' + meta + ' · ' + esc(child.id) + '</small></a>';
    }).join("") || '<span>—</span>';
    const timeline = document.getElementById("timeline");
    let previousTime = null;
    if (!messages.length) timeline.insertAdjacentHTML("beforeend", '<div class="empty">No canonical messages are available for this session.</div>');
    else messages.forEach((message, index) => {
      const currentTime = timestamp(message.timestamp);
      if (previousTime !== null && currentTime !== null) {
        const gapSeconds = (currentTime - previousTime) / 1000;
        if (gapSeconds > 30) timeline.insertAdjacentHTML("beforeend", '<div class="duration-marker" style="--duration-space:' + Math.min(140, Math.max(42, Math.round(Math.sqrt(gapSeconds) * 7))) + 'px"><span>' + esc(duration(gapSeconds)) + '</span></div>');
      }
      const role = message.role === "user" ? "user" : message.role === "tool" ? "tool" : "assistant";
      const parts = (message.parts || []).map((part) => '<div class="part"><strong>' + esc(part.name || part.type) + '</strong>\\n' + esc(part.text || part.output || (part.input === undefined ? "" : JSON.stringify(part.input, null, 2))) + '</div>').join("");
      timeline.insertAdjacentHTML("beforeend", '<article class="timeline-event ' + role + '"><div class="meta"><span class="role">' + esc(message.role) + '</span><span>#' + (index + 1) + '</span><span>' + esc(formatTime(message.timestamp)) + '</span></div><div class="body">' + esc(message.text || "") + '</div>' + parts + '</article>');
      if (currentTime !== null) previousTime = currentTime;
    });
    timeline.insertAdjacentHTML("beforeend", '<div class="now-boundary"><span>NOW</span><time>' + esc(formatTime(new Date().toISOString())) + '</time></div>');
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] || char));
}
