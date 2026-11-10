use herder::{domain::address::{SessionAddress,InstanceRef,NodeRef},search::index::{update_session,search_page,IndexOutcome,SearchCoverage}};
use rusqlite::Connection;
use std::num::NonZeroUsize;
fn address(id:&str)->SessionAddress {SessionAddress{instance:InstanceRef{node:NodeRef("node".into()),instance_id:"instance".into()},native_session_id:id.into()}}
#[test]
fn incremental_reopen_acl() {
 let dir=std::env::temp_dir().join(format!("v030-review-{}",std::process::id())); std::fs::create_dir_all(&dir).unwrap(); let path=dir.join("index.sqlite");
 let mut c=Connection::open(&path).unwrap();
 c.execute_batch("CREATE VIRTUAL TABLE session_search_fts USING fts5(session_ref UNINDEXED, content, tokenize='unicode61'); CREATE TABLE session_search_state(session_ref TEXT PRIMARY KEY NOT NULL, snapshot_id TEXT NOT NULL, content_truncated INTEGER NOT NULL CHECK(content_truncated IN (0,1))) STRICT;").unwrap();
 let a=address("a"); let b=address("b"); let hidden=address("hidden");
 update_session(&mut c,&a,"a1","needle old",false).unwrap(); update_session(&mut c,&b,"b1","needle retained",false).unwrap(); update_session(&mut c,&hidden,"h1","needle secret",false).unwrap();
 let bref=serde_json::to_string(&b).unwrap(); let before:(i64,String,String)=c.query_row("SELECT f.rowid,f.content,s.snapshot_id FROM session_search_fts f JOIN session_search_state s ON s.session_ref=f.session_ref WHERE f.session_ref=?",[&bref],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
 assert_eq!(update_session(&mut c,&a,"a2","needle new",false).unwrap(),IndexOutcome::Updated); drop(c);
 let c=Connection::open(&path).unwrap(); let after:(i64,String,String)=c.query_row("SELECT f.rowid,f.content,s.snapshot_id FROM session_search_fts f JOIN session_search_state s ON s.session_ref=f.session_ref WHERE f.session_ref=?",[&bref],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap(); assert_eq!(before,after);
 let first=search_page(&c,"needle",&[a.clone(),b.clone()],true,0,NonZeroUsize::new(1).unwrap()).unwrap(); let second=search_page(&c,"needle",&[a,b],true,1,NonZeroUsize::new(1).unwrap()).unwrap();
 assert_eq!(first.total_hits,2); assert_eq!(first.next_offset,Some(1)); assert_eq!(second.total_hits,2); assert_eq!(second.next_offset,None); assert_ne!(first.hits[0].session,second.hits[0].session); assert_eq!(first.coverage,SearchCoverage::Complete); assert_eq!(second.coverage,SearchCoverage::Complete); drop(c); std::fs::remove_dir_all(dir).unwrap();
}
