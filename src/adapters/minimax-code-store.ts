import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Store layout of the MiniMax Code local runtime.
 *
 * The adapter and the mesh observer read the very same store, so the layout is
 * declared once: `~/.minimax/v2/sessions/YYYY/MM/DD/<time>-session_<base64url>`.
 * Every session directory owns a `manifest.json` with the native identity and
 * the timestamps; the transcript stays in `messages.jsonl` and is never read
 * by the observer.
 */
export const MINIMAX_CODE_SESSION_STORE = join(homedir(), ".minimax", "v2", "sessions");

/**
 * MiniMax Code keeps one working directory for the whole runtime, so its
 * sessions are reported under this pseudo project.
 */
export const MINIMAX_CODE_HARNESS_CWD = join(homedir(), ".minimax");
