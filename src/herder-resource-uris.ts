export function sessionResourceUri(harness: string, sessionId: string): string {
  return `herder://sessions/${encodeURIComponent(harness)}/${encodeURIComponent(sessionId)}`;
}

export function sessionMessagesResourceUri(harness: string, sessionId: string): string {
  return `${sessionResourceUri(harness, sessionId)}/messages`;
}

export function coordinationNoteResourceUri(noteId: string): string {
  return `herder://coordination/notes/${encodeURIComponent(noteId)}`;
}

export function coordinationWorkspaceResourceUri(cwd: string): string {
  return `herder://coordination/workspaces/${encodeURIComponent(cwd)}`;
}

export function humanRequestResourceUri(requestId: string): string {
  return `herder://human-requests/${encodeURIComponent(requestId)}`;
}

export function jobResourceUri(jobId: string): string {
  return `herder://jobs/${encodeURIComponent(jobId)}`;
}

export function adapterResourceUri(harness: string): string {
  return `herder://adapters/${encodeURIComponent(harness)}`;
}

export function presenceSessionResourceUri(sessionId: string): string {
  return `herder://presence/${encodeURIComponent(sessionId)}`;
}

export function presenceWorkspaceResourceUri(cwd: string): string {
  return `herder://presence/workspaces/${encodeURIComponent(cwd)}`;
}
