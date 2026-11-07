//! Native create port for one explicitly selected Codex instance.
//!
//! Codex `thread/start` has no request-key or idempotency field. The request
//! key is therefore bound only to this invocation; if its native response is
//! uncertain, this adapter returns `Unknown` and never repeats the operation.

use std::{path::PathBuf, time::Duration};

use crate::{
    application::target::{NativeCreateControl, NativeCreateOutcome},
    domain::address::{InstanceRef, SessionAddress},
};

use super::{connection::CodexInstance, control::CodexControl};

/// Create threads on exactly the Codex process/profile and cwd supplied here.
pub struct CodexCreateControl {
    control: CodexControl,
    cwd: PathBuf,
}

impl CodexCreateControl {
    pub fn open(
        process: CodexInstance,
        instance: InstanceRef,
        timeout: Duration,
    ) -> Result<Self, super::control::CodexControlOpenError> {
        let cwd = process.cwd.clone();
        let control = CodexControl::open(process, instance, timeout)?;
        Ok(Self { control, cwd })
    }

    /// Reuse the same instance-bound connection for other native control ports.
    pub fn native_control(&self) -> &CodexControl {
        &self.control
    }
}

impl NativeCreateControl for CodexCreateControl {
    fn instance(&self) -> &InstanceRef {
        self.control.instance()
    }

    /// Codex thread/start creates a blank session and has no specification
    /// field. The specification remains bound in the core intent; this port
    /// never guesses that it should become an initial user message.
    async fn create_once(&self, request_key: &str, _specification: &str) -> NativeCreateOutcome {
        if request_key.is_empty() || request_key.len() > 4096 {
            return NativeCreateOutcome::Unknown;
        }
        let Some(cwd) = self.cwd.to_str() else {
            return NativeCreateOutcome::Unknown;
        };

        let address: SessionAddress = match self.control.start_thread(cwd) {
            Ok(address) => address,
            Err(_) => return NativeCreateOutcome::Unknown,
        };
        if address.instance != *self.control.instance()
            || address.native_session_id.is_empty()
            || address.native_session_id.len() > 4096
            || address.native_session_id.chars().any(char::is_control)
        {
            return NativeCreateOutcome::Unknown;
        }

        NativeCreateOutcome::Confirmed {
            request_key: request_key.to_owned(),
            instance: address.instance,
            native_session_id: address.native_session_id,
            parent_ref: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::target::{NativeCreateControl, NativeCreateOutcome},
        domain::address::NodeRef,
    };
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicU64, Ordering},
    };

    fn fake_create_control(slow_start: bool, timeout: Duration) -> (CodexCreateControl, PathBuf) {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.tmp")
            .join(format!(
                "codex-create-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        let home = root.join("home");
        let cwd = root.join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let executable = root.join("fake-codex");
        let delay = if slow_start { "time.sleep(1)" } else { "pass" };
        fs::write(
            &executable,
            format!(
                "#!/usr/bin/python3\nimport json, os, sys, time\nfor line in sys.stdin:\n r=json.loads(line)\n if 'id' not in r: continue\n m=r['method']\n with open(os.path.join(os.environ['CODEX_HOME'],'methods'),'a') as f: f.write(m+'\\n')\n if m == 'initialize': result={{'codexHome':os.path.realpath(os.environ['CODEX_HOME'])}}\n elif m == 'thread/start': {delay}; result={{'thread':{{'id':'native-thread'}}}}\n else: result={{}}\n print(json.dumps({{'id':r['id'],'result':result}}),flush=True)\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let instance = InstanceRef {
            node: NodeRef("codex-create-test-node".into()),
            instance_id: format!("codex-create-test-{}", NEXT.load(Ordering::Relaxed)),
        };
        let control = CodexCreateControl::open(
            CodexInstance {
                instance_id: instance.instance_id.clone(),
                executable,
                code_home: home,
                cwd,
            },
            instance,
            timeout,
        )
        .unwrap();
        (control, root)
    }

    #[tokio::test]
    async fn confirms_exact_native_thread_and_request_binding() {
        let (control, root) = fake_create_control(false, Duration::from_secs(2));
        let expected_instance = control.instance().clone();
        let outcome = control.create_once("create-key-1", "specification").await;
        assert!(matches!(
            outcome,
            NativeCreateOutcome::Confirmed {
                request_key,
                instance,
                native_session_id,
                parent_ref: None,
            } if request_key == "create-key-1"
                && instance == expected_instance
                && native_session_id == "native-thread"
        ));
        let methods = fs::read_to_string(root.join("home/methods")).unwrap();
        assert_eq!(
            methods.lines().collect::<Vec<_>>(),
            ["initialize", "thread/start"]
        );
        drop(control);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn timeout_is_unknown_and_thread_start_is_not_repeated() {
        let (control, root) = fake_create_control(true, Duration::from_millis(100));
        let outcome = control.create_once("create-key-2", "specification").await;
        assert!(matches!(outcome, NativeCreateOutcome::Unknown));
        let methods = fs::read_to_string(root.join("home/methods")).unwrap();
        assert_eq!(
            methods.lines().collect::<Vec<_>>(),
            ["initialize", "thread/start"]
        );
        drop(control);
        let _ = fs::remove_dir_all(root);
    }
}
