#[cfg(any(target_os = "linux", target_os = "macos"))]
fn main() {
    let mut store = None;
    let mut execution = None;
    let mut remote_config = None;
    let mut config_sha256 = None;
    let mut request = None;
    let mut deadline_watchdog = false;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--remote-config") if remote_config.is_none() => remote_config=args.next().map(std::path::PathBuf::from),
            Some("--config-sha256") if config_sha256.is_none() => config_sha256=args.next().and_then(|v|v.into_string().ok()),
            Some("--request") if request.is_none() => request=args.next().and_then(|v|v.into_string().ok()),
            Some("--deadline-watchdog") if !deadline_watchdog => deadline_watchdog=true,
            Some("--store") if store.is_none() => store = args.next().map(std::path::PathBuf::from),
            Some("--execution") if execution.is_none() => {
                execution = args.next().and_then(|v| v.into_string().ok())
            }
            _ => {
                eprintln!(
                    "usage: herder_process_worker --store ABSOLUTE_PATH --execution EXECUTION_REF"
                );
                std::process::exit(2);
            }
        }
    }
    if remote_config.is_some() || config_sha256.is_some() || request.is_some() {
        let result=(|| {
            if store.is_some() || execution.is_some() || deadline_watchdog {
                return Err(std::io::Error::other("invalid internal remote invocation"));
            }
            let config=remote_config.ok_or_else(||std::io::Error::other("missing remote config"))?;
            let digest=config_sha256.ok_or_else(||std::io::Error::other("missing config digest"))?;
            let request=request.ok_or_else(||std::io::Error::other("missing remote request"))?;
            herder::process::remote_endpoint(&config,&digest,request.as_bytes())
        })();
        match result {
            Ok(response)=>match serde_json::to_string(&response) {
                Ok(line)=>println!("{line}"),Err(_)=>std::process::exit(1),
            },
            Err(_)=>{eprintln!("remote_process_endpoint_failed");std::process::exit(1);}
        }
        return;
    }
    let (Some(store), Some(execution)) = (store, execution) else {
        eprintln!("usage: herder_process_worker --store ABSOLUTE_PATH --execution EXECUTION_REF");
        std::process::exit(2);
    };
    let result = herder::process::ExecutionStore::from_existing_root(store).and_then(|store| {
        if deadline_watchdog {
            herder::process::run_deadline_watchdog(&store,&execution)?;
            return Ok(herder::process::WorkerOutcome::Completed);
        }
        let record = store.status(&execution)?.record;
        let mut hooks = herder::application::process_bindings::BindingHooks::new(
            &store,
            &execution,
            &record.principal_ref,
        )?;
        herder::process::run_worker_with_hooks(&store, &execution, &mut hooks)
    });
    if let Err(error) = result {
        eprintln!("Herder execution worker failed: {error}");
        std::process::exit(1);
    }
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn main() {
    eprintln!("Herder process worker currently requires a verified Linux or macOS executor");
    std::process::exit(2);
}
