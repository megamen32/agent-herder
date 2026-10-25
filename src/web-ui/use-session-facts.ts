import * as React from "react";
import { readSessionInspectFacts, type SessionInspectFacts } from "./session-work-target.js";

/**
 * The facts of the open session, read only when somebody asks for them.
 *
 * The inspector on the right shows the work of the session. While it is closed
 * the panel does not read them: a screen that nobody looks at must not spend
 * a request on it.
 */
export function useSessionFacts(
  session: { id: string; harness: string } | undefined,
  enabled: boolean,
  refreshKey: number = 0,
): SessionInspectFacts | undefined {
  const [facts, setFacts] = React.useState<SessionInspectFacts>();
  React.useEffect(() => {
    if (!session || !enabled) return;
    let live = true;
    void readSessionInspectFacts(session).then((read) => {
      if (live && read) setFacts(read);
    });
    return () => { live = false; };
  }, [session?.id, session?.harness, enabled, refreshKey]);
  return facts;
}
