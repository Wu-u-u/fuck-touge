use std::env;
use std::fs;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

fn main() {
    let path = env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        eprintln!("usage: ftstatus <state.status.json>");
        std::process::exit(2);
    });
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Err(e) = write_atomic(&path, &line) {
            eprintln!("ftstatus: {e}");
            std::process::exit(1);
        }
    }
}

fn write_atomic(path: &Path, text: &str) -> io::Result<()> {
    let tmp = path.with_extension("status.tmp");
    fs::write(&tmp, format!("{text}\n"))?;
    fs::rename(tmp, path)
}
