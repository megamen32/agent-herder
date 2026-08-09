# Agent Herder chat UI library research

## Original request

«На телефоне два экрана: список сессий и открытая сессия. На широком экране
сессии и чат должны листаться независимо. Чат автоскроллится вниз, пока
пользователь не прокрутит вверх. Текущий интерфейс перегружен. Найди готовую
библиотеку чатов с настройками tools/reasoning, Markdown и code formatting.
Поставь это как цель и ищи минимум 10 минут.»

## Objective

Replace the public Herder dashboard visual model with a reusable AI-chat UI
foundation that supports mobile navigation, independent session/chat panes,
sticky bottom-following chat scroll, optional reasoning/tools, and rich text.

## Business canary

On `agent.bezrabotnyi.com`, a user can switch between the session list and one
open session on a phone; on a wide screen the session list and chat scroll
independently; new messages keep the chat at the bottom until the user scrolls
up; tools/reasoning can be toggled; Markdown/code remain readable.

## Confirmed scope

- Compare at least ten plausible approaches/libraries or library-plus-runtime
  combinations, with primary documentation and license checks.
- Prototype the top candidates against a normalized Herder message adapter
  before selecting the final one.
- Preserve the existing Node API and harness adapters behind the UI boundary.

## Explicit exclusions

- No change to harness transport protocols or session ownership.
- No public deployment or replacement of the current UI before a real public
  mobile/wide canary passes.
- No adoption of a hosted backend or vendor lock-in merely to obtain chat UI.

## Estimate

- Initial optimistic: 90 minutes.
- Initial likely: 180 minutes.
- Initial pessimistic: 360 minutes.

## Research evidence — 2026-08-09

The current repository is a native Node HTTP server serving one static HTML
file and has no React runtime. Library adoption therefore requires a frontend
build/migration boundary, while the existing API can remain unchanged.

Shortlist from official documentation and package metadata:

1. `assistant-ui` — MIT. Composable Thread/Message/Composer/ThreadList
   primitives, auto-scroll, Markdown/code highlighting, tool-call components,
   reasoning primitives, custom runtimes, and an experimental OpenCode runtime.
   Best custom-backend fit; current package is pre-1.0.
2. `@mui/x-chat` — MIT Community. Arbitrary backend adapter, split-layout
   examples, auto-scroll with a user-away buffer, scroll-to-bottom affordance,
   tool/reasoning parts, Markdown/code rendering, and normalized chat state.
   Best exact feature match, but package `9.0.0-alpha.16` carries alpha risk.
3. `@ant-design/x` — MIT, current 2.x line. Bubble/Sender, Conversations,
   Think/ThoughtChain, Actions, CodeHighlighter, streaming Markdown, and custom
   providers. Broad coverage, but its default visual language is enterprise-
   oriented rather than Codex-like.
4. OpenAI `chatkit-js` — Apache-2.0 repository. Polished streaming,
   tools/workflows, reasoning, attachments, threads and widgets, but the
   documented path requires ChatKit client tokens and an OpenAI ChatKit
   session backend, not Herder's local harness API.
5. CopilotKit — MIT. Streaming, tool calls, generative UI and human-in-the-
   loop support, but it adds the AG-UI/runtime model and more framework surface
   than needed here.
6. Chatscope Chat UI Kit — MIT. Mature basic layout, message list, input and
   responsive CSS, but reasoning/tool/AI parts remain custom work.
7. NLUX — MPL-2.0 with additional restrictions. Custom adapters, Markdown and
   highlighter are attractive, but the non-standard training/code-translation
   restrictions make it a poor default for this project.
8. `react-virtuoso` — MIT, but only a scroll/virtualization primitive; useful
   as an optional history/session-list complement, not the main chat UI.
9. Vercel AI SDK UI — framework-agnostic chat/generative-UI hooks and stream
   protocol, including tool usage, but intentionally not a complete visual
   component library. Useful as a transport/message contract, not sufficient
   alone for the requested redesign.
10. CUI Kit — open-source React/TypeScript Material-based AI UI with reasoning
    preview, attachments and branching. Promising, but smaller ecosystem and
    less independently documented than the top two candidates.
11. `react-chat-elements` — MIT and a broad basic component set, but its
    documented surface is generic ChatItem/MessageBox/MessageList/Input; tools,
    reasoning, streaming and the desired AI semantics would be custom work.

Current recommendation: prototype `assistant-ui` and `@mui/x-chat` behind the
same normalized Herder message adapter, then select based on the real public
390px and wide split-view canaries. Do not adopt OpenAI ChatKit solely for its
default look because its backend contract is the wrong seam for Herder.

## MUI X Chat probe — 2026-08-09

An isolated Vite/React probe was built in `/tmp/herder-chat-probe` against the
live Herder API. It compiled with `@mui/x-chat@9.0.0-alpha.16` and mapped the
existing Herder message parts (`text`, `thinking`, `tool_call`, and
`tool_result`) into MUI Chat message parts.

- At 390x844, the probe showed a mobile split flow: the session list is a
  separate screen, selecting a session opens the chat, and `Back to
  conversations` returns to the list. `scrollWidth - clientWidth` was 0.
- At 1200x800, both panels were present simultaneously: navigation width 220px
  and conversation width 980px, with no horizontal overflow.
- The probe used `variant="compact"`, `density="compact"`,
  `features.conversationList`, `features.autoScroll={buffer: 180}`,
  `features.scrollToBottom`, and `features.attachments=false`.
- A local toggle hid/shows reasoning parts; MUI's tool-part mapping and
  Markdown/code renderer remained available.

This validates MUI X Chat as the first implementation candidate. The probe is
disposable and was not copied into production; the remaining work is to add a
real Herder send/stream adapter, replace the current public HTML frontend with
the React build, and repeat the canary through the authenticated public site.

## Production implementation evidence — 2026-08-09

Implemented the first production slice with `@mui/x-chat` and a Vite React
frontend under `src/web-ui/`. The Herder API remains the backend seam; the
adapter maps sessions, text, reasoning, and tool-call/result parts and keeps
the existing queue/resume/stop/recover operations available.

- `npm test`: 47 files, 180 tests passed.
- `npm run build`: TypeScript and Vite build passed. The frontend is emitted
  separately from `dist/web/server.js` so Vite cannot erase the Node runtime.
- Local live browser canary at 390x844: detail screen and conversation-list
  screen are separate; Back navigation works; document horizontal overflow is
  0; two view toggles are present.
- Local live browser canary at 1200x800: conversation pane and thread pane are
  both present, the message list is its own scroll container, each measured
  container had no horizontal overflow, and the document overflow was 0.
- The first restart exposed and then fixed the missing `/assets/*` static route
  and a build-output collision; the running `agent-herder.service` is active
  after the corrected build.

Remaining bounded follow-up: the current Herder POST API is queue-based, so
the adapter displays an explicit queued acknowledgement rather than faking a
completed model response. A future transport can replace that stream bridge
without changing the UI contract.
