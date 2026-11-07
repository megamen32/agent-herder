import json, os, subprocess, sys, threading, time
from pathlib import Path

root = Path(__file__).resolve().parent
probe = '/home/roomhacker/.codex/worktrees/herder-v1-implementation/agent-herder/crates/herder/target/debug/herder-wire-probe'
p = subprocess.Popen([probe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
lock = threading.Lock()
log = open(root / f'mcp-transcript-{os.getpid()}.jsonl', 'w', buffering=1)

def record(direction, data):
    with lock:
        log.write(json.dumps({'time':time.time(), 'direction':direction, 'raw':data.decode('utf-8', 'replace')}, ensure_ascii=False)+'\n')

def relay(source, target, direction):
    try:
        while True:
            data = os.read(source, 65536)
            if not data: break
            record(direction, data)
            os.write(target, data)
    except (BrokenPipeError, OSError): pass
    finally:
        if direction == 'client_to_probe':
            p.stdin.close()

t = threading.Thread(target=relay, args=(sys.stdin.fileno(),p.stdin.fileno(),'client_to_probe'),daemon=True)
t.start()
relay(p.stdout.fileno(),sys.stdout.fileno(),'probe_to_client')
p.wait(timeout=5)
record('probe_stderr',p.stderr.read())
