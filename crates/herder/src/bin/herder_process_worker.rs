#[cfg(target_os = "linux")]
fn main() {
    let mut store = None;
    let mut execution = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--store") if store.is_none() => store = args.next().map(std::path::PathBuf::from),
            Some("--execution") if execution.is_none() => execution = args.next().and_then(|v| v.into_string().ok()),
            _ => { eprintln!("usage: herder_process_worker --store ABSOLUTE_PATH --execution EXECUTION_REF"); std::process::exit(2); }
        }
    }
    let (Some(store), Some(execution)) = (store, execution) else {
        eprintln!("usage: herder_process_worker --store ABSOLUTE_PATH --execution EXECUTION_REF");
        std::process::exit(2);
    };
    let result = herder::process::ExecutionStore::from_existing_root(store)
        .and_then(|store| {
            let record=store.status(&execution)?.record;
            let mut hooks=herder::application::process_bindings::BindingHooks::new(&store,&execution,&record.principal_ref)?;
            herder::process::run_worker_with_hooks(&store,&execution,&mut hooks)
        });
    if let Err(error) = result {
        eprintln!("Herder execution worker failed: {error}");
        std::process::exit(1);
    }
}
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("Herder process worker currently requires the verified Linux executor");
    std::process::exit(2);
}
