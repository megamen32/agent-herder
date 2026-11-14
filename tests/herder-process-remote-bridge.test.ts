import {describe,it,expect,vi} from 'vitest';
import {remoteProcessCall} from '../src/herder-process-remote-bridge.js';

const h='a'.repeat(64);
const input=()=>({version:1,transport:{node_binary:'/bin/node',node_sha256:h,bridge:'/app/bridge.js',bridge_sha256:h,
  fleet_mesh_config:'/private/mesh.json',credential_pin:h,target:'shell:executor'},worker:'/app/worker',
  endpoint_config:'/private/executor.json',endpoint_config_sha256:h,request:{version:1,request_id:h,
    controller_node_ref:'controller',executor_node_ref:'executor',executor_ref:'build-node',
    operation:{action:'status',handle:{nonce:h}}}});
const response=()=>({version:1,request_id:h,controller_node_ref:'controller',executor_node_ref:'executor',
  executor_ref:'build-node',observation:{handle:{nonce:h}}});
function fixture(raw:unknown={returncode:0,stdout:JSON.stringify(response())}){
  const call=vi.fn(async()=>raw);
  const binding=vi.fn(async()=>({endpoint:'https://fixture.gptadmin.bezrabotnyi.com',headers:{Authorization:'fixture-only'},generation:h}));
  return {call,binding,deps:{binding,transport:()=>({call})}};
}
describe('remote process transport uses the installed Fleet route',()=>{
  it('uses one exact structured worker invocation and returns the correlated receipt',async()=>{
    const f=fixture();expect(await remoteProcessCall(input(),f.deps)).toEqual(response());
    expect(f.call).toHaveBeenCalledTimes(1);
    const [target,tool,args]=f.call.mock.calls[0] as unknown as [string,string,{argv:string[]}];
    expect(target).toBe('shell:executor');expect(tool).toBe('shell_exec');
    expect(args.argv.slice(0,5)).toEqual(['/app/worker','--remote-config','/private/executor.json','--config-sha256',h]);
    expect(JSON.parse(args.argv[6]!)).toEqual(input().request);
    expect(f.binding).toHaveBeenCalledWith({configPath:'/private/mesh.json',pin:h});
    expect(JSON.stringify(args)).not.toContain('fixture-only');
  });
  it('fails before a call when the existing credential generation changed',async()=>{
    const f=fixture();f.binding.mockResolvedValueOnce({endpoint:'https://fixture.gptadmin.bezrabotnyi.com',headers:{},generation:'b'.repeat(64)});
    await expect(remoteProcessCall(input(),f.deps)).rejects.toThrow('remote_transport_unavailable');
    expect(f.call).not.toHaveBeenCalled();
  });
  it('does not retry start after an ambiguous transport failure',async()=>{
    const f=fixture();f.call.mockRejectedValueOnce(new Error('lost ACK with secret detail'));
    const v=input();v.request.operation.action='start';
    await expect(remoteProcessCall(v,f.deps)).rejects.toThrow('remote_transport_unavailable');
    expect(f.call).toHaveBeenCalledTimes(1);
  });
  it.each(['request_id','controller_node_ref','executor_node_ref','executor_ref'] as const)('rejects a changed %s',async field=>{
    const r=response();r[field]='different';const f=fixture({returncode:0,stdout:JSON.stringify(r)});
    await expect(remoteProcessCall(input(),f.deps)).rejects.toThrow('remote_response_identity_mismatch');
  });
  it('rejects an alias target and a path containing shell syntax before transport',async()=>{
    const f=fixture(),v=input();v.transport.target='ha3871e57767c';
    await expect(remoteProcessCall(v,f.deps)).rejects.toThrow('remote_request_invalid');
    v.transport.target='shell:executor';v.worker='/app/../other';
    await expect(remoteProcessCall(v,f.deps)).rejects.toThrow('remote_request_invalid');
    expect(f.call).not.toHaveBeenCalled();
  });
  it.each([{returncode:0,stdout:'{}',saved:true},{returncode:1,stdout:JSON.stringify(response())},
    {returncode:0,stdout:JSON.stringify(response())+'\nextra'}])('does not infer a receipt from partial or failed shell ACK',async raw=>{
    await expect(remoteProcessCall(input(),fixture(raw).deps)).rejects.toThrow();
  });
});
