"""Read-only checks for the reviewed plan, not tests of Agent Herder runtime."""
from pathlib import Path
import json,hashlib,re,collections
P=Path(__file__).resolve().parents[1]
archive=P/'history/revision-4-before-astra'
manifest=json.loads((archive/'SHA256.json').read_text())
for name,digest in manifest.items():
 assert hashlib.sha256((archive/name).read_bytes()).hexdigest()==digest,name
rows=json.loads((P/'review-evidence/v1-input.json').read_text())
by={r['id']:r for r in rows};assert len(by)==len(rows)==159
g=json.loads((P/'plan.graph.json').read_text());gt={t['id']:t for t in g['tasks']}
active={t['id'] for t in g['tasks'] if t.get('status') not in ['done','deferred']}
assert active==set(by),(active-set(by),set(by)-active)
assert len(g['tasks'])==159
assert not json.loads((P/'plan.json').read_text()).get('revisions')
assert all(i.startswith('V') for i in active)
work=(P/'WORKPLAN.md').read_text()
for r in rows:
 live=json.loads((P/'leaves'/f"{r['id']}.json").read_text())
 for k in ['label','description','acceptance','affected_files','depends_on','estimate_minutes']:
  assert r[k]==live[k],(r['id'],k)
 assert live['status']=='queued' and live['owner']=='unassigned'
 assert 0<r['estimate_minutes']['minimum']<=r['estimate_minutes']['maximum']<=60
 assert set(r['depends_on'])<=set(by)
 assert f"### {r['id']}. {r['label']}" in work
 assert r['description'] in work and r['acceptance'] in work
 assert gt[r['id']]['status']=='queued'
# Explicit topological check, not input-order assumption.
visited=set()
while len(visited)<len(by):
 ready={i for i,r in by.items() if i not in visited and set(r['depends_on'])<=visited}
 assert ready,'dependency cycle'
 visited|=ready
for f in (P/'review-evidence').glob('schedule-*.json'):
 s=json.loads(f.read_text());assert {v['id'] for v in s}==set(by)
 lookup={v['id']:v for v in s};n=int(f.name.split('-')[1]);bound=f.stem.split('-')[-1]
 events=[]
 for v in s:
  r=by[v['id']];assert v['end']-v['start']==r['estimate_minutes'][bound]
  assert all(lookup[d]['end']<=v['start'] for d in r['depends_on'])
  events.extend([(v['start'],1,v['lane']),(v['end'],-1,v['lane'])])
 lanes=collections.Counter();count=0
 for time,delta,lane in sorted(events):
  count+=delta;lanes[lane]+=delta
  assert 0<=count<=n and 0<=lanes[lane]<=1,(f,time,lane,count)
for name in ['SPEC.md','ASTRA-REVIEW.md','MCP-EVIDENCE.md','RUST-DESIGN.md','COORDINATION.md','RECOVERY-STORAGE.md','WORKPLAN.md','ESTIMATES.md','ACCEPTANCE.md']:
 for link in re.findall(r'\]\(([^)]+)\)',(P/name).read_text()):
  if '://' not in link:assert (P/link.split('#')[0]).exists(),(name,link)
assert not list((P/'leaves').glob('R*.json'))
assert not list((P/'leaves').glob('A*.json'))
assert sum('estimate_unknown_reason' in r for r in rows)==5
a=P/'history/astra-review-before-v1-zero'
for name,digest in json.loads((a/'SHA256.json').read_text()).items():
 assert hashlib.sha256((a/name).read_bytes()).hexdigest()==digest,name
print(json.dumps({'archive_files_verified':len(manifest),'active_queued_leaves':len(by),'maximum_minutes':60,'graph_total':len(g['tasks']),'historical_or_deferred':0,'schedules_verified':6,'scope':'planning artifacts only; no runtime acceptance'},ensure_ascii=False,indent=2))
