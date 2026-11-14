//! Principal-wide compatibility keys inside Herder's canonical resource store.
//! This index only fences target/payload selection. The existing scoped intent
//! and native receipt remain the sole delivery authority; this index never sends.
use crate::{domain::address::SessionAddress, ownership::manifest::{AuthorityRoute, StorageAuthority, StorageMarker}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, DirBuilder, File, OpenOptions}, io::{self, Read, Write},
    os::{fd::AsRawFd, unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt}}, path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering}};

const PREFIX: &str = "compat-resume:v1:";
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
fn invalid(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }
fn exact(value: &str) -> bool { !value.is_empty() && value.len() <= 4096 && !value.chars().any(char::is_control) }
fn digest(bytes: &[u8]) -> String { Sha256::digest(bytes).iter().map(|v|format!("{v:02x}")).collect() }
fn payload_digest(value:&str)->bool {
    value.strip_prefix("sha256-dispatch-v1:").is_some_and(|v|v.len()==64
        && v.bytes().all(|c|c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
}
fn identity(path: &Path) -> io::Result<(u64,u64)> {
    let m=fs::symlink_metadata(path)?;
    if !m.is_dir() || m.uid()!=unsafe{libc::geteuid()} || m.mode()&0o077!=0 {return Err(invalid("delivery key directory is not private"))}
    Ok((m.dev(),m.ino()))
}
fn private_file(path:&Path,write:bool,create:bool)->io::Result<File>{
    let f=OpenOptions::new().read(true).write(write).create(create).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC|libc::O_NONBLOCK).open(path)?;
    let m=f.metadata()?;
    if !m.is_file() || m.uid()!=unsafe{libc::geteuid()} || m.nlink()!=1 || m.mode()&0o077!=0 {
        return Err(invalid("delivery key file is not private"))
    }
    Ok(f)
}
fn read<T:serde::de::DeserializeOwned>(path:&Path)->io::Result<T>{
    let mut f=private_file(path,false,false)?;
    if f.metadata()?.len()>32768{return Err(invalid("delivery key record is too large"))}
    let mut bytes=Vec::new();Read::by_ref(&mut f).take(32769).read_to_end(&mut bytes)?;
    if bytes.len()>32768{return Err(invalid("delivery key record is too large"))}
    serde_json::from_slice(&bytes).map_err(|_|invalid("delivery key JSON is invalid"))
}
fn publish(path:&Path,value:&impl Serialize)->io::Result<()> {
    let parent=path.parent().ok_or_else(||invalid("delivery key parent missing"))?;
    let tmp=parent.join(format!(".delivery-key-{}.{}.tmp",std::process::id(),NEXT_TEMP.fetch_add(1,Ordering::Relaxed)));
    let mut f=OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC).open(&tmp)?;
    let result=(||{
        serde_json::to_writer(&mut f,value).map_err(io::Error::other)?;f.write_all(b"\n")?;f.sync_all()?;
        fs::hard_link(&tmp,path)?;fs::remove_file(&tmp)?;File::open(parent)?.sync_all()?;Ok(())
    })();
    if result.is_err(){let _=fs::remove_file(tmp);}result
}

#[derive(Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectoryMarker { version:u8,storage_id:String,device:u64,inode:u64 }

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryKeyBinding {
    version:u8,
    storage_id:String,
    principal:String,
    request_key:String,
    session_ref:String,
    target:SessionAddress,
    pub payload_hash:String,
}

pub struct DeliveryKeyRegistry {
    authority:StorageAuthority,
    root_identity:(u64,u64),
    directory:PathBuf,
    directory_identity:(u64,u64),
    marker:DirectoryMarker,
}
impl DeliveryKeyRegistry {
    pub fn applies(key:&str)->bool{key.starts_with(PREFIX)}
    pub fn new(authority:StorageAuthority)->io::Result<Self>{
        if !matches!(authority.route,AuthorityRoute::Local) || !authority.root.is_absolute()
            || fs::canonicalize(&authority.root)?!=authority.root || !exact(&authority.storage_id.0) {
            return Err(invalid("canonical delivery authority is invalid"))
        }
        let root_identity=identity(&authority.root)?;
        Self::marker(&authority)?;
        let init_path=authority.root.join("delivery-bindings.init.lock");
        let init=private_file(&init_path,true,true)?;
        if unsafe{libc::flock(init.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0{return Err(io::Error::last_os_error())}
        let actual=fs::symlink_metadata(&init_path)?;let pinned=init.metadata()?;
        if (actual.dev(),actual.ino())!=(pinned.dev(),pinned.ino()){return Err(invalid("delivery key initialization lock changed"))}
        let directory=authority.root.join("delivery-bindings");
        let marker_path=authority.root.join("delivery-bindings.json");
        let retained:Option<DirectoryMarker>=match read(&marker_path){Ok(v)=>Some(v),Err(e) if e.kind()==io::ErrorKind::NotFound=>None,Err(e)=>return Err(e)};
        if retained.is_none() {
            match DirBuilder::new().mode(0o700).create(&directory) {
                Ok(())=>File::open(&authority.root)?.sync_all()?,
                Err(e) if e.kind()==io::ErrorKind::AlreadyExists=>{
                    identity(&directory)?;
                    if fs::read_dir(&directory)?.next().is_some(){return Err(invalid("unmarked delivery bindings cannot be adopted"))}
                },Err(e)=>return Err(e),
            }
        }
        let directory_identity=identity(&directory)?;
        let marker=DirectoryMarker{version:1,storage_id:authority.storage_id.0.clone(),device:directory_identity.0,inode:directory_identity.1};
        if let Some(old)=retained {if old!=marker{return Err(invalid("retained delivery bindings directory changed"))}}
        else {publish(&marker_path,&marker)?;}
        let value=Self{authority,root_identity,directory,directory_identity,marker};value.verify()?;Ok(value)
    }
    fn marker(authority:&StorageAuthority)->io::Result<()> {
        let marker:StorageMarker=read(&authority.root.join("storage.json"))?;
        if marker.schema!=authority.schema || marker.storage_id!=authority.storage_id {return Err(invalid("canonical delivery authority marker changed"))}
        Ok(())
    }
    fn verify(&self)->io::Result<()> {
        if fs::canonicalize(&self.authority.root)?!=self.authority.root
            || identity(&self.authority.root)?!=self.root_identity || identity(&self.directory)?!=self.directory_identity {
            return Err(invalid("canonical delivery authority identity changed"))
        }
        Self::marker(&self.authority)?;
        let marker:DirectoryMarker=read(&self.authority.root.join("delivery-bindings.json"))?;
        if marker!=self.marker{return Err(invalid("retained delivery bindings marker changed"))}Ok(())
    }
    fn path(&self,principal:&str,key:&str)->io::Result<PathBuf>{
        let suffix=key.strip_prefix(PREFIX).ok_or_else(||invalid("not a compatibility delivery key"))?;
        if !exact(principal) || suffix.len()!=64 || !suffix.bytes().all(|c|c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
            return Err(invalid("invalid compatibility delivery key"))
        }
        let bytes=serde_json::to_vec(&("herder-compatibility-delivery-v1",&self.authority.storage_id.0,principal,key)).map_err(io::Error::other)?;
        Ok(self.directory.join(format!("{}.json",digest(&bytes))))
    }
    /// A read never allocates a reservation. A different target conflicts even
    /// if its own scoped intent does not yet exist.
    pub fn lookup(&self,principal:&str,session:&str,target:&SessionAddress,key:&str)->io::Result<Option<DeliveryKeyBinding>>{
        self.verify()?;let path=self.path(principal,key)?;
        let value:DeliveryKeyBinding=match read(&path){Ok(v)=>v,Err(e) if e.kind()==io::ErrorKind::NotFound=>{self.verify()?;return Ok(None)},Err(e)=>return Err(e)};
        if value.version!=1 || value.storage_id!=self.authority.storage_id.0 || value.principal!=principal || value.request_key!=key
            || !payload_digest(&value.payload_hash) {
            return Err(invalid("canonical delivery binding is invalid"))
        }
        if value.session_ref!=session || value.target!=*target {return Err(io::Error::new(io::ErrorKind::AlreadyExists,"idempotency_conflict"))}
        self.verify()?;Ok(Some(value))
    }
    /// Durable before any scoped native admission. The per-key file lock spans
    /// every owner profile and every core process using this StorageAuthority.
    pub fn reserve(&self,principal:&str,session:&str,target:&SessionAddress,key:&str,payload_hash:&str)->io::Result<()> {
        if !exact(session) || !payload_digest(payload_hash) {
            return Err(invalid("canonical delivery binding is invalid"))
        }
        self.verify()?;let path=self.path(principal,key)?;let lock_path=path.with_extension("lock");
        let lock=private_file(&lock_path,true,true)?;
        if unsafe{libc::flock(lock.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0{return Err(io::Error::last_os_error())}
        let current=fs::symlink_metadata(&lock_path)?;let pinned=lock.metadata()?;
        if (current.dev(),current.ino())!=(pinned.dev(),pinned.ino()){return Err(invalid("delivery key lock changed"))}
        self.verify()?;
        if let Some(existing)=self.lookup(principal,session,target,key)?{
            return if existing.payload_hash==payload_hash {Ok(())}else{Err(io::Error::new(io::ErrorKind::AlreadyExists,"idempotency_conflict"))}
        }
        let value=DeliveryKeyBinding{version:1,storage_id:self.authority.storage_id.0.clone(),principal:principal.into(),
            request_key:key.into(),session_ref:session.into(),target:target.clone(),payload_hash:payload_hash.into()};
        self.verify()?;
        // No replacement is permitted even if an unexpected writer ignored the
        // lock. A partial record is never published or treated as free.
        publish(&path,&value)?;
        self.lookup(principal,session,target,key)?.ok_or_else(||invalid("delivery key reservation disappeared"))?;
        Ok(())
    }
}
