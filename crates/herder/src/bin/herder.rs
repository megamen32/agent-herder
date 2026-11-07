use herder::cli::ownership;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.split_first() {
        Some((command, rest)) if command == "ownership" => ownership::execute(rest),
        _ => Err("Использование: herder ownership status|claim ...".to_owned()),
    };
    match result {
        Ok(value) => println!("{}", serde_json::to_string(&value).expect("JSON serialization")),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}
