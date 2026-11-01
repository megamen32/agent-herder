#!/usr/bin/env python3
import os, pathlib, re, subprocess, sys
if len(sys.argv)>1:
    entry=sys.argv[1]
else:
    output=subprocess.check_output(['systemctl','--user','show','agent-herder.service','-p','ExecStart','--value'],text=True)
    matches=re.findall(r'(/[^ ;]+/dist/index[.]js)',output)
    if not matches: raise SystemExit('Browser rate guard: cannot identify selected release')
    entry=matches[0]
adapters=pathlib.Path(entry).parent/'adapters'
cache=(adapters/'browser-chat-history-cache.js').read_text()
api=(adapters/'browser-chat-api-scripts.js').read_text()
checks={
 'metadata cache without TTL sweep': 'REFRESH_AFTER_MS' not in cache and 'configured === 0' in cache,
 'serialized request spacing': 'REQUEST_GAP_MS' in cache and 'requestTail' in cache,
 'shared read 429 cooldown': api.count('__herderChatGptReadCooldownUntil') >= 4,
}
failed=[name for name,ok in checks.items() if not ok]
if failed: raise SystemExit('Browser rate guard refused unsafe release: '+', '.join(failed))
print('Browser rate guard PASS')
