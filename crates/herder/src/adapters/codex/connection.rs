//! Own one Codex app-server process for one explicitly addressed instance.
//!
//! `CODEX_HOME` and `cwd` come from the selected instance. This module never
//! falls back to the operator's Codex profile or to another instance.

use std::{
    env,
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexInstance {
    pub instance_id: String,
    pub executable: PathBuf,
    pub code_home: PathBuf,
    pub cwd: PathBuf,
}

#[derive(Debug)]
pub enum OpenError {
    EmptyInstanceId,
    ExecutableNotAbsolute(PathBuf),
    DirectoryNotAbsolute { name: &'static str, path: PathBuf },
    DirectoryUnavailable { name: &'static str, path: PathBuf },
    Spawn(io::Error),
    PipeUnavailable(&'static str),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyInstanceId => write!(f, "Codex instance ID is empty"),
            Self::ExecutableNotAbsolute(path) => {
                write!(
                    f,
                    "Codex executable path must be absolute: {}",
                    path.display()
                )
            }
            Self::DirectoryNotAbsolute { name, path } => {
                write!(f, "Codex {name} path must be absolute: {}", path.display())
            }
            Self::DirectoryUnavailable { name, path } => {
                write!(
                    f,
                    "Codex {name} directory is unavailable: {}",
                    path.display()
                )
            }
            Self::Spawn(error) => write!(f, "could not start Codex app-server: {error}"),
            Self::PipeUnavailable(name) => write!(f, "Codex app-server {name} pipe unavailable"),
        }
    }
}

impl std::error::Error for OpenError {}

/// The child and both protocol pipes have one owner and one instance identity.
pub struct CodexConnection {
    instance_id: String,
    code_home: PathBuf,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
}

impl CodexConnection {
    /// Start the official app-server for exactly `instance`; no shared profile
    /// or inherited provider credentials are used.
    pub fn open(instance: CodexInstance) -> Result<Self, OpenError> {
        if instance.instance_id.trim().is_empty() {
            return Err(OpenError::EmptyInstanceId);
        }
        if !instance.executable.is_absolute() {
            return Err(OpenError::ExecutableNotAbsolute(instance.executable));
        }
        require_directory("CODEX_HOME", &instance.code_home)?;
        require_directory("working directory", &instance.cwd)?;

        let path = env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin"));
        let mut command = Command::new(&instance.executable);
        command
            .args(["app-server", "--stdio"])
            .current_dir(&instance.cwd)
            .env_clear()
            .env("PATH", path)
            .env("HOME", &instance.code_home)
            .env("CODEX_HOME", &instance.code_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        let mut child = command.spawn().map_err(OpenError::Spawn)?;
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OpenError::PipeUnavailable("stdin"));
            }
        };
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OpenError::PipeUnavailable("stdout"));
            }
        };
        Ok(Self {
            instance_id: instance.instance_id,
            code_home: instance.code_home,
            child,
            stdin: Some(stdin),
            stdout: Some(stdout),
        })
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn code_home(&self) -> &Path {
        &self.code_home
    }

    pub fn process_id(&self) -> u32 {
        self.child.id()
    }

    pub fn stdin(&mut self) -> &mut ChildStdin {
        self.stdin.as_mut().expect("connection input is open")
    }

    pub fn stdout(&mut self) -> &mut ChildStdout {
        self.stdout.as_mut().expect("connection output is open")
    }

    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }
}

impl Drop for CodexConnection {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn require_directory(name: &'static str, path: &Path) -> Result<(), OpenError> {
    if !path.is_absolute() {
        return Err(OpenError::DirectoryNotAbsolute {
            name,
            path: path.to_path_buf(),
        });
    }
    if !fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(OpenError::DirectoryUnavailable {
            name,
            path: path.to_path_buf(),
        });
    }
    Ok(())
}
