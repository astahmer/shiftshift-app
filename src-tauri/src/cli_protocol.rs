//! Shared constant between the app's CLI listener (`cli_server.rs`) and the
//! standalone `shift` binary (`src/bin/shift.rs`). A loopback TCP port rather
//! than a Unix domain socket so the same code works on Windows too.

pub const PORT: u16 = 47811;
