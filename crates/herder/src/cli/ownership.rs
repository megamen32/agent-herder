//! Offline ownership commands. This module intentionally does not touch MCP,
//! SQLite, daemon lifecycle, or any agent session API.

use crate::domain::address::Authorization;
use crate::domain::resource::{ResourceClaim, ResourceRef};
use crate::ownership::claim::{self, ClaimOutcome, OwnerRecord};
use crate::ownership::manifest::StorageAuthority;
use crate::ownership::resource;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn execute(args: &[String]) -> Result<Value, String> {
    let Some(action) = args.first().map(String::as_str) else {
        return Err(usage());
    };
    if !matches!(action, "status" | "claim") {
        return Err(usage());
    }
    let options = parse_options(&args[1..], action == "claim")?;
    let authority = load_authority(&options.authority)?;
    let principal_ref = authorize_local_storage(&authority).map_err(user_error)?;
    let resource_ref = ResourceRef(options.resource);
    let descriptor = resource::get(&authority, &resource_ref, Authorization::Authorized)
        .map_err(user_error)?;

    if action == "status" {
        let owner = authority
            .read_owner_bytes(&resource_ref, Authorization::Authorized)
            .map_err(user_error)?
            .map(|bytes| {
                let record: OwnerRecord =
                    serde_json::from_slice(&bytes).map_err(|_| ownership_unavailable())?;
                validate_owner_record(&authority, &resource_ref, &record)
                    .map_err(user_error)?;
                Ok::<_, String>(record)
            })
            .transpose()?;
        return Ok(json!({
            "status": if owner.is_some() { "owned" } else { "free" },
            "resource": descriptor,
            "owner": owner,
        }));
    }

    let claim_id = options.claim_id.ok_or_else(usage)?;
    let purpose = options.purpose.ok_or_else(usage)?;
    let acquired_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Не удалось определить время для записи владельца.".to_owned())?
        .as_secs();
    let requested = ResourceClaim {
        resource_ref: resource_ref.clone(),
        principal_ref,
        session_ref: None,
        claim_id,
        purpose,
        acquired_at: format!("unix-seconds:{acquired_at}"),
        expires_at: None,
    };
    let outcome = claim::claim_recovering_intent(
        &authority,
        &resource_ref,
        Authorization::Authorized,
        requested,
    )
    .map_err(user_error)?;
    let status = match outcome {
        ClaimOutcome::Acquired => "acquired",
        ClaimOutcome::AlreadyOwned => "already_owned",
        ClaimOutcome::Busy => "busy",
    };
    Ok(json!({"status": status, "resource": descriptor.resource_ref()}))
}

struct Options {
    authority: PathBuf,
    resource: String,
    claim_id: Option<String>,
    purpose: Option<String>,
}

fn parse_options(args: &[String], claiming: bool) -> Result<Options, String> {
    let mut authority = None;
    let mut resource = None;
    let mut claim_id = None;
    let mut purpose = None;
    let mut index = 0;
    while index < args.len() {
        let key = args[index].as_str();
        let value = args.get(index + 1).filter(|value| !value.starts_with("--"));
        let Some(value) = value else {
            return Err(usage());
        };
        let slot = match key {
            "--authority" => &mut authority,
            "--resource" => &mut resource,
            "--claim-id" if claiming => &mut claim_id,
            "--purpose" if claiming => &mut purpose,
            _ => return Err(usage()),
        };
        if slot.replace(value.clone()).is_some() {
            return Err(usage());
        }
        index += 2;
    }
    Ok(Options {
        authority: PathBuf::from(authority.ok_or_else(usage)?),
        resource: resource.ok_or_else(usage)?,
        claim_id,
        purpose,
    })
}

fn load_authority(path: &Path) -> Result<StorageAuthority, String> {
    if !path.is_absolute() {
        return Err("Путь к authority должен быть абсолютным.".into());
    }
    let canonical = fs::canonicalize(path).map_err(|_| authority_unavailable())?;
    if canonical != path {
        return Err("Укажите канонический путь к файлу authority.".into());
    }
    let metadata = fs::metadata(&canonical).map_err(|_| authority_unavailable())?;
    if !metadata.is_file() {
        return Err("Файл authority недоступен.".into());
    }
    let bytes = fs::read(canonical).map_err(|_| authority_unavailable())?;
    serde_json::from_slice(&bytes).map_err(|_| authority_unavailable())
}

fn authorize_local_storage(authority: &StorageAuthority) -> io::Result<String> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;

        let effective_uid = fs::read_to_string("/proc/self/status")?
            .lines()
            .find_map(|line| {
                line.strip_prefix("Uid:")
                    .and_then(|values| values.split_whitespace().nth(1))
            })
            .and_then(|uid| uid.parse::<u32>().ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::PermissionDenied, "caller identity unavailable"))?;
        if !authority.root.is_absolute() || fs::canonicalize(&authority.root)? != authority.root {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "authority root must be canonical",
            ));
        }
        let metadata = fs::metadata(&authority.root)?;
        if !metadata.is_dir()
            || metadata.uid() != effective_uid
            || metadata.mode() & 0o022 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "caller does not own a private local authority",
            ));
        }
        return Ok(format!("linux-euid:{effective_uid}"));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = authority;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "offline ownership currently requires Linux OS identity",
        ))
    }
}

fn validate_owner_record(
    authority: &StorageAuthority,
    resource_ref: &ResourceRef,
    owner: &OwnerRecord,
) -> io::Result<()> {
    if owner.schema != authority.schema
        || owner.storage_id != authority.storage_id
        || owner.claim.resource_ref != *resource_ref
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "owner record identity does not match resource",
        ));
    }
    Ok(())
}

fn user_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::PermissionDenied => "Нет доступа к authority или ресурсу.".into(),
        io::ErrorKind::NotFound => "Ресурс не зарегистрирован или запись владельца отсутствует.".into(),
        io::ErrorKind::AlreadyExists => "Ресурс с такой идентичностью уже зарегистрирован.".into(),
        io::ErrorKind::WouldBlock => "Описание ресурса изменилось; перечитайте его и повторите.".into(),
        _ => "Не удалось проверить или изменить владение ресурсом.".into(),
    }
}

fn authority_unavailable() -> String {
    "Не удалось проверить файл authority.".into()
}

fn ownership_unavailable() -> String {
    "Состояние владельца повреждено или неизвестно; ресурс не считается свободным.".into()
}

fn usage() -> String {
    "Использование: herder ownership status --authority <absolute-path> --resource <ref> | herder ownership claim --authority <absolute-path> --resource <ref> --claim-id <uuid> --purpose <text>".into()
}
