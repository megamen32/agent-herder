from pathlib import Path
import json,heapq,collections
P=Path(__file__).resolve().parents[1]
rows=json.loads((P/'review-evidence/v1-input.json').read_text()); by={r['id']:r for r in rows}
def duration(r,b):return r['estimate_minutes'][b]
def cp(b):
 finish={}; paths={}
 for r in rows:
  deps=r['depends_on']; parent=max(deps,key=lambda d:finish[d]) if deps else None
  finish[r['id']]=duration(r,b)+(finish[parent] if parent else 0)
  paths[r['id']]=(paths[parent] if parent else [])+[r['id']]
 last=max(finish,key=finish.get)
 return finish[last],paths[last]
def schedule(n,b):
 children=collections.defaultdict(list)
 for r in rows:
  for d in r['depends_on']:children[d].append(r['id'])
 rank={}
 for r in reversed(rows):rank[r['id']]=duration(r,b)+max([rank[c] for c in children[r['id']]] or [0])
 pending=set(by); done=set(); running=[]; busy=set(); now=0; assignments=[]
 while pending or running:
  ready=sorted((i for i in pending if set(by[i]['depends_on'])<=done),key=lambda i:(-rank[i],i))
  for i in ready:
   lane=by[i]['lane']
   if len(running)>=n:break
   if lane in busy:continue
   pending.remove(i);busy.add(lane); end=now+duration(by[i],b);heapq.heappush(running,(end,i));assignments.append({'id':i,'start':now,'end':end,'lane':lane})
  if not running:raise ValueError('cycle')
  now=running[0][0]
  while running and running[0][0]==now:
   _,i=heapq.heappop(running);done.add(i);busy.remove(by[i]['lane'])
 return now,assignments
result={'leaves':len(rows),'effort_hours':{},'critical_path':{},'schedule_hours':{},'by_stage':{}}
for b in ['minimum','maximum']:
 result['effort_hours'][b]=sum(duration(r,b) for r in rows)/60
 t,path=cp(b);result['critical_path'][b]={'hours':t/60,'ids':path}
 for n in [1,2,4]:
  t,s=schedule(n,b);result['schedule_hours'].setdefault(str(n),{})[b]=t/60
  (P/f'review-evidence/schedule-{n}-{b}.json').write_text(json.dumps(s,indent=2)+'\n')
for stage in dict.fromkeys(r['stage'] for r in rows):
 rr=[r for r in rows if r['stage']==stage];result['by_stage'][stage]={'leaves':len(rr),**{b:sum(duration(r,b) for r in rr)/60 for b in ['minimum','maximum']}}
(P/'review-evidence/forecast.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
