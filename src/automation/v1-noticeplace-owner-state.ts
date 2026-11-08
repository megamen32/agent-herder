/** Read-only projection of the existing fleet owner STOP/disarm state. */
export type NoticePlaceOwnerStateRead = {
  ok: true;
  state: { disarmed: false; records: Array<{ scope: string; forbidden: boolean }> };
  nodes: Array<{ hostId: string; status: string }>;
};

export interface NoticePlaceOwnerStateProvider {
  /** Read authoritative 100/44/88 stores through the parent's protected transport. Never reset or cache STOP. */
  read(): Promise<unknown>;
}

/** Production provider using Herder's existing durable store and protected fleet read transport. */
export function createExistingNoticePlaceOwnerStateProvider(): NoticePlaceOwnerStateProvider {
  return { async read(): Promise<unknown> {
    const localPath = '/home/roomhacker/.local/state/agent-herder/autopilot-live/automation-disarm.json';
    const remotePath = '/home/roomhacker/.local/state/agent-herder/fleet-node/autopilot/automation-disarm.json';
    const readNode = async (node: '100'|'44'|'88'): Promise<{hostId:string;status:string;state?:unknown}> => {
      try {
        const raw = node === '100'
          ? await readFile(localPath,'utf8')
          : (await execFileAsync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=4','-o','ConnectionAttempts=1',`roomhacker@192.168.2.${node==='44'?'5':'75'}`,'cat',remotePath], {timeout:7000,maxBuffer:65536})).stdout;
        const state = parseDisarmDocument(JSON.parse(raw));
        return {hostId:`server-${node}`,status:noticePlaceOwnerNodeStatus(state),state};
      } catch { return {hostId:`server-${node}`,status:'unreachable'}; }
    };
    // No cache: every NoticePlace preflight re-reads all three authoritative stores.
    const nodes = await Promise.all((['100','44','88'] as const).map(readNode));
    const local = nodes[0].state;
    return composeNoticePlaceOwnerRead(local,nodes.map(({hostId,status})=>({hostId,status})));
  } };
}

const REQUIRED = ['server-100', 'server-44', 'server-88'] as const;
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function hostKey(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
  return REQUIRED.find(host => normalized === host || normalized.endsWith(`-${host}`)) ?? '';
}

/** Validate the installed NoticePlace helper's exact fail-closed predicate. */
export function validateNoticePlaceOwnerState(value: unknown): NoticePlaceOwnerStateRead | undefined {
  const root = record(value), state = record(root?.state);
  if (root?.ok !== true || !state || state.disarmed !== false || !Array.isArray(state.records) || !Array.isArray(root.nodes)) return;
  const globals = state.records.map(record).filter((item): item is Record<string, unknown> => Boolean(item && item.scope === '*'));
  if (globals.length !== 1 || typeof globals[0].forbidden !== 'boolean' || globals[0].forbidden !== false) return;
  const byHost = new Map<string, Record<string, unknown>[]>();
  for (const item of root.nodes.map(record)) {
    if (!item) continue;
    const key = hostKey(item.hostId);
    if (key) byHost.set(key, [...(byHost.get(key) ?? []), item]);
  }
  for (const host of REQUIRED) {
    const reports = byHost.get(host) ?? [];
    if (reports.length !== 1 || reports[0].status !== 'confirmed') return;
  }
  return value as NoticePlaceOwnerStateRead;
}
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDisarmDocument } from '../automation-disarm/state.js';

const execFileAsync = promisify(execFile);

export function noticePlaceOwnerNodeStatus(state: {disarmed?:unknown;records?:Array<{scope?:string;forbidden?:unknown}>}): 'confirmed'|'stopped' {
  const globals = Array.isArray(state.records) ? state.records.filter(item => item.scope === '*') : [];
  return state.disarmed === false && globals.length === 1 && globals[0]?.forbidden === false ? 'confirmed' : 'stopped';
}

export function composeNoticePlaceOwnerRead(local: unknown, nodes: Array<{hostId:string;status:string}>): unknown {
  const state=local&&typeof local==='object'&&!Array.isArray(local)?local as Record<string,unknown>:undefined;
  if(!state||nodes.length!==3||nodes.some(node=>node.status!=='confirmed'))return {ok:false,nodes};
  return {ok:true,state:{disarmed:state.disarmed,records:state.records},nodes};
}
