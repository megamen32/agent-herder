import {basename} from 'node:path';

/** Presentation only. The operation/name binding remains the launch identity. */
export function projectLaunchTitle(message: string, cwd: string): string {
  const lines = message.slice(-65536).split('\n');
  for (const line of [...lines].reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const facts = JSON.parse(line);
      if (typeof facts.id === 'string' && facts.id.startsWith('inc_') && typeof facts.title === 'string' && facts.title.trim()) {
        return `Инцидент: ${clean(facts.title)} | ${clean(typeof facts.project === 'string' ? facts.project : basename(cwd))}`;
      }
    } catch { /* Not a telemetry object. */ }
  }
  // Older NoticePlace envelopes used bounded text fields instead of JSON.
  const title = lines.find(line => /^- title: /u.test(line));
  if (title) return `Инцидент: ${clean(title.slice(9))} | ${clean(basename(cwd))}`;
  const task = message.split('\n').map(line => line.trim()).find(line => line && !/^<|^🤖|^#|^```/u.test(line));
  return `${clean(task || 'Работа по проекту')} | ${clean(basename(cwd))}`;
}

function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240);
}
