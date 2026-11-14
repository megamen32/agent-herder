//! Resource operations over the installed process runtime's canonical authority.
//! Installation administrators are trusted policy. Resource scope, attachment,
//! purpose and declarations are metadata and never establish an access grant.
use crate::{
    application::{process_bindings::ProcessRuntimeConfig, workspace::WorkspaceApplication},
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource},
    domain::{address::Authorization, resource::{ResourceDescriptor, ResourceRef}},
    mcp::{catalog::{self, Declaration, Resource}, transport::{ApplicationFuture, ApplicationPort}},
    ownership::{claim, resource as registry},
};
use rmcp::model::{CallToolResult, ContentBlock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{self, Write}, os::unix::fs::OpenOptionsExt,
    path::Path, sync::atomic::{AtomicU64, Ordering}};

pub struct ProcessResourceApplication {
    config: ProcessRuntimeConfig,
}

impl ProcessResourceApplication {
    /// Loading policy does not initialize or rewrite storage markers or owners.
    pub fn new(config: ProcessRuntimeConfig) -> io::Result<Self> {
        config.validate()?;
        Ok(Self { config })
    }

    fn administrator(&self, identity: &ConnectionIdentity) -> io::Result<PrincipalId> {
        match identity.caller() {
            Caller::Principal(p) if self.config.authorizes_principal(&p.id) => Ok(p.id.clone()),
            _ => Err(io::Error::new(io::ErrorKind::PermissionDenied, "resource policy does not authorize this principal")),
        }
    }

    fn snapshot(&self, descriptor: ResourceDescriptor) -> io::Result<Value> {
        let authority = &self.config.resources;
        let resource_ref = descriptor.resource_ref();
        let owner = claim::read_current(authority, resource_ref, Authorization::Authorized)?;
        let live = match &owner {
            Some(owner) => match claim::read_live_by_claim_id(authority, resource_ref, Authorization::Authorized, &owner.claim_id) {
                Ok(current) => current.is_some(),
                Err(error) if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::PermissionDenied) => false,
                Err(error) => return Err(error),
            },
            None => false,
        };
        let occupancy = claim::read_execution_binding(authority, resource_ref, Authorization::Authorized)?;
        let (dir, _) = authority.read_local_resource_marker(resource_ref, Authorization::Authorized)?;
        let now = claim::now_seconds()?;
        let declarations = self.read_declarations(&dir, resource_ref)?.into_iter().map(|record| {
            let expired = claim::parse_expiry_seconds(&record.expires_at)? <= now;
            Ok(json!({"declaration":record,"expired":expired,"advisory":true}))
        }).collect::<io::Result<Vec<_>>>()?;
        Ok(json!({"resource":descriptor,"claim":owner,"claim_live":live,
            "execution_binding":occupancy,"declarations":declarations}))
    }

    fn declare(&self, principal: &PrincipalId, resource_ref: &ResourceRef, operation: Declaration) -> io::Result<Value> {
        let authority = &self.config.resources;
        registry::get(authority, resource_ref, Authorization::Authorized)?;
        let (dir, marker) = authority.read_local_resource_marker(resource_ref, Authorization::Authorized)?;
        let guard = OpenOptions::new().read(true).write(true).create(true).mode(0o600).open(dir.join("declarations.lock"))?;
        guard.lock()?;
        let (current_dir, current_marker) = authority.read_local_resource_marker(resource_ref, Authorization::Authorized)?;
        if current_dir != dir || current_marker != marker { return Err(invalid("resource changed before declaration")); }
        let mut declarations = self.read_declarations(&dir, resource_ref)?;
        let result = match operation {
            Declaration::Set { worktree, scope, purpose, expires_at } => {
                if !Path::new(&worktree).is_absolute() || [worktree.as_str(),scope.as_str(),purpose.as_str()].iter().any(|v|v.is_empty() || v.len()>4096)
                    || claim::parse_expiry_seconds(&expires_at)? <= claim::now_seconds()? {
                    return Err(io::Error::new(io::ErrorKind::InvalidInput, "declaration needs an absolute worktree, scope, purpose and future expiry"));
                }
                let declaration_ref = self.declaration_ref(resource_ref, &principal.0, &worktree, &scope);
                let record = AdvisoryDeclaration { declaration_ref:declaration_ref.clone(),resource_ref:resource_ref.clone(),
                    principal_ref:principal.0.clone(),worktree,scope,purpose,expires_at };
                match declarations.iter_mut().find(|d|d.declaration_ref == declaration_ref) {
                    Some(existing) => *existing = record.clone(),
                    None => declarations.push(record.clone()),
                }
                json!({"status":"declared","advisory":true,"declaration":record})
            }
            Declaration::Remove { declaration_ref } => {
                let index = declarations.iter().position(|d|d.declaration_ref == declaration_ref)
                    .ok_or_else(||io::Error::new(io::ErrorKind::NotFound,"declaration not found"))?;
                if declarations[index].principal_ref != principal.0 {
                    return Err(io::Error::new(io::ErrorKind::PermissionDenied,"declaration belongs to another principal"));
                }
                declarations.remove(index);
                json!({"status":"removed","advisory":true,"declaration_ref":declaration_ref})
            }
        };
        declarations.sort_by(|a,b|a.declaration_ref.cmp(&b.declaration_ref));
        write_declarations(&dir, &declarations)?;
        Ok(result)
    }

    fn declaration_ref(&self, resource_ref: &ResourceRef, principal: &str, worktree: &str, scope: &str) -> String {
        let mut hash=Sha256::new();
        for part in [self.config.resources.storage_id.0.as_str(),resource_ref.0.as_str(),principal,worktree,scope] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
        format!("declaration-{}",hash.finalize().iter().map(|v|format!("{v:02x}")).collect::<String>())
    }

    fn read_declarations(&self, dir: &Path, resource_ref: &ResourceRef) -> io::Result<Vec<AdvisoryDeclaration>> {
        let path=dir.join("declarations.json");
        let records: Vec<AdvisoryDeclaration> = match fs::symlink_metadata(&path) {
            Err(error) if error.kind()==io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
            Ok(metadata) if !metadata.file_type().is_file() => return Err(invalid("declarations are not a regular file")),
            Ok(_) => serde_json::from_slice(&fs::read(path)?).map_err(invalid)?,
        };
        let mut seen=std::collections::HashSet::new();
        for r in &records {
            if r.resource_ref!=*resource_ref || r.principal_ref.is_empty() || !Path::new(&r.worktree).is_absolute()
                || [r.worktree.as_str(),r.scope.as_str(),r.purpose.as_str()].iter().any(|v|v.is_empty() || v.len()>4096)
                || r.declaration_ref!=self.declaration_ref(resource_ref,&r.principal_ref,&r.worktree,&r.scope)
                || !seen.insert(&r.declaration_ref) || claim::parse_expiry_seconds(&r.expires_at).is_err() {
                return Err(invalid("declaration identity is invalid"));
            }
        }
        Ok(records)
    }
}

impl ApplicationPort for ProcessResourceApplication {
    fn call<'a>(&'a self, identity: &'a ConnectionIdentity, request: catalog::Request) -> ApplicationFuture<'a> {
        Box::pin(async move {
            let catalog::Request::Resource(request)=request else {return None};
            // The process application verifies execution ownership and handles Bind.
            if matches!(request,Resource::Bind{..}) {return None}
            let principal=match self.administrator(identity) {Ok(p)=>p,Err(e)=>return Some(error_result(e))};
            let result = match request {
                Resource::List {scope,kind,cursor} => {
                    (|| {
                        let mut resources=registry::list(&self.config.resources,Authorization::Authorized)?;
                        resources.retain(|d|scope.as_ref().is_none_or(|s|d.scope()==s)
                            && kind.as_ref().is_none_or(|k|&d.kind==k)
                            && cursor.as_ref().is_none_or(|c|d.resource_ref().0.as_str()>c.as_str()));
                        const PAGE_SIZE:usize=100;
                        let next_cursor=(resources.len()>PAGE_SIZE).then(||resources[PAGE_SIZE-1].resource_ref().0.clone());
                        resources.truncate(PAGE_SIZE);
                        let resources=resources.into_iter().map(|d|self.snapshot(d)).collect::<io::Result<Vec<_>>>()?;
                        Ok(json!({"resources":resources,"next_cursor":next_cursor}))
                    })()
                }
                Resource::Get {resource_ref} => registry::get(&self.config.resources,&resource_ref,Authorization::Authorized)
                    .and_then(|descriptor|self.snapshot(descriptor)),
                Resource::Declare {resource_ref,declaration} => self.declare(&principal,&resource_ref,declaration),
                mutation => {
                    let resource_ref=match &mutation {
                        Resource::Register {resource_ref,..}|Resource::Update {resource_ref,..}|Resource::Claim {resource_ref,..}
                        |Resource::Renew {resource_ref,..}|Resource::Release {resource_ref,..}=>resource_ref,
                        _=>return None,
                    };
                    // Exact grants follow the installed administrator decision,
                    // never the resource's supplied scope or attachment metadata.
                    let grants=[Action::Read,Action::Write].into_iter().map(|action|Grant {principal:principal.clone(),
                        resource:PrivateResource::Resource(resource_ref.0.clone()),action}).collect();
                    return WorkspaceApplication::new(self.config.resources.clone(),grants)
                        .call(identity,catalog::Request::Resource(mutation)).await;
                }
            };
            Some(match result {Ok(value)=>CallToolResult::structured(value),Err(error)=>error_result(error)})
        })
    }
}

/// Advisory coordination only. Expiry marks a declaration stale for readers;
/// it does not acquire, renew, release or authorize any authoritative lease.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AdvisoryDeclaration {
    declaration_ref:String,
    resource_ref:ResourceRef,
    principal_ref:String,
    worktree:String,
    scope:String,
    purpose:String,
    expires_at:String,
}

fn write_declarations(dir:&Path, records:&[AdvisoryDeclaration]) -> io::Result<()> {
    static NEXT_ID:AtomicU64=AtomicU64::new(0);
    let temp=dir.join(format!(".declarations-{}-{}.tmp",std::process::id(),NEXT_ID.fetch_add(1,Ordering::Relaxed)));
    let result=(|| {
        let mut file=OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
        file.write_all(&serde_json::to_vec(records).map_err(invalid)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp,dir.join("declarations.json"))?;
        File::open(dir)?.sync_all()
    })();
    if result.is_err() {let _=fs::remove_file(&temp);}
    result
}

fn invalid(e:impl std::fmt::Display)->io::Error {io::Error::new(io::ErrorKind::InvalidData,e.to_string())}
fn error_result(error:io::Error)->CallToolResult {CallToolResult::error(vec![ContentBlock::text(error.to_string())])}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::identity::VerifiedPrincipal,domain::{address::NodeRef,resource::{ResourceKind,ResourceScope}},
        ownership::manifest::{AuthorityRoute,StorageAuthority,StorageId,StorageMarker}};
    use std::{path::PathBuf,time::{SystemTime,UNIX_EPOCH}};

    struct Fixture {root:PathBuf,config:ProcessRuntimeConfig}
    impl Fixture {
        fn new() -> Self {
            let root=std::env::temp_dir().join(format!("herder-resource-dispatch-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            let config=ProcessRuntimeConfig {remote_executors: Vec::new(),version:1,node_ref:"fixture-node".into(),worker:"/fixture/worker".into(),execution_root:root.join("executions"),
                resources:StorageAuthority {storage_id:StorageId("fixture-storage".into()),authority_node:NodeRef("fixture-node".into()),root:root.join("resources-store"),schema:"v1".into(),route:AuthorityRoute::Local},
                administrators:vec!["alice".into(),"bob".into()]};
            Self {root,config}
        }
        fn initialize(&self) {
            fs::create_dir_all(self.config.resources.root.join("resources")).unwrap();
            fs::write(self.config.resources.root.join("storage.json"),serde_json::to_vec(&StorageMarker {schema:"v1".into(),storage_id:self.config.resources.storage_id.clone()}).unwrap()).unwrap();
        }
        fn app(&self)->ProcessResourceApplication {ProcessResourceApplication::new(self.config.clone()).unwrap()}
        async fn call(&self,who:&str,resource:Resource)->CallToolResult {
            self.app().call(&identity(who),catalog::Request::Resource(resource)).await.unwrap()
        }
        async fn register(&self) {
            assert_ne!(self.call("alice",Resource::Register {resource_ref:ResourceRef("build-slot".into()),scope:ResourceScope::Global,
                kind:ResourceKind::Other("build".into()),external_ref:"fixture-build-slot".into(),authority_ref:self.config.resources.storage_id.0.clone(),attachment:None}).await.is_error,Some(true));
        }
    }
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
    fn identity(who:&str)->ConnectionIdentity {ConnectionIdentity::new(Caller::Principal(VerifiedPrincipal {id:PrincipalId(who.into())}),None)}
    fn resource()->ResourceRef {ResourceRef("build-slot".into())}
    fn value(result:CallToolResult)->Value {assert_ne!(result.is_error,Some(true),"{result:?}");result.structured_content.unwrap()}

    #[tokio::test]
    async fn installed_policy_dispatch_preserves_owner_and_exposes_occupancy() {
        let f=Fixture::new();
        f.app();
        assert!(!f.root.exists(),"loading policy created persistent stores");
        assert_eq!(f.call("mallory",Resource::Get {resource_ref:resource()}).await.is_error,Some(true));
        assert!(!f.root.exists());
        f.initialize();f.register().await;
        let acquired=value(f.call("alice",Resource::Claim {resource_ref:resource(),purpose:"build fixture".into(),request_key:"request-1".into(),expires_at:Some("2099-01-01T00:00:00Z".into())}).await);
        let claim_id=acquired["claim_id"].as_str().unwrap();
        let renew=Resource::Renew {resource_ref:resource(),claim_id:claim_id.into(),expires_at:"2099-02-01T00:00:00Z".into()};
        assert_eq!(f.call("bob",renew.clone()).await.is_error,Some(true));
        value(f.call("alice",renew).await);
        claim::bind_execution(&f.config.resources,&resource(),Authorization::Authorized,claim_id,"alice",1,"execution-fixture").unwrap();
        let snapshot=value(f.call("alice",Resource::Get {resource_ref:resource()}).await);
        assert_eq!(snapshot["claim"]["principal_ref"],"alice");
        assert_eq!(snapshot["claim_live"],true);
        assert_eq!(snapshot["execution_binding"]["execution_ref"],"execution-fixture");
        let listed=value(f.call("alice",Resource::List {scope:Some(ResourceScope::Global),kind:Some(ResourceKind::Other("build".into())),cursor:None}).await);
        assert_eq!(listed["resources"][0],snapshot);
        assert_eq!(f.call("alice",Resource::Release {resource_ref:resource(),claim_id:claim_id.into()}).await.is_error,Some(true));
        claim::clear_execution_binding(&f.config.resources,&resource(),Authorization::Authorized,claim_id,"alice","execution-fixture","verified-fixture-receipt").unwrap();
        assert_eq!(f.call("bob",Resource::Release {resource_ref:resource(),claim_id:claim_id.into()}).await.is_error,Some(true));
        value(f.call("alice",Resource::Release {resource_ref:resource(),claim_id:claim_id.into()}).await);
        assert_eq!(value(f.call("alice",Resource::Get {resource_ref:resource()}).await)["claim"],Value::Null);
    }

    #[tokio::test]
    async fn declarations_are_advisory_and_removal_checks_exact_principal() {
        let f=Fixture::new();f.initialize();f.register().await;
        let declaration=Resource::Declare {resource_ref:resource(),declaration:Declaration::Set {worktree:"/fixture/worktree".into(),scope:"src".into(),purpose:"review only".into(),expires_at:"2099-01-01T00:00:00Z".into()}};
        let first=value(f.call("alice",declaration.clone()).await);
        assert_eq!(value(f.call("alice",declaration).await),first);
        let declaration_ref=first["declaration"]["declaration_ref"].as_str().unwrap();
        let remove=Resource::Declare {resource_ref:resource(),declaration:Declaration::Remove {declaration_ref:declaration_ref.into()}};
        assert_eq!(f.call("bob",remove.clone()).await.is_error,Some(true));
        assert!(claim::read_current(&f.config.resources,&resource(),Authorization::Authorized).unwrap().is_none());
        value(f.call("bob",Resource::Claim {resource_ref:resource(),purpose:"actual owner".into(),request_key:"bob-request".into(),expires_at:None}).await);
        let owner_before=f.config.resources.read_owner_bytes(&resource(),Authorization::Authorized).unwrap();
        let snapshot=value(f.call("alice",Resource::Get {resource_ref:resource()}).await);
        assert_eq!(snapshot["declarations"][0]["advisory"],true);
        assert_eq!(snapshot["declarations"][0]["expired"],false);
        value(f.call("alice",remove).await);
        assert_eq!(f.config.resources.read_owner_bytes(&resource(),Authorization::Authorized).unwrap(),owner_before);
    }
}
