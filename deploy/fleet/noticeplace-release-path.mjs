import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Derive modules only from an immutable SHA release bundle. */
export function immutableNoticePlaceReleaseRoot(entryUrl) {
  const path=fileURLToPath(entryUrl);
  const match=path.match(/^(.*\/releases\/[a-f0-9]{40})\/deploy\/fleet\/launch-v1-noticeplace\.mjs$/u);
  if(!match)throw new Error('noticeplace_launcher_must_run_from_immutable_release');
  return resolve(match[1]);
}
