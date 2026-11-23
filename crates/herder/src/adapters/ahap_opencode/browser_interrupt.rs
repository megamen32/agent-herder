use super::{AhapError, AhapOpenCode, ReceiptReference, valid_native_id};
use crate::{
    application::scoped_stop::{InterruptAttempt, mcp_stop::BrowserInputInterrupt},
    domain::address::SessionAddress,
};
use serde_json::{Value, json};

impl AhapOpenCode {
    /// Only the two configured native browser runners advertise this operation.
    pub fn supports_browser_interrupt(&self) -> bool {
        self.native_browser()
            && self
                .capabilities()
                .pointer("/controlCapabilities/cancelTurn")
                == Some(&Value::Bool(true))
            && self.client.supports("cancelTurn")
    }
}

fn valid_input(id: &str) -> bool {
    valid_native_id(id) && id.len() <= 256 && id.trim() == id
}

impl BrowserInputInterrupt for AhapOpenCode {
    fn input_message_id(&self, stored_native_id: &str) -> Option<String> {
        match ReceiptReference::decode(stored_native_id).ok()? {
            ReceiptReference::Message(id) if valid_input(&id) => Some(id),
            _ => None,
        }
    }

    fn interrupt_input(&self, target: &SessionAddress, input: &str) -> InterruptAttempt {
        use InterruptAttempt::*;
        if !self.supports_browser_interrupt()
            || !self.matches(target)
            || !valid_input(input)
            || target
                .native_session_id
                .split_once("::")
                .is_some_and(|(provider, _)| provider != self.policy.harness)
        {
            return DefinitelyNotSent;
        }
        let session = &target.native_session_id;
        match self
            .client
            .call("cancelTurn", json!({"id":session,"inputMessageId":input}))
        {
            Ok(reply)
                if reply["sessionId"].as_str() == Some(session)
                    && reply["inputMessageId"].as_str() == Some(input) =>
            {
                match reply["cancelled"].as_bool() {
                    Some(true) => Interrupted,
                    Some(false) => DefinitelyNotSent,
                    None => OutcomeUnknown,
                }
            }
            // Lazy init is read-only and must finish before cancelTurn is written.
            Err(
                AhapError::BeforeSend
                | AhapError::Unavailable
                | AhapError::Unsupported
                | AhapError::InvalidConfig
                | AhapError::Initialization { .. },
            ) => DefinitelyNotSent,
            _ => OutcomeUnknown,
        }
    }
}
