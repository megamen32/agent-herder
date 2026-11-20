use crate::{
    application::{
        reconcile::{ReceiptBinding, StoredReceipt, load_native_receipt},
        scoped_stop::{GateError, InterruptAttempt, InterruptDisposition, create_prompt},
    },
    auth::identity::PrincipalId,
    domain::address::SessionAddress,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::json;

/// An instance-bound browser port. The receipt codec belongs to the adapter.
pub trait BrowserInputInterrupt: Send + Sync {
    fn input_message_id(&self, stored_native_id: &str) -> Option<String>;
    fn interrupt_input(&self, address: &SessionAddress, input_message_id: &str)
    -> InterruptAttempt;
}

pub(super) enum BrowserStop {
    Recorded(InterruptDisposition),
    Reserved { intent: String, input: String },
}

/// Called inside the hold transaction under the pinned handoff gate.
pub(super) fn reserve(
    tx: &Transaction<'_>,
    control: &dyn BrowserInputInterrupt,
    session: &str,
    address: &SessionAddress,
    generation: &str,
    principal: &str,
    stop_key: &str,
    now: &str,
) -> Result<BrowserStop, GateError> {
    use BrowserStop::Recorded;
    use InterruptDisposition::*;

    // Dispatch claims for a session are serialized. Reconciliation can update an
    // older intent long after a later handoff. Only receipt-only legacy deliveries
    // need intent insertion order as a fallback. A newer possible handoff with no
    // usable receipt (including another principal's input) blocks older receipts.
    let latest: Option<(String, String, String, Option<String>)> = tx
        .query_row(
            "WITH candidates AS (
            SELECT i.intent_id,i.request_key,i.principal,i.rowid AS intent_order,
                   d.scope_generation,d.rowid AS dispatch_order
            FROM intents i LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id
            WHERE i.target=?1 AND i.state IN ('dispatching','admitted','confirmed','unknown')
              AND (d.phase IN ('handing_off','finished')
                   OR (d.intent_id IS NULL AND i.payload_hash LIKE 'sha256-dispatch-v1:%'))
         )
         SELECT intent_id,request_key,principal,scope_generation FROM candidates
         WHERE dispatch_order IS NULL OR dispatch_order=(SELECT max(dispatch_order) FROM candidates)
         ORDER BY intent_order DESC LIMIT 1",
            [session],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(|_| GateError::Store)?;
    // Pin the stop key even if the first call only established a hold. A
    // delayed retry after release must not target a newly arrived input.
    let key_scope = json!(["browser-input-stop", principal, session]).to_string();
    let bound_intent = json!(latest.as_ref().map(|(intent, _, _, _)| intent)).to_string();
    tx.execute(
        "INSERT INTO settings(scope,setting_key,value_json,revision,updated_at) VALUES(?1,?2,?3,1,?4)
         ON CONFLICT(scope,setting_key) DO NOTHING",
        params![key_scope, stop_key, bound_intent, now],
    ).map_err(|_| GateError::Store)?;
    let (same, originally_empty): (bool, bool) = tx
        .query_row(
            "SELECT value_json=?3,value_json='null' FROM settings WHERE scope=?1 AND setting_key=?2",
            params![key_scope, stop_key, bound_intent],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| GateError::Store)?;
    if !same {
        // An old stop may have reached the browser, even though this retry
        // cannot address the new input. Preserve that uncertainty.
        return Ok(Recorded(if originally_empty {
            InterruptNotSent
        } else {
            InterruptUnknown
        }));
    }
    let Some((intent, delivery_key, sender, scope)) = latest else {
        return Ok(Recorded(HeldBeforeHandoff));
    };
    if sender != principal || scope.as_deref().is_some_and(|scope| scope != generation) {
        return Ok(Recorded(InterruptUnknown));
    }
    // The public create key also identifies its separately admitted first prompt.
    let (prompt_key, _, _) = create_prompt::delivery_identifiers(
        &PrincipalId(principal.to_owned()),
        &address.instance,
        stop_key,
    )?;
    let stale: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM intents WHERE target=?1 AND principal=?2
                       AND request_key IN (?3,?4) AND intent_id<>?5)",
            params![session, principal, stop_key, prompt_key, intent],
            |row| row.get(0),
        )
        .map_err(|_| GateError::Store)?;
    if stale {
        return Ok(Recorded(InterruptNotSent));
    }
    let binding = ReceiptBinding {
        intent_id: &intent,
        principal,
        target_ref: session,
        request_key: &delivery_key,
        address,
    };
    let StoredReceipt::Found(receipt) =
        load_native_receipt(tx, &binding).map_err(|_| GateError::Store)?
    else {
        return Ok(Recorded(InterruptUnknown));
    };
    let Some(input) = control.input_message_id(&receipt.native_id) else {
        return Ok(Recorded(InterruptUnknown));
    };
    // Use the provider's input ID in the existing unique interrupt fence. Old
    // plain-message receipts and current typed receipts name the same effect.
    let previous: Option<(String, String, String)> = tx
        .query_row(
            "SELECT session_ref,native_turn_id,state FROM humanstop_interrupts
         WHERE intent_id=?1 OR (session_ref=?2 AND native_turn_id=?3)",
            params![intent, session, input],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| GateError::Store)?;
    if let Some((previous_session, previous_input, state)) = previous {
        return Ok(Recorded(match state.as_str() {
            "acknowledged" if previous_session == session && previous_input == input => {
                InterruptAcknowledged
            }
            "not_sent" if previous_session == session && previous_input == input => {
                InterruptNotSent
            }
            _ => InterruptUnknown,
        }));
    }
    tx.execute(
        "INSERT INTO humanstop_interrupts(intent_id,session_ref,native_turn_id,state,updated_at)
         VALUES(?1,?2,?3,'dispatching',?4)",
        params![intent, session, input, now],
    )
    .map_err(|_| GateError::Store)?;
    Ok(BrowserStop::Reserved { intent, input })
}

impl BrowserStop {
    pub(super) fn finish(
        self,
        db: &Connection,
        control: &dyn BrowserInputInterrupt,
        address: &SessionAddress,
        now: &str,
    ) -> Result<InterruptDisposition, GateError> {
        let (intent, input) = match self {
            Self::Recorded(disposition) => return Ok(disposition),
            Self::Reserved { intent, input } => (intent, input),
        };
        let (state, disposition) = match control.interrupt_input(address, &input) {
            InterruptAttempt::Interrupted => {
                ("acknowledged", InterruptDisposition::InterruptAcknowledged)
            }
            InterruptAttempt::DefinitelyNotSent => {
                ("not_sent", InterruptDisposition::InterruptNotSent)
            }
            InterruptAttempt::OutcomeUnknown => ("unknown", InterruptDisposition::InterruptUnknown),
        };
        let updated = db.execute(
            "UPDATE humanstop_interrupts SET state=?2,updated_at=?3 WHERE intent_id=?1 AND state='dispatching'",
            params![intent, state, now],
        ).map_err(|_| GateError::Store)?;
        if updated != 1 {
            return Err(GateError::Store);
        }
        Ok(disposition)
    }
}
