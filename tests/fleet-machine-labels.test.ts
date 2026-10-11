import {describe,it,expect} from 'vitest';
import {machineName,machineStatus,machineReason} from '../src/web-ui/fleet/machine-labels.js';
import type {FleetHost} from '../src/mesh/fleet-contract.js';
const host=(patch:Partial<FleetHost>={}):FleetHost=>({hostId:'MacBook-Pro-User.local',label:'MacBook-Pro-User.local',state:'unavailable',fetchedAt:null,expiresAt:null,generation:null,createHarnesses:[],...patch});
// Fast unit expected <1s/max3s: agent outage must not claim the computer is off or expose raw diagnostic payloads.
describe('machine selection explanations',()=>{
 it('names known machines and retains the registered label for unknown machines',()=>{
  expect(machineName(host())).toBe('MacBook Pro · M1');
  expect(machineName(host({hostId:'other',label:'Рабочая станция'}))).toBe('Рабочая станция');
 });
 it('separates unavailable agent from live computer and expired proof',()=>{
  expect(machineReason(host({reason:'direct_peer_unavailable'}))).toContain('Сама машина может продолжать работать');
  expect(machineStatus(host({state:'stale'}))).toBe('Нужна проверка');
  expect(machineReason(host({reason:'metadata_expired'}))).toContain('устарела');
 });
 it('distinguishes SSH outage, missing listener and confirmed readiness',()=>{
  expect(machineReason(host({reason:'direct_ssh_refused'}))).toContain('Обратное SSH');
  expect(machineReason(host({reason:'direct_native_listener_unavailable'}))).toContain('SSH работает');
  expect(machineReason(host({state:'ready',reason:undefined}))).toContain('подтверждена');
 });
 it('never displays an unrecognized internal reason',()=>{
  expect(machineReason(host({reason:'private_path_or_provider_payload'}))).toBe('Доступность агента пока не подтверждена. Нажмите «Проверить связь».');
 });
});
