use herder::{application::delivery_keys::DeliveryKeyRegistry, domain::address::{NodeRef,SessionAddress,InstanceRef},
    ownership::manifest::{StorageAuthority,StorageId,AuthorityRoute}};
use std::{fs,io,os::unix::fs::{PermissionsExt,DirBuilderExt,symlink},sync::{Arc,Barrier,atomic::{AtomicU64,Ordering}},thread,path::{Path,PathBuf}};
static NEXT:AtomicU64=AtomicU64::new(0);
struct TempDir(PathBuf);
impl TempDir {
    fn new()->Self {
        for _ in 0..100 {
            let p=std::env::temp_dir().join(format!("herder-delivery-keys-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
            match fs::DirBuilder::new().mode(0o700).create(&p) {
                Ok(())=>return Self(fs::canonicalize(p).unwrap()),
                Err(e) if e.kind()==io::ErrorKind::AlreadyExists=>(),Err(e)=>panic!("{e}"),
            }
        }
        panic!("private test directory unavailable")
    }
    fn path(&self)->&Path{&self.0}
}
impl Drop for TempDir {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}

fn fixture()->(TempDir,StorageAuthority){
    let root=TempDir::new();fs::set_permissions(root.path(),fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(root.path().join("storage.json"),r#"{"schema":"v1","storage_id":"qa-delivery"}"#).unwrap();
    fs::set_permissions(root.path().join("storage.json"),fs::Permissions::from_mode(0o600)).unwrap();
    let authority=StorageAuthority{root:fs::canonicalize(root.path()).unwrap(),storage_id:StorageId("qa-delivery".into()),
        schema:"v1".into(),authority_node:NodeRef("qa-node".into()),route:AuthorityRoute::Local};
    (root,authority)
}
fn key()->String{format!("compat-resume:v1:{}","a".repeat(64))}
fn payload(value:char)->String{format!("sha256-dispatch-v1:{}",value.to_string().repeat(64))}
fn target(id:&str)->SessionAddress{SessionAddress{instance:InstanceRef{node:NodeRef("qa-node".into()),instance_id:"qa-instance".into()},native_session_id:id.into()}}

#[test]
fn canonical_key_is_principal_wide_durable_and_bound_to_target_and_payload(){
    let (_root,authority)=fixture();
    let one=DeliveryKeyRegistry::new(authority.clone()).unwrap();
    one.reserve("alice","session:A",&target("A"),&key(),&payload('b')).unwrap();
    drop(one);
    let two=DeliveryKeyRegistry::new(authority).unwrap();
    two.reserve("alice","session:A",&target("A"),&key(),&payload('b')).unwrap();
    assert_eq!(two.reserve("alice","session:B",&target("B"),&key(),&payload('b')).unwrap_err().kind(),io::ErrorKind::AlreadyExists);
    assert_eq!(two.lookup("alice","session:B",&target("B"),&key()).unwrap_err().kind(),io::ErrorKind::AlreadyExists);
    assert_eq!(two.reserve("alice","session:A",&target("A"),&key(),&payload('c')).unwrap_err().kind(),io::ErrorKind::AlreadyExists);
    two.reserve("bob","session:B",&target("B"),&key(),&payload('c')).unwrap();
}

#[test]
fn independent_registries_cannot_reserve_one_key_for_two_targets_concurrently(){
    let (root,authority)=fixture();let barrier=Arc::new(Barrier::new(2));
    let stores=[DeliveryKeyRegistry::new(authority.clone()).unwrap(),DeliveryKeyRegistry::new(authority.clone()).unwrap()];
    let threads:Vec<_>=["A","B"].into_iter().zip(stores).map(|(id,store)|{
        let barrier=barrier.clone();
        thread::spawn(move||{barrier.wait();
            (id,store.reserve("alice",&format!("session:{id}"),&target(id),&key(),&payload('b')))})
    }).collect();
    let results:Vec<_>=threads.into_iter().map(|t|t.join().unwrap()).collect();
    let winner=results.iter().find(|(_,r)|r.is_ok()).unwrap().0;
    assert_eq!(results.iter().filter(|(_,r)|r.is_ok()).count(),1);
    let loser=if winner=="A"{"B"}else{"A"};
    let store=DeliveryKeyRegistry::new(authority).unwrap();
    assert_eq!(store.reserve("alice",&format!("session:{loser}"),&target(loser),&key(),&payload('b')).unwrap_err().kind(),io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read_dir(root.path().join("delivery-bindings")).unwrap().filter_map(Result::ok).filter(|p|p.path().extension().is_some_and(|e|e=="json")).count(),1);
}

#[test]
fn missing_read_never_allocates_a_key_or_lock(){
    let (root,authority)=fixture();let store=DeliveryKeyRegistry::new(authority.clone()).unwrap();
    assert!(store.lookup("alice","session:A",&target("A"),&key()).unwrap().is_none());
    assert_eq!(fs::read_dir(root.path().join("delivery-bindings")).unwrap().count(),0);
}

#[test]
fn malformed_or_linked_record_is_never_treated_as_absence(){
    let (root,authority)=fixture();let store=DeliveryKeyRegistry::new(authority).unwrap();
    store.reserve("alice","session:A",&target("A"),&key(),&payload('b')).unwrap();
    let record=fs::read_dir(root.path().join("delivery-bindings")).unwrap().filter_map(Result::ok).find(|p|p.path().extension().is_some_and(|e|e=="json")).unwrap().path();
    fs::write(&record,b"{partial").unwrap();
    assert!(store.lookup("alice","session:A",&target("A"),&key()).is_err());
    assert!(store.reserve("alice","session:A",&target("A"),&key(),&payload('b')).is_err());
    fs::remove_file(&record).unwrap();symlink(root.path().join("storage.json"),&record).unwrap();
    assert!(store.lookup("alice","session:A",&target("A"),&key()).is_err());
}

#[test]
fn fifo_record_is_rejected_without_blocking_the_reader(){
    use std::{ffi::CString,os::unix::ffi::OsStrExt,sync::mpsc,time::Duration};
    let (root,authority)=fixture();let store=DeliveryKeyRegistry::new(authority).unwrap();
    store.reserve("alice","session:A",&target("A"),&key(),&payload('b')).unwrap();
    let record=fs::read_dir(root.path().join("delivery-bindings")).unwrap().filter_map(Result::ok).find(|p|p.path().extension().is_some_and(|e|e=="json")).unwrap().path();
    fs::remove_file(&record).unwrap();let name=CString::new(record.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe{libc::mkfifo(name.as_ptr(),0o600)},0);
    let (send,receive)=mpsc::channel();
    let worker=thread::spawn(move||{let result=store.lookup("alice","session:A",&target("A"),&key());send.send(result.is_err()).unwrap();});
    assert!(receive.recv_timeout(Duration::from_secs(1)).expect("FIFO open must not block"));
    worker.join().unwrap();
}

#[test]
fn moved_authority_or_changed_marker_cannot_reopen_a_key_as_free(){
    let (root,authority)=fixture();let store=DeliveryKeyRegistry::new(authority.clone()).unwrap();
    store.reserve("alice","session:A",&target("A"),&key(),&payload('b')).unwrap();
    fs::rename(root.path().join("delivery-bindings"),root.path().join("retained-bindings")).unwrap();
    fs::create_dir(root.path().join("delivery-bindings")).unwrap();fs::set_permissions(root.path().join("delivery-bindings"),fs::Permissions::from_mode(0o700)).unwrap();
    assert!(store.lookup("alice","session:A",&target("A"),&key()).is_err());
    assert!(DeliveryKeyRegistry::new(authority.clone()).is_err());
    fs::remove_dir(root.path().join("delivery-bindings")).unwrap();fs::rename(root.path().join("retained-bindings"),root.path().join("delivery-bindings")).unwrap();
    fs::write(root.path().join("storage.json"),r#"{"schema":"v1","storage_id":"other"}"#).unwrap();
    assert!(store.lookup("alice","session:A",&target("A"),&key()).is_err());
}

#[test]
fn registry_rejects_untrusted_paths_permissions_and_malformed_key(){
    let (root,authority)=fixture();let store=DeliveryKeyRegistry::new(authority.clone()).unwrap();
    assert!(store.reserve("alice","session:A",&target("A"),"compat-resume:v1:../A",&payload('b')).is_err());
    let linked=root.path().join("alias");symlink(root.path(),&linked).unwrap();
    assert!(DeliveryKeyRegistry::new(StorageAuthority{root:linked,..authority.clone()}).is_err());
    fs::set_permissions(root.path(),fs::Permissions::from_mode(0o750)).unwrap();
    assert!(DeliveryKeyRegistry::new(authority).is_err());
}
