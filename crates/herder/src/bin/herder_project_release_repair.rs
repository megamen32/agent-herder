#[cfg(target_os = "linux")]
fn main() {
    let mut args = std::env::args_os().skip(1);
    let path = match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(path), None) if flag == "--config" => std::path::PathBuf::from(path),
        _ => {
            println!("{{\"ok\":false,\"error\":\"invalid_request\"}}");
            std::process::exit(2);
        }
    };
    match herder::application::project_release_bridge::reconcile::repair::serve_once(
        &path,
        std::io::stdin().lock(),
        std::io::stdout().lock(),
    ) {
        Ok(true) => (),
        Ok(false) => std::process::exit(2),
        Err(_) => std::process::exit(1),
    }
}
#[cfg(not(target_os = "linux"))]
fn main() {
    println!("{{\"ok\":false,\"error\":\"unsupported_platform\"}}");
    std::process::exit(2);
}
