use std::fs::{self, File, OpenOptions};
use std::path::Path;

const LOCK_FILE: &str = ".instance.lock";
const NIX_LAUNCHD_MARKER: &str = ".nix-launchd-managed";

pub struct InstanceLock {
    _file: File,
}

#[derive(Debug)]
pub enum InstanceLockError {
    AlreadyRunning,
    Io(std::io::Error),
}

impl std::fmt::Display for InstanceLockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning => formatter.write_str("another instance already owns the lock"),
            Self::Io(error) => write!(formatter, "could not acquire the instance lock: {error}"),
        }
    }
}

impl std::error::Error for InstanceLockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::AlreadyRunning => None,
            Self::Io(error) => Some(error),
        }
    }
}

pub fn acquire(app_data_dir: &Path) -> Result<InstanceLock, InstanceLockError> {
    fs::create_dir_all(app_data_dir).map_err(InstanceLockError::Io)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(app_data_dir.join(LOCK_FILE))
        .map_err(InstanceLockError::Io)?;

    match file.try_lock() {
        Ok(()) => Ok(InstanceLock { _file: file }),
        Err(std::fs::TryLockError::WouldBlock) => Err(InstanceLockError::AlreadyRunning),
        Err(std::fs::TryLockError::Error(error)) => Err(InstanceLockError::Io(error)),
    }
}

pub fn launchd_is_managed(app_data_dir: &Path) -> bool {
    std::env::var_os("SHIFTSHIFT_MANAGED_LAUNCHD").is_some()
        || app_data_dir.join(NIX_LAUNCHD_MARKER).is_file()
}

#[cfg(test)]
mod tests {
    use super::{acquire, launchd_is_managed, InstanceLockError};
    use std::fs;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    const CHILD_TEST: &str = "instance::tests::lock_holder_child_process";
    const CHILD_DIR_ENV: &str = "SHIFTSHIFT_INSTANCE_TEST_DIR";

    fn temp_app_data_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("shiftshift-instance-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn only_one_instance_can_hold_the_lock() {
        let app_data_dir = temp_app_data_dir();
        let first = acquire(&app_data_dir).expect("first instance should acquire the lock");

        assert!(matches!(
            acquire(&app_data_dir),
            Err(InstanceLockError::AlreadyRunning)
        ));

        drop(first);
        fs::remove_dir_all(app_data_dir).expect("temporary app data should be removed");
    }

    #[test]
    fn only_one_process_can_hold_the_lock() {
        let app_data_dir = temp_app_data_dir();
        fs::create_dir_all(&app_data_dir).expect("temporary app data should be created");
        let executable = std::env::current_exe().expect("test executable should be available");
        let mut child = Command::new(executable)
            .args(["--exact", CHILD_TEST, "--nocapture"])
            .env(CHILD_DIR_ENV, &app_data_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("lock holder process should start");
        let ready_file = app_data_dir.join(".child-ready");
        let release_file = app_data_dir.join(".child-release");
        let deadline = Instant::now() + Duration::from_secs(5);

        while !ready_file.exists() {
            if let Some(status) = child.try_wait().expect("child process should be checked") {
                panic!("lock holder process exited before acquiring the lock: {status}");
            }
            if Instant::now() >= deadline {
                child
                    .kill()
                    .expect("lock holder process should stop after timeout");
                child.wait().expect("lock holder process should be reaped");
                panic!("lock holder process did not acquire the lock in time");
            }
            thread::sleep(Duration::from_millis(10));
        }

        let second_lock = acquire(&app_data_dir);
        fs::write(&release_file, "release").expect("child process should be released");
        let child_status = child.wait().expect("lock holder process should exit");

        assert!(matches!(
            second_lock,
            Err(InstanceLockError::AlreadyRunning)
        ));
        assert!(child_status.success(), "lock holder process should pass");
        let next_process_lock =
            acquire(&app_data_dir).expect("lock should release when the owning process exits");
        drop(next_process_lock);
        fs::remove_dir_all(app_data_dir).expect("temporary app data should be removed");
    }

    #[test]
    fn lock_holder_child_process() {
        let Some(app_data_dir) = std::env::var_os(CHILD_DIR_ENV).map(std::path::PathBuf::from)
        else {
            return;
        };
        let _lock = acquire(&app_data_dir).expect("child process should acquire the lock");
        fs::write(app_data_dir.join(".child-ready"), "ready")
            .expect("parent process should be notified after lock acquisition");
        let deadline = Instant::now() + Duration::from_secs(10);

        while !app_data_dir.join(".child-release").exists() {
            assert!(
                Instant::now() < deadline,
                "parent process should release the lock"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn nix_marker_keeps_other_bundle_copies_from_managing_launchd() {
        let app_data_dir = temp_app_data_dir();
        fs::create_dir_all(&app_data_dir).expect("temporary app data should be created");
        fs::write(app_data_dir.join(".nix-launchd-managed"), "").expect("marker should be written");

        assert!(launchd_is_managed(&app_data_dir));

        fs::remove_dir_all(app_data_dir).expect("temporary app data should be removed");
    }
}
