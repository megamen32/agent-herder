import type { SessionDetails } from "./types/index.js";

function jsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Render canonical Agent Herder session details as a self-contained graph page. */
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
  <title>Agent Herder session graph · ${escapeHtml(details.session.title || details.session.id)}</title>
  <style>
    :root{color-scheme:dark;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:#071018;color:#dce8ef;--line:#294151;--muted:#8da4b2;--accent:#4fd1c5;--user:#f3a261;--assistant:#63b3ed;--tool:#b794f4}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#102330,#071018 55%)}
    header{padding:24px clamp(18px,4vw,56px) 18px;border-bottom:1px solid var(--line);background:#09151f}
    h1{margin:0 0 8px;font:700 24px/1.15 system-ui,sans-serif;color:#f4fbff}.subtitle{color:var(--muted);overflow-wrap:anywhere}.summary{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}.pill,.child{padding:5px 9px;border:1px solid var(--line);border-radius:999px;color:#c7d9e3;background:#0c1c28}.pill.accent{border-color:#267f78;color:#8ff5e9}
    main{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);min-height:calc(100vh - 150px)}.timeline{padding:22px clamp(18px,4vw,56px)}.rail{position:relative;max-width:900px;margin:0 auto;padding-left:30px}.rail:before{content:"";position:absolute;left:9px;top:0;bottom:0;width:2px;background:var(--line)}
    article{position:relative;margin:0 0 18px;padding:13px 15px;border:1px solid var(--line);border-radius:9px;background:#0b1924;box-shadow:0 8px 22px #0004}article:before{content:"";position:absolute;left:-28px;top:19px;width:12px;height:12px;border:3px solid #071018;border-radius:50%;background:var(--assistant)}article.user:before{background:var(--user)}article.tool:before{background:var(--tool)}
    .meta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:7px;color:var(--muted);font-size:11px}.role{font-weight:700;color:var(--assistant)}article.user .role{color:var(--user)}article.tool .role{color:var(--tool)}.body{white-space:pre-wrap;overflow-wrap:anywhere;color:#e9f2f6}.part{margin-top:9px;padding:9px;border-left:2px solid var(--tool);background:#08131c;color:#b8cbd5;white-space:pre-wrap;overflow:auto;max-height:260px}
    aside{padding:22px 18px;border-left:1px solid var(--line);background:#0a151e}aside h2{margin:0 0 14px;font:600 15px system-ui,sans-serif;color:#f4fbff}dl{margin:0}dt{margin-top:12px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}dd{margin:3px 0 0;overflow-wrap:anywhere;color:#e5f1f6}.children{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.notice{margin-top:20px;padding:10px;border:1px solid var(--line);border-radius:7px;color:var(--muted);font-size:11px}.empty{padding:30px 0;color:var(--muted)}
    @media(max-width:760px){main{display:block}aside{border:0;border-top:1px solid var(--line)}.rail{padding-left:24px}.rail:before{left:7px}article:before{left:-24px}}
  </style>
</head>
<body>
  <header>
    <h1>Agent Herder session graph</h1>
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
    const messages = DATA.messages || [];
    const label = (value) => value || "—";
    document.title = "Agent Herder session graph · " + (session.title || session.id);
    document.getElementById("subtitle").textContent = session.harness + " · " + session.id + " · " + DATA.evidence;
    document.getElementById("summary").innerHTML = [
      [session.status, "pill"], [messages.length + " messages", "pill accent"],
      [(DATA.children || []).length + " children", "pill"], ["history: " + DATA.history.source, "pill"],
    ].map(([text, className]) => '<span class="' + className + '">' + esc(text) + '</span>').join("");
    document.getElementById("inspector").innerHTML = '<dl>' +
      '<dt>Title</dt><dd>' + esc(label(session.title)) + '</dd>' +
      '<dt>Harness</dt><dd>' + esc(session.harness) + '</dd>' +
      '<dt>Status</dt><dd>' + esc(session.status) + '</dd>' +
      '<dt>Working directory</dt><dd>' + esc(session.cwd) + '</dd>' +
      '<dt>Lineage</dt><dd>' + esc(DATA.lineage.kind) + (DATA.lineage.parentId ? '<br>parent: ' + esc(DATA.lineage.parentId) : '') + '</dd>' +
      '<dt>Children</dt><dd><div class="children">' + ((DATA.children || []).map((child) => '<span class="child">' + esc(child.title || child.id) + '</span>').join("") || '<span>—</span>') + '</div></dd>' +
      '<dt>History</dt><dd>' + esc(DATA.history.source) + (DATA.history.warning ? '<br>' + esc(DATA.history.warning) : '') + '</dd>' +
      '</dl><div class="notice">Canonical Agent Herder SessionDetails; no harness-specific transcript format is used by this page.</div>';
    const timeline = document.getElementById("timeline");
    if (!messages.length) { timeline.innerHTML = '<div class="empty">No canonical messages are available for this session.</div>'; }
    else timeline.innerHTML = messages.map((message, index) => {
      const role = message.role === "user" ? "user" : message.role === "tool" ? "tool" : "assistant";
      const parts = (message.parts || []).map((part) => '<div class="part"><strong>' + esc(part.name || part.type) + '</strong>\n' + esc(part.text || part.output || (part.input === undefined ? "" : JSON.stringify(part.input, null, 2))) + '</div>').join("");
      return '<article class="' + role + '"><div class="meta"><span class="role">' + esc(message.role) + '</span><span>#' + (index + 1) + '</span><span>' + esc(message.timestamp || "") + '</span></div><div class="body">' + esc(message.text || "") + '</div>' + parts + '</article>';
    }).join("");
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] || char));
}
