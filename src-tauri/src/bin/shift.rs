//! Standalone CLI: `shift some text` or `echo text | shift` captures an item
//! into a running shiftshift app over the loopback port in `cli_protocol.rs`.
//! Does not touch the SQLite file directly — the app must be running.

use std::io::{self, Read, Write};
use std::net::TcpStream;

use shiftshift_tauri_lib::cli_protocol::PORT;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let text = if args.is_empty() {
        let mut buf = String::new();
        if io::stdin().read_to_string(&mut buf).is_err() {
            eprintln!("shift: failed to read stdin");
            std::process::exit(1);
        }
        buf
    } else {
        args.join(" ")
    };

    if text.trim().is_empty() {
        eprintln!("shift: nothing to capture — pass text as arguments or pipe it in");
        std::process::exit(1);
    }

    match TcpStream::connect(("127.0.0.1", PORT)) {
        Ok(mut stream) => {
            if let Err(e) = stream
                .write_all(text.as_bytes())
                .and_then(|()| stream.write_all(b"\n"))
            {
                eprintln!("shift: failed to send capture: {e}");
                std::process::exit(1);
            }
        }
        Err(_) => {
            eprintln!(
                "shift: could not reach shiftshift on 127.0.0.1:{PORT} — is the app running?"
            );
            std::process::exit(1);
        }
    }
}
