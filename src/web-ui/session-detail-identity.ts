export type DetailIdentity = { id: string; harness: string; hostId?: string };
export type DetailAttributes = {
  'data-details-verified'?: 'true';
  'data-native-session-id'?: string;
  'data-harness'?: string;
  'data-host-id'?: string;
};
const known = (value: unknown): value is string => typeof value === 'string'
  && value.trim() === value && value.length > 0 && !/[\x00-\x1f]/u.test(value);

/** A native ID alone does not identify a host when multiple instances are visible. */
export function resolveDetailHost(
  rows: readonly DetailIdentity[], harness: string, id: string, localHostId?: string,
): string | undefined {
  const matches = rows.filter(row => row.id === id && row.harness === harness);
  if (!matches.length) return known(localHostId) ? localHostId : undefined;
  if (matches.some(row => !known(row.hostId))) return undefined;
  const hosts = new Set(matches.map(row => row.hostId!));
  return hosts.size === 1 ? [...hosts][0] : undefined;
}

export function detailQuery(limit: number, quick: boolean, hostId?: string): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (quick) query.set('quick', '1');
  if (known(hostId)) query.set('runtimeHostId', hostId);
  return query.toString();
}

/** Expose only live response identity, after matching the requested native address. */
export function verifiedDetailAttributes(
  expected: DetailIdentity | undefined, response: DetailIdentity | undefined, fresh: boolean,
): DetailAttributes {
  if (!fresh || !expected || !response || !known(expected.hostId)
      || !known(response.id) || response.id.startsWith('session:')
      || !known(response.harness) || !known(response.hostId)
      || response.id !== expected.id || response.harness !== expected.harness
      || response.hostId !== expected.hostId) return {};
  return {
    'data-details-verified': 'true', 'data-native-session-id': response.id,
    'data-harness': response.harness, 'data-host-id': response.hostId,
  };
}
