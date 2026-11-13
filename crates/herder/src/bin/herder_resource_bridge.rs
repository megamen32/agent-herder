#[cfg(any(target_os = "linux", target_os = "macos"))]
fn main() {
    let mut args = std::env::args_os().skip(1);
    let path = match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(path), None) if flag == "--config" => std::path::PathBuf::from(path),
        _ => {
            println!("{{\"ok\":false,\"error\":\"invalid_request\"}}");
            std::process::exit(2)
        }
    };
    if herder::application::project_release_bridge::serve_json_lines(
        &path,
        std::io::stdin().lock(),
        std::io::stdout().lock(),
    )
    .is_err()
    {
        // A broken caller pipe must not clear durable execution occupancy.
        std::process::exit(1);
    }
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn main() {
    println!("{{\"ok\":false,\"error\":\"unsupported_platform\"}}");
    std::process::exit(2);
}
