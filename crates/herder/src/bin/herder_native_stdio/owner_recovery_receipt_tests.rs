use super::*;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, time::SystemTime};

struct Home(PathBuf);
impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn admitted_receipt_reads_only_the_exact_turns_and_keeps_uncertainty() {
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home =
        Home(std::env::temp_dir().join(format!("codex-admitted-{}-{stamp}", std::process::id())));
    let sessions = home.0.join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    fs::write(sessions.join("rollout-thread.jsonl"), json!({"type":"event_msg","payload":{
        "type":"task_started","turn_id":"manual","turn_attribution":{"turn_id":"manual","turn_trigger":"composer"}
    }}).to_string()).unwrap();
    Connection::open(home.0.join("thread_history_1.sqlite"))
        .unwrap()
        .execute_batch(
            "CREATE TABLE thread_turns(thread_id,turn_id,status,rollout_byte_offset);
         INSERT INTO thread_turns VALUES('thread','manual','failed',0);",
        )
        .unwrap();
    fs::write(home.0.join("app-server"), CODEX_FIXTURE).unwrap();
    let instance = InstanceRef {
        node: NodeRef("fixture".into()),
        instance_id: "instance".into(),
    };
    let process = CodexInstance {
        instance_id: instance.instance_id.clone(),
        executable: "/usr/bin/python3".into(),
        code_home: home.0.clone(),
        cwd: home.0.clone(),
        socket_path: None,
    };
    let timeout = Duration::from_secs(2);
    let owner = OwnerNativeReader {
        reopened: Arc::new(NativeReader::open(process.clone(), instance.clone(), timeout).unwrap()),
        control: Arc::new(Control {
            reader: Arc::new(Mutex::new(
                CodexReader::open(process.clone(), timeout).unwrap(),
            )),
            create: Arc::new(CodexCreateControl::open(process, instance.clone(), timeout).unwrap()),
        }),
    };
    let receipt = NativeReceipt {
        target: SessionAddress {
            instance,
            native_session_id: "thread".into(),
        },
        native_id: "receipt".into(),
    };
    for case in [
        "completed",
        "old-completed",
        "pending",
        "same",
        "followup",
        "missing",
        "duplicate",
        "wrong-key",
        "extra-user",
        "wrong-row",
        "wrong-thread",
        "unknown",
        "no-input",
        "wrong-root",
        "overlap",
        "quota",
        "generated",
        "same-input",
        "moving-head",
        "other-completed",
        "cursor-loop",
        "page-17",
        "item-page-17",
        "resume",
        "resume-changed",
        "stale",
        "unattributed",
        "deadline",
    ] {
        fs::write(home.0.join("case"), case).unwrap();
        fs::write(home.0.join("calls"), "").unwrap();
        let mut observed = owner.reconcile_admitted_recovery(&receipt, "key").await;
        if matches!(case, "resume" | "resume-changed") {
            assert!(
                matches!(observed, Err(_) | Ok(Observation::Unknown { .. })),
                "{case}: {observed:?}"
            );
            fs::write(home.0.join("calls"), "").unwrap();
            observed = owner.reconcile_admitted_recovery(&receipt, "key").await;
        }
        let calls: Vec<Value> = fs::read_to_string(home.0.join("calls"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(
            calls
                .iter()
                .all(|c| c[0] != "thread/read" || c[1]["includeTurns"] == false),
            "{case}: full thread hydration requested: {calls:?}"
        );
        assert!(
            !home.0.join("forbidden").exists(),
            "{case}: unexpected transport request: {calls:?}"
        );
        assert!(
            calls
                .iter()
                .any(|c| c[0] == "thread/read" && c[1]["threadId"] == "thread")
        );
        assert!(
            calls.iter().all(|c| c[1]["cursor"] != "ancient"),
            "{case}: read past receipt"
        );
        assert!(
            calls
                .iter()
                .all(|c| c[1]["cursor"] != "large-tool-output-tail"),
            "{case}: read past user item"
        );
        if matches!(
            case,
            "same"
                | "pending"
                | "unknown"
                | "missing"
                | "duplicate"
                | "wrong-thread"
                | "wrong-root"
                | "overlap"
                | "quota"
                | "other-completed"
                | "cursor-loop"
                | "resume-changed"
                | "unattributed"
                | "deadline"
        ) {
            assert!(
                calls.iter().all(|c| c[0] != "thread/items/list"),
                "{case}: unnecessary items"
            );
        }
        let turns: Vec<_> = calls
            .iter()
            .filter(|c| c[0] == "thread/turns/list")
            .collect();
        if matches!(case, "completed" | "pending" | "same") {
            assert_eq!(turns.len(), 1, "{case}: read behind the latest receipt");
            assert_eq!(turns[0][1]["limit"], 1);
        }
        if matches!(case, "completed" | "old-completed") {
            let items: Vec<_> = calls
                .iter()
                .filter(|c| c[0] == "thread/items/list")
                .collect();
            assert_eq!(items.len(), 1);
            assert_eq!(
                items[0][1]["limit"], 1,
                "loading items beyond the first user input"
            );
        }
        if case == "page-17" {
            assert_eq!(turns.len(), 17, "the exact receipt is on page 17");
        }
        if case == "resume" {
            assert_eq!(turns[0][1]["cursor"], Value::Null);
            assert_eq!(
                turns[1][1]["cursor"], "history-12",
                "lost the last acknowledged cursor"
            );
        }
        if case == "resume-changed" {
            assert_eq!(turns.len(), 2);
            assert_eq!(turns[1][1]["cursor"], "changed-tail");
        }
        if case == "item-page-17" {
            assert_eq!(turns.len(), 1);
            assert_eq!(
                calls.iter().filter(|c| c[0] == "thread/items/list").count(),
                17
            );
        }
        if case == "stale" {
            let cursors: Vec<_> = turns.iter().map(|c| c[1]["cursor"].clone()).collect();
            assert_eq!(
                cursors,
                vec![
                    Value::Null,
                    json!("prior"),
                    Value::Null,
                    json!("prior"),
                    json!("older")
                ]
            );
        }
        match case {
            "completed" | "old-completed" | "followup" | "page-17" | "item-page-17" | "resume"
            | "stale" => assert_eq!(
                observed,
                Ok(Observation::Confirmed {
                    receipt: receipt.clone()
                }),
                "{case}"
            ),
            "pending" => assert_eq!(
                observed,
                Ok(Observation::Pending {
                    receipt: receipt.clone()
                })
            ),
            _ => assert!(
                matches!(observed, Err(_) | Ok(Observation::Unknown { .. })),
                "{case}: {observed:?}"
            ),
        }
    }
}

const CODEX_FIXTURE: &str = r#"import json, os, sys, time
from pathlib import Path
home = Path(os.environ['CODEX_HOME'])
def turn(id, status, at):
    return dict(id=id, rootTurnId=id, status=status, startedAt=at, completedAt=at+1,
                itemsView='notLoaded', items=[], error={'codexErrorInfo':{'responseTooManyFailedAttempts':{'httpStatusCode':429}}})
for line in sys.stdin:
    req = json.loads(line)
    if 'id' not in req: continue
    method, p = req['method'], req['params']
    if method == 'initialize':
        result = dict(codexHome=str(home))
    else:
        case = (home/'case').read_text()
        with (home/'calls').open('a') as calls: print(json.dumps([method, p]), file=calls)
        try:
            assert p['threadId'] == 'thread'
            if method == 'thread/read':
                assert p['includeTurns'] is False
                result = {'thread':{'id':'foreign' if case=='wrong-thread' else 'thread',
                                    'path':str(home/'sessions'/'rollout-thread.jsonl')}}
            elif method == 'thread/turns/list':
                assert p['sortDirection']=='desc' and p['itemsView']=='notLoaded' and 0 < p['limit'] <= 100
                cursor = p.get('cursor')
                if case=='deadline': time.sleep(0.85)
                if cursor is None:
                    id, status = {'completed':('receipt','completed'), 'pending':('receipt','inProgress'),
                                  'same':('receipt','failed'), 'no-input':('receipt','completed'),
                                  'item-page-17':('receipt','completed'), 'unattributed':('no-trigger','failed'),
                                  'unknown':('receipt','unknown')}.get(case, ('manual','failed'))
                    if case=='moving-head' and (home/'head-seen').exists(): id='changed'
                    if case=='moving-head': (home/'head-seen').touch()
                    if case=='other-completed': status='completed'
                    result = dict(data=[turn(id,status,10)],nextCursor='prior')
                    if case in ('page-17','resume','resume-changed'):
                        result['nextCursor']='history-2'
                        if case=='resume-changed' and (home/'paused-resume-changed').exists():
                            result=dict(data=[turn('changed','completed',20)],nextCursor='changed-tail')
                    if case=='wrong-root': result['data'][0]['rootTurnId']='receipt'
                    if case=='quota': result['data'][0]['error']['codexErrorInfo']='usageLimitExceeded'
                elif cursor=='prior':
                    if case=='stale' and not (home/'stale-once').exists():
                        (home/'stale-once').write_text(str(os.getpid()))
                        print(json.dumps(dict(id=req['id'],error=dict(code=-32600,message='invalid paginated history lineage'))),flush=True)
                        continue
                    if case=='stale': assert (home/'stale-once').read_text()!=str(os.getpid())
                    assert case not in ('completed','pending','same')
                    result = dict(data=[turn('middle','completed',8)], nextCursor='older')
                    if case=='cursor-loop': result['nextCursor']='prior'
                elif cursor=='older':
                    id = 'absent' if case in ('missing','other-completed') else 'receipt'
                    status = 'completed' if case in ('old-completed','wrong-row','deadline','stale') else 'failed'
                    result = dict(data=[turn(id,status,2)],nextCursor=None if id=='absent' else 'ancient')
                    if case=='duplicate': result['data'].append(turn(id,status,1))
                    if case=='overlap': result['data'][0]['completedAt']=11
                elif case=='resume-changed' and cursor=='changed-tail':
                    result=dict(data=[turn('different-receipt','completed',12)],nextCursor=None)
                elif case in ('page-17','resume','resume-changed') and cursor.startswith('history-'):
                    n = int(cursor.split('-')[1])
                    assert 2 <= n <= 17
                    pause=home/('paused-'+case)
                    if case.startswith('resume') and n==12 and not pause.exists():
                        pause.touch()
                        time.sleep(2.1)
                    if n == 17: result = dict(data=[turn('receipt','completed',1)],nextCursor='ancient')
                    else: result = dict(data=[turn('intermediate-'+str(n),'completed',1)],nextCursor='history-'+str(n+1))
                else: raise ValueError('read past exact receipt')
            elif method == 'thread/items/list':
                id = p['turnId']
                assert id in ('receipt','manual') and 0 < p['limit'] <= 100
                assert p['deferOutput'] == {'commandExecution':True,'mcpToolCall':True}
                cursor = p.get('cursor')
                item = dict(type='userMessage', id='input-'+id, clientId='key' if id=='receipt' else 'composer-input')
                if case=='wrong-key' and id=='receipt': item['clientId']='other'
                if case in ('completed','old-completed'): item['clientId']=None
                if case=='same-input' and id=='manual': item['id']='input-receipt'
                if case=='generated' and id=='manual': item['clientId']='codex-recovery:another'
                if case=='no-input': item['type']='agentMessage'
                if case=='item-page-17':
                    n=1 if cursor is None else int(cursor.removeprefix('items-'))
                    assert 1 <= n <= 17
                    if n < 17: item=dict(type='agentMessage',id='agent-'+str(n))
                    next_cursor='items-'+str(n+1) if n < 17 else 'large-tool-output-tail'
                elif cursor is None:
                    next_cursor = 'more-items' if case=='extra-user' and id=='receipt' else None
                else:
                    assert cursor=='more-items' and case=='extra-user'
                    item['id']='second-user'
                    next_cursor = None
                result = dict(data=[dict(turnId='other' if case=='wrong-row' else id,item=item)],nextCursor=next_cursor)
                if case=='old-completed': result['nextCursor']='large-tool-output-tail'
            else: raise ValueError('unexpected RPC')
        except Exception:
            with (home/'forbidden').open('a') as violations: print(case, method, file=violations)
            print(json.dumps(dict(id=req['id'],error=dict(code=-32602,message='forbidden fixture request'))),flush=True)
            continue
    print(json.dumps(dict(id=req['id'],result=result)),flush=True)
"#;
