use chrono::Local;
use once_cell::sync::OnceCell;
use std::fs::{File, OpenOptions, create_dir_all};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

struct LlmLogger {
    dir: PathBuf,
    current: Mutex<Option<(String, File)>>,
}

static LOGGER: OnceCell<LlmLogger> = OnceCell::new();

pub fn init(dir: PathBuf) {
    let _ = create_dir_all(&dir);
    let _ = LOGGER.set(LlmLogger {
        dir,
        current: Mutex::new(None),
    });
}

pub fn write(line: &str) {
    let Some(logger) = LOGGER.get() else { return };
    let today = Local::now().format("%Y-%m-%d").to_string();
    let Ok(mut guard) = logger.current.lock() else { return };

    let needs_open = match guard.as_ref() {
        Some((d, _)) => d != &today,
        None => true,
    };
    if needs_open {
        let path = logger.dir.join(format!("llm-{today}.log"));
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => *guard = Some((today.clone(), file)),
            Err(_) => return,
        }
    }

    if let Some((_, ref mut file)) = guard.as_mut() {
        let ts = Local::now().format("%H:%M:%S%.3f");
        let _ = writeln!(file, "[{ts}] {line}");
        let _ = file.flush();
    }
}
