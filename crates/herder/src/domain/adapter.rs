//! Pure dispatch decisions and the boundary to a native session connection.
//!
//! A decision is based on a snapshot, not a lock: the application must recheck
//! the hold at admission and the native connection must enforce expected_turn.
use super::address::{Authorization, Availability, Capability, SessionAddress, Support};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterKind {
    Codex,
    OpenCode,
    ZCode,
    ChatGpt,
    Zai,
}

/// Static registry of concrete per-instance connections; no base adapter or plugin framework.
pub enum NativeAdapter<Codex, OpenCode, ZCode, ChatGpt, Zai> {
    Codex(Codex),
    OpenCode(OpenCode),
    ZCode(ZCode),
    ChatGpt(ChatGpt),
    Zai(Zai),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendMode {
    Current,
    Queue,
    Start,
}

impl SendMode {
    fn capability_name(self) -> &'static str {
        match self {
            Self::Current => "deliver.current",
            Self::Queue => "deliver.queue",
            Self::Start => "deliver.start",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionActivity {
    Idle,
    Busy { turn_id: String },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub address: SessionAddress,
    pub human_stop: bool,
    pub activity: SessionActivity,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SendCommand {
    pub mode: SendMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchPlan {
    pub target: SessionAddress,
    pub mode: SendMode,
    pub expected_turn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionError {
    Stopped,
    UnsupportedMode(SendMode),
    SupportUnknown(SendMode),
    Unavailable,
    AvailabilityUnknown,
    Denied,
    AuthorizationUnknown,
    ActivityUnknown,
    ModeRequiresBusy,
    ModeRequiresIdle,
    MissingTurnId,
}

/// Select exactly the requested mode; never downgrade or create a session.
pub fn decide_send(
    snapshot: &SessionSnapshot,
    command: &SendCommand,
) -> Result<DispatchPlan, DecisionError> {
    if snapshot.human_stop {
        return Err(DecisionError::Stopped);
    }
    let capability = snapshot
        .capabilities
        .iter()
        .find(|c| c.name == command.mode.capability_name())
        .ok_or(DecisionError::SupportUnknown(command.mode))?;
    match capability.supported {
        Support::Unsupported => return Err(DecisionError::UnsupportedMode(command.mode)),
        Support::Unknown => return Err(DecisionError::SupportUnknown(command.mode)),
        Support::Supported => {}
    }
    match capability.available {
        Availability::Unavailable => return Err(DecisionError::Unavailable),
        Availability::Unknown => return Err(DecisionError::AvailabilityUnknown),
        Availability::Available => {}
    }
    match capability.authorized {
        Authorization::Denied => return Err(DecisionError::Denied),
        Authorization::Unknown => return Err(DecisionError::AuthorizationUnknown),
        Authorization::Authorized => {}
    }
    let expected_turn = match (&snapshot.activity, command.mode) {
        (SessionActivity::Unknown, _) => return Err(DecisionError::ActivityUnknown),
        (SessionActivity::Idle, SendMode::Current) => return Err(DecisionError::ModeRequiresBusy),
        (SessionActivity::Busy { .. }, SendMode::Start) => {
            return Err(DecisionError::ModeRequiresIdle);
        }
        (SessionActivity::Busy { turn_id }, _) if turn_id.is_empty() => {
            return Err(DecisionError::MissingTurnId);
        }
        (SessionActivity::Busy { turn_id }, _) => Some(turn_id.clone()),
        (SessionActivity::Idle, _) => None,
    };
    Ok(DispatchPlan {
        target: snapshot.address.clone(),
        mode: command.mode,
        expected_turn,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestKey(pub String);

/// A native receipt identifies the exact admission for subsequent readback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeReceipt {
    pub target: SessionAddress,
    pub native_id: String,
}

/// Admission is not proof that the message is present in the native turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub receipt: NativeReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitError {
    /// The connection can prove that no native submission occurred.
    DefinitelyNotSent { reason: String },
    /// Submission may have happened; reconcile rather than sending again.
    OutcomeUnknown {
        receipt: Option<NativeReceipt>,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
    Confirmed { receipt: NativeReceipt },
    Rejected { receipt: NativeReceipt },
    Pending { receipt: NativeReceipt },
    Unknown { receipt: NativeReceipt },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadError(pub String);

/// Read-only adapters need not implement control operations.
#[allow(async_fn_in_trait)]
pub trait NativeSessionReader {
    async fn snapshot(&self, target: &SessionAddress) -> Result<SessionSnapshot, ReadError>;
    async fn reconcile(&self, receipt: &NativeReceipt) -> Result<Observation, ReadError>;
}

#[allow(async_fn_in_trait)]
pub trait NativeSessionControl {
    async fn submit(
        &self,
        plan: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::{CapabilityVersion, InstanceRef, NodeRef};
    use std::cell::Cell;

    fn address() -> SessionAddress {
        SessionAddress {
            instance: InstanceRef {
                node: NodeRef("node".into()),
                instance_id: "profile".into(),
            },
            native_session_id: "session".into(),
        }
    }
    fn snapshot(activity: SessionActivity) -> SessionSnapshot {
        SessionSnapshot {
            address: address(),
            human_stop: false,
            activity,
            capabilities: [SendMode::Current, SendMode::Queue, SendMode::Start]
                .into_iter()
                .map(|mode| Capability {
                    name: mode.capability_name().into(),
                    version: CapabilityVersion {
                        adapter_version: "1".into(),
                        capability_version: "1".into(),
                    },
                    supported: Support::Supported,
                    available: Availability::Available,
                    authorized: Authorization::Authorized,
                })
                .collect(),
        }
    }
    #[test]
    fn decisions_preserve_mode_target_and_turn_and_refuse_unsafe_states() {
        let cases = [
            (
                SessionActivity::Idle,
                SendMode::Current,
                Err(DecisionError::ModeRequiresBusy),
            ),
            (SessionActivity::Idle, SendMode::Start, Ok(None)),
            (SessionActivity::Idle, SendMode::Queue, Ok(None)),
            (
                SessionActivity::Busy {
                    turn_id: "t1".into(),
                },
                SendMode::Current,
                Ok(Some("t1".into())),
            ),
            (
                SessionActivity::Busy {
                    turn_id: "t1".into(),
                },
                SendMode::Queue,
                Ok(Some("t1".into())),
            ),
            (
                SessionActivity::Busy {
                    turn_id: "t1".into(),
                },
                SendMode::Start,
                Err(DecisionError::ModeRequiresIdle),
            ),
            (
                SessionActivity::Busy { turn_id: "".into() },
                SendMode::Current,
                Err(DecisionError::MissingTurnId),
            ),
            (
                SessionActivity::Unknown,
                SendMode::Queue,
                Err(DecisionError::ActivityUnknown),
            ),
        ];
        for (activity, mode, expected) in cases {
            let s = snapshot(activity);
            let actual = decide_send(&s, &SendCommand { mode });
            assert_eq!(
                actual,
                expected.map(|expected_turn| DispatchPlan {
                    target: s.address.clone(),
                    mode,
                    expected_turn
                })
            );
        }
        let mut s = snapshot(SessionActivity::Idle);
        s.human_stop = true;
        assert_eq!(
            decide_send(
                &s,
                &SendCommand {
                    mode: SendMode::Start
                }
            ),
            Err(DecisionError::Stopped)
        );
        s.human_stop = false;
        s.capabilities[2].supported = Support::Unsupported;
        assert_eq!(
            decide_send(
                &s,
                &SendCommand {
                    mode: SendMode::Start
                }
            ),
            Err(DecisionError::UnsupportedMode(SendMode::Start))
        );
        s.capabilities[2].supported = Support::Supported;
        s.capabilities[2].available = Availability::Unavailable;
        assert_eq!(
            decide_send(
                &s,
                &SendCommand {
                    mode: SendMode::Start
                }
            ),
            Err(DecisionError::Unavailable)
        );
        s.capabilities[2].available = Availability::Available;
        s.capabilities[2].authorized = Authorization::Denied;
        assert_eq!(
            decide_send(
                &s,
                &SendCommand {
                    mode: SendMode::Start
                }
            ),
            Err(DecisionError::Denied)
        );
    }

    struct FakeControl {
        written: Cell<usize>,
        fail_after_write: bool,
    }
    impl NativeSessionControl for FakeControl {
        async fn submit(
            &self,
            plan: DispatchPlan,
            _message: &str,
            _key: &RequestKey,
        ) -> Result<Admission, SubmitError> {
            if !self.fail_after_write {
                return Err(SubmitError::DefinitelyNotSent {
                    reason: "connection unavailable".into(),
                });
            }
            self.written.set(self.written.get() + 1);
            Err(SubmitError::OutcomeUnknown {
                receipt: Some(NativeReceipt {
                    target: plan.target,
                    native_id: "receipt".into(),
                }),
                reason: "connection lost after write".into(),
            })
        }
    }
    #[tokio::test]
    async fn fake_submit_distinguishes_never_sent_from_unknown_after_write() {
        let plan = decide_send(
            &snapshot(SessionActivity::Idle),
            &SendCommand {
                mode: SendMode::Start,
            },
        )
        .unwrap();
        let before = FakeControl {
            written: Cell::new(0),
            fail_after_write: false,
        };
        assert!(matches!(
            before
                .submit(plan.clone(), "hello", &RequestKey("key".into()))
                .await,
            Err(SubmitError::DefinitelyNotSent { .. })
        ));
        assert_eq!(before.written.get(), 0);
        let after = FakeControl {
            written: Cell::new(0),
            fail_after_write: true,
        };
        assert!(matches!(
            after.submit(plan, "hello", &RequestKey("key".into())).await,
            Err(SubmitError::OutcomeUnknown {
                receipt: Some(_),
                ..
            })
        ));
        assert_eq!(after.written.get(), 1);
    }
}
