from pathlib import Path
import json,sys,hashlib,socket
fleet=Path(sys.argv[1]);base=(fleet/'current').resolve(strict=True);config=json.loads((fleet/'node-config.json').read_text());assert config['sourceSha']==base.name
patch=json.loads(Path(sys.argv[2]).read_text());files={}
for item in patch['replacements']:
 path=item['path'];data=files.get(path,(base/'dist'/path).read_text());assert data.count(item['before'])==1,('foreign_baseline_patch_anchor',path,item['before'][:60]);files[path]=data.replace(item['before'],item['after'],1)
print(json.dumps({'host':socket.gethostname(),'base':base.name,'hunks':len(patch['replacements']),'unchangedBaselineWebSHA256':hashlib.sha256((base/'dist/web/server.js').read_bytes()).hexdigest(),'nodeBin':config.get('nodeBin')}))
