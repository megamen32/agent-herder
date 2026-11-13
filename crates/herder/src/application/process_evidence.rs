//! Immutable, bounded evidence for process continuations. Logs stay on disk.
use crate::{
    application::process_bindings::Delegation,
    domain::address::Authorization,
    ownership::claim,
    process::{ExecutionRecord,ExecutionRequest,ExecutionStore},
};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs::{self,OpenOptions},io::{self,Read,Write},os::unix::fs::OpenOptionsExt,path::Path,process::{Command,Stdio},time::{Duration,Instant,SystemTime,UNIX_EPOCH}};

fn hash(bytes:&[u8])->String{Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect()}
fn git(cwd:&Path,args:&[&str])->Option<Vec<u8>>{
    let nonce=SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_nanos();
    let path=std::env::temp_dir().join(format!("herder-source-{}-{nonce}",std::process::id()));
    let file=OpenOptions::new().create_new(true).write(true).mode(0o600).open(&path).ok()?;
    let result=(||{
        let mut command=Command::new("/usr/bin/git");
        command.args(["-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","-C"])
            .arg(cwd).args(args).stdin(Stdio::null()).stderr(Stdio::null()).stdout(file);
        for name in ["GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_CONFIG_COUNT","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES"]{
            command.env_remove(name);
        }
        let mut child=command.spawn().ok()?;
        let deadline=Instant::now()+Duration::from_secs(2);
        let status=loop{
            if let Some(status)=child.try_wait().ok()?{break status}
            if Instant::now()>=deadline{let _=child.kill();let _=child.wait();return None}
            std::thread::sleep(Duration::from_millis(10));
        };
        if !status.success(){return None}
        let mut data=Vec::new();
        fs::File::open(&path).ok()?.take(2*1024*1024+1).read_to_end(&mut data).ok()?;
        if data.len()>2*1024*1024{None}else{Some(data)}
    })();
    let _=fs::remove_file(path);
    result
}
fn source(cwd:&Path)->Value{
    let root=git(cwd,&["rev-parse","--show-toplevel"]).and_then(|b|String::from_utf8(b).ok());
    let commit=git(cwd,&["rev-parse","--verify","HEAD"]).and_then(|b|String::from_utf8(b).ok());
    let status=git(cwd,&["status","--porcelain=v1","-z","--untracked-files=normal","--ignore-submodules=all"]);
    json!({"cwd":cwd,"repository":root.map(|v|v.trim().to_owned()),"commit":commit.map(|v|v.trim().to_owned()),
        "dirty":status.as_ref().map(|b|!b.is_empty()),"status_digest":status.as_ref().map(|b|hash(b)),
        "status_entries":status.as_ref().map(|b|b.iter().filter(|v|**v==0).count()),
        "snapshot_kind":"git_status_only","content_snapshot":false})
}
fn read(path:&Path)->io::Result<Value>{serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)}
fn once(path:&Path,value:&Value)->io::Result<Value>{
    match read(path){Ok(v)=>return Ok(v),Err(e) if e.kind()==io::ErrorKind::NotFound=>(),Err(e)=>return Err(e)}
    let dir=path.parent().ok_or_else(||io::Error::other("missing evidence directory"))?;
    let temp=dir.join(format!(".evidence-{}-{}",std::process::id(),crate::process::unix_millis()?));
    let mut file=OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temp)?;
    let result=(||{
        file.write_all(&serde_json::to_vec(value).map_err(io::Error::other)?)?;file.sync_all()?;
        match fs::hard_link(&temp,path){Ok(())=>(),Err(e) if e.kind()==io::ErrorKind::AlreadyExists=>(),Err(e)=>return Err(e)}
        fs::File::open(dir)?.sync_all()?;
        read(path)
    })();
    let _=fs::remove_file(temp);
    result
}
pub fn capture_source(store:&ExecutionStore,record:&ExecutionRecord)->io::Result<Value>{
    let path=store.execution_directory(&record.execution_ref)?.join("source.json");
    if path.exists(){return read(&path)}
    let cwd=match &record.request{
        ExecutionRequest::Start(r)=>Some(r.cwd.clone()),
        ExecutionRequest::Attach(r)=>{
            if crate::process::observe_process(&r.process)==crate::process::ProcessObservation::Alive{
                #[cfg(target_os = "linux")]
                { fs::read_link(format!("/proc/{}/cwd",r.process.pid)).ok() }
                // Attach does not supply a trusted source workspace on Darwin.
                // Missing source evidence remains explicit, never guessed.
                #[cfg(target_os = "macos")]
                { None }
            }else{None}
        }
    };
    once(&path,&json!({"version":1,"execution_ref":record.execution_ref,"executor_node":record.node_ref,
        "request_digest":record.payload_hash,"observed_at_unix_ms":crate::process::unix_millis()?,
        "source":cwd.as_ref().map(|p|source(p))}))
}
pub fn completion(store:&ExecutionStore,record:&ExecutionRecord)->io::Result<Value>{
    let dir=store.execution_directory(&record.execution_ref)?;
    let path=dir.join("completion-evidence.json");
    if path.exists(){return read(&path)}
    let receipt=record.receipt.as_ref().ok_or_else(||io::Error::other("completion receipt unavailable"))?;
    let source=match read(&dir.join("source.json")){Ok(v)=>v,Err(e) if e.kind()==io::ErrorKind::NotFound=>Value::Null,Err(e)=>return Err(e)};
    let delegation:Delegation=serde_json::from_slice(&fs::read(dir.join("bindings.json"))?).map_err(io::Error::other)?;
    if delegation.execution_ref!=record.execution_ref || delegation.principal_ref!=record.principal_ref{
        return Err(io::Error::other("completion delegation mismatch"));
    }
    let mut claims=Vec::new();
    for b in &delegation.bindings{
        let current=claim::read_current(&delegation.authority,&b.resource_ref,Authorization::Authorized)?;
        let occupancy=claim::read_execution_binding(&delegation.authority,&b.resource_ref,Authorization::Authorized)?;
        claims.push(json!({"resource_ref":b.resource_ref,"expected_claim_id":b.claim_id,
            "current_claim_id":current.as_ref().map(|c|&c.claim_id),"expires_at":current.as_ref().and_then(|c|c.expires_at.as_ref()),
            "on_exit":b.on_exit,"execution_binding":occupancy}));
    }
    let value=json!({"version":1,"execution_ref":record.execution_ref,"receipt":receipt,"source":source,
        "claims_at_completion":claims,"artifacts":[],"artifact_verification":"not_declared",
        "evidence_path":path,"observed_at_unix_ms":crate::process::unix_millis()?});
    once(&path,&value)
}
pub fn wake_payload(evidence:&Value)->Value{
    let claims=evidence.get("claims_at_completion").and_then(Value::as_array);
    json!({"execution_ref":evidence["execution_ref"],"receipt":evidence["receipt"],"source":evidence["source"],
        "claims_at_completion":claims.map(|v|v.iter().take(16).cloned().collect::<Vec<_>>()),
        "claim_count":claims.map(Vec::len),"evidence_path":evidence["evidence_path"],
        "artifact_verification":evidence["artifact_verification"],
        "next_step":"Inspect the receipt and logs; verify the expected artifact before any deployment."})
}
