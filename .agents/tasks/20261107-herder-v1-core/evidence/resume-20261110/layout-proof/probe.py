import json, os, pathlib, subprocess, sys, tarfile, tempfile, time, urllib.request
import websocket
BASE=pathlib.Path(__file__).parent
REPO='/home/roomhacker/agents-projects/.worktrees/userio-herder-shared-20261110'
CHROME='/home/roomhacker/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
def run(rev):
    ext=BASE/('extension-'+rev); ext.mkdir(parents=True,exist_ok=True)
    archive=subprocess.check_output(['git','-C',REPO,'archive',rev,'extensions/vk-inbox'])
    import io
    with tarfile.open(fileobj=io.BytesIO(archive)) as t: t.extractall(ext)
    src=ext/'extensions/vk-inbox'
    for p in src.iterdir():
        dest=ext/p.name
        if p.is_dir():
            import shutil
            shutil.copytree(p,dest,dirs_exist_ok=True)
        else: p.replace(dest)
    m=json.loads((ext/'manifest.json').read_text());m['background']={'service_worker':'fixture.js'};(ext/'manifest.json').write_text(json.dumps(m))
    (ext/'fixture.js').write_text('chrome.runtime.onMessage.addListener((m,s,r)=>{const x={gptIdentity:{ok:false,error:"fixture"},connectionsList:{ok:true,connections:[{id:"work",label:"Work",endpoint:"http://127.0.0.1:19891",enabled:true},{id:"personal",label:"Personal",endpoint:"http://127.0.0.1:25225",enabled:true}]},accountsList:{ok:true,accounts:[]},accountBindingsGet:{ok:true,bindings:{}},userioStatus:{ok:true,connected:true,accountLabel:"fixture"},gptConnectionStatus:{ok:true,accounts:[]}}[m.kind]||{ok:false};r(x)});')
    profile=BASE/('profile-'+rev);profile.mkdir(exist_ok=True)
    p=subprocess.Popen([CHROME,'--headless=new','--no-sandbox','--no-proxy-server','--disable-background-networking','--disable-component-update','--user-data-dir='+str(profile),'--disable-extensions-except='+str(ext),'--load-extension='+str(ext),'--remote-allow-origins=*','--remote-debugging-port=0','about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        f=profile/'DevToolsActivePort'
        for _ in range(150):
            if f.exists(): break
            time.sleep(.1)
        port,path=f.read_text().splitlines(); ws=websocket.create_connection('ws://127.0.0.1:'+port+path)
        seq=0
        def cmd(method,params={},session=None):
            nonlocal seq;seq+=1;ws.send(json.dumps({'id':seq,'method':method,'params':params,**({'sessionId':session} if session else {})}))
            while True:
                x=json.loads(ws.recv())
                if x.get('id')==seq:
                    if 'error' in x: raise RuntimeError(x['error'])
                    return x.get('result',{})
        target=None
        for _ in range(100):
            target=next((x for x in cmd('Target.getTargets')['targetInfos'] if x['type']=='service_worker' and x['url'].endswith('/fixture.js')),None)
            if target: break
            time.sleep(.1)
        eid=target['url'].split('/')[2]; tab=cmd('Target.createTarget',{'url':'chrome-extension://'+eid+'/options.html'});session=cmd('Target.attachToTarget',{'targetId':tab['targetId'],'flatten':True})['sessionId'];cmd('Page.enable',{},session)
        out=[]
        for width in [375,800]:
            cmd('Emulation.setDeviceMetricsOverride',{'width':width,'height':900,'deviceScaleFactor':1,'mobile':False},session);time.sleep(.35)
            ev=cmd('Runtime.evaluate',{'returnByValue':True,'expression':"(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,labels:[...document.querySelectorAll('.connection-name')].map(e=>{const r=document.createRange();r.selectNodeContents(e);const b=e.getBoundingClientRect();return{text:e.textContent,height:b.height,width:b.width,fragments:[...r.getClientRects()].map(x=>({x:x.x,y:x.y,width:x.width,height:x.height}))}}),rows:[...document.querySelectorAll('.connection-row')].map(e=>{const b=e.getBoundingClientRect();return{left:b.left,right:b.right,width:b.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,actions:(()=>{const x=e.querySelector('.connection-actions').getBoundingClientRect();return{left:x.left,right:x.right,width:x.width}})()}}),text:document.body.innerText}))()"},session)['result']['value']
            ev['status']='PASS' if len(ev['labels'])==2 and all(x['height']<=24 and len(x['fragments'])==1 for x in ev['labels']) and ev['scrollWidth']<=width and all(r['right']<=width-10 and r['actions']['right']<=r['right']+1 for r in ev['rows']) else 'FAIL'
            shot=cmd('Page.captureScreenshot',{'format':'png','captureBeyondViewport':True},session);(BASE/(rev+'-'+str(width)+'.png')).write_bytes(__import__('base64').b64decode(shot['data']));out.append(ev)
        ws.close();return out
    finally:
        p.terminate();p.wait(timeout=5)
before=run('beee53a');after=run('e840c9fa'); result={'before':before,'after':after};(BASE/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));sys.exit(0 if any(x['status']=='FAIL' for x in before) and all(x['status']=='PASS' for x in after) else 1)
