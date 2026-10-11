"""Original task HTTP handler + native prologue/terminal seam; no live gateway/Telegram."""
import asyncio
import importlib.util
import json
import os
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

root=Path(sys.argv[1])
sys.path.insert(0,str(Path.home()/'.hermes/hermes-agent'))
source=Path('/home/roomhacker/agents-projects/agent-resume/hermes_gateway.py')
spec=importlib.util.spec_from_file_location('task_peer',source)
mod=importlib.util.module_from_spec(spec);sys.modules[spec.name]=mod;spec.loader.exec_module(mod)
key='agent:main:telegram:group:-1004360838692:9';sid='20260909_220106_70ff6a6b'
origin=SimpleNamespace(to_dict=lambda:{'platform':'telegram','chat_id':'-1004360838692','thread_id':'9','chat_type':'group'})
entry=SimpleNamespace(session_id=sid,origin=origin,active_turn_token=None,model_override={'model':'glm-5.3-flash'})
async def lookup(target):return entry if target==key else None
gateway=SimpleNamespace(async_session_store=SimpleNamespace(lookup_by_session_key=lookup),_plugin_injection_accepting=lambda:True,_is_session_running=lambda key:False)
calls=[]
def inject(content,*,session_key):
    assert session_key==key
    mod._on_task_pre_llm_call(session_id=sid,turn_id=str(len(calls)+1),user_message=content,model='glm-5.3-flash')
    from tools.terminal_tool import get_session_cwd
    calls.append({'cwd':get_session_cwd(sid),'sessionKey':session_key,'nativeSessionId':sid})
    return True
mod._ctx=SimpleNamespace(_manager=SimpleNamespace(home_path=root,_cli_ref=None),inject_message=inject)
mod._task_settings=lambda:{'session_key':key,'model':'MiniMax-M3'}
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
os.environ.update(AGENT_RESUME_HERMES_TOKEN='fixture-token',AGENT_RESUME_HERMES_PORT=str(port))
async def main():
    bridge=await mod.start_bridge(gateway);assert bridge
    print(json.dumps({'url':f'http://127.0.0.1:{port}','key':key}),flush=True)
    try:
        while True:
            line=await asyncio.to_thread(sys.stdin.readline)
            if line.strip()=='proof':print(json.dumps({'calls':calls}),flush=True)
            else:break
    finally:await bridge.runner.cleanup()
asyncio.run(main())
