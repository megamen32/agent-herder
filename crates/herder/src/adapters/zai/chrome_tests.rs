use super::*;
use crate::adapters::browser::{BrowserActivity, BrowserSubmitError};
use serde_json::json;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};

const OLD: &str = "aaaa000000000001";
const FRESH: &str = "bbbb000000000002";
const TEXT: &str = "same text";

struct Chrome(Child);

impl Drop for Chrome {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        let _ = self.0.wait();
    }
}

async fn fixture(args: &[&str]) -> (Chrome, ZaiReader) {
    let mut chrome = Chrome(
        Command::new("node")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/adapters/zai/chrome_fixture.mjs"
            ))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start local Z.ai Chrome fixture"),
    );
    let mut line = String::new();
    BufReader::new(chrome.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let info: Value = serde_json::from_str(&line).expect("fixture CDP endpoint and context");
    let scope: String = Sha256::digest(b"fixture-account")
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let reader = ZaiReader::create_new_chat(
        info["endpoint"].as_str().unwrap(),
        "fixture-node",
        "fixture-instance",
        info["browserContextId"].as_str().unwrap(),
        &scope,
        Some(9222),
    )
    .await
    .unwrap();
    (chrome, reader)
}

async fn page(reader: &mut ZaiReader, expression: &str) -> Value {
    reader.connection_mut().evaluate(expression).await.unwrap()
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn native_empty_list_needs_its_own_auth_proof() {
    let (_chrome, mut reader) = fixture(&[]).await;
    assert_eq!(reader.list_native_ids(10).await.unwrap(), [OLD]);
    page(&mut reader, "fixture.owner = 'another-owner'").await;
    assert_eq!(
        reader.list_native_ids(10).await,
        Err(ZaiReadError::AccountMismatch)
    );

    page(&mut reader, "fixture.messages = {}; fixture.calls = []").await;
    assert_eq!(
        reader.list_chats().await,
        Err(ZaiReadError::AccountMismatch)
    );
    assert_eq!(
        page(&mut reader, "fixture.calls.splice(0)").await,
        json!(["/api/v1/chats/"])
    );
    assert!(reader.list_native_ids(10).await.unwrap().is_empty());
    assert_eq!(
        page(&mut reader, "fixture.calls.splice(0)").await,
        json!(["/api/v1/chats/", "/api/v1/auths/"])
    );
    page(&mut reader, "fixture.mode = 'switch-on-list'").await;
    assert_eq!(
        reader.list_native_ids(10).await,
        Err(ZaiReadError::AccountMismatch)
    );
    page(&mut reader, "fixture.mode = ''; fixture.user = null").await;
    assert_eq!(
        reader.list_native_ids(0).await,
        Err(ZaiReadError::AccountMismatch)
    );
    page(&mut reader, "fixture.authStatus = 401").await;
    assert!(reader.list_native_ids(10).await.is_err());
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn draft_route_and_pending_files_are_checked_before_send() {
    use BrowserSubmitError::BeforeSend;
    let (_chrome, mut reader) = fixture(&[]).await;
    assert_eq!(
        reader.submit_message(Some(OLD), TEXT).await,
        Err(BeforeSend)
    );
    page(
        &mut reader,
        "document.querySelector('textarea').value = 'my draft'",
    )
    .await;
    assert_eq!(reader.submit_message(None, TEXT).await, Err(BeforeSend));
    assert_eq!(
        page(&mut reader, "document.querySelector('textarea').value").await,
        "my draft"
    );
    page(&mut reader, r#"
        document.querySelector('textarea').value = '';
        document.querySelector('textarea').insertAdjacentHTML('beforebegin',
          '<input type="file"><div data-file-chip>notes.txt <button aria-label="Remove file">×</button></div>');
    "#).await;
    assert_eq!(
        page(&mut reader, "document.querySelector('input').files.length").await,
        0
    );
    assert_eq!(reader.submit_message(None, TEXT).await, Err(BeforeSend));
    assert_eq!(
        page(&mut reader, "[fixture.input, fixture.clicks]").await,
        json!([0, 0])
    );

    page(
        &mut reader,
        "document.querySelector('[data-file-chip]').remove()",
    )
    .await;
    reader.open_conversation(OLD).await.unwrap();
    // The site can change the route or draft while handling the native input event.
    for change in [
        "history.replaceState({}, '', '/c/' + fixture.fresh)",
        "event.target.value = 'new draft'",
        "event.target.insertAdjacentHTML('beforebegin', '<span class=file-chip>notes.txt</span>')",
    ] {
        page(&mut reader, &format!("document.querySelector('textarea').addEventListener('input', event => {{ {change} }}, {{once:true}})")).await;
        assert_eq!(
            reader.submit_message(Some(OLD), TEXT).await,
            Err(BeforeSend),
            "{change}"
        );
        assert_eq!(page(&mut reader, "fixture.clicks").await, 0);
        page(&mut reader, "history.replaceState({}, '', '/c/' + fixture.old); document.querySelector('textarea').value = ''").await;
    }
    assert_eq!(page(&mut reader, "fixture.input").await, 3);
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn first_send_and_continuation_return_exact_new_user_ids() {
    let (_chrome, mut reader) = fixture(&[]).await;
    assert_eq!(
        reader.submit_message(None, TEXT).await.unwrap(),
        (FRESH.into(), "user-1".into())
    );
    assert_eq!(
        reader.submit_message(Some(FRESH), TEXT).await.unwrap(),
        (FRESH.into(), "user-2".into())
    );
    let messages = reader.read_chat(FRESH).await.unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|m| (m.id.as_str(), m.text.as_str()))
            .collect::<Vec<_>>(),
        [("user-1", TEXT), ("user-2", TEXT)]
    );
    assert_eq!(reader.read_chat(OLD).await.unwrap()[0].id, "old-user");
    page(&mut reader, "fixture.duplicate = true").await;
    assert_eq!(
        reader.submit_message(Some(FRESH), TEXT).await,
        Err(BrowserSubmitError::Unknown)
    );
    assert_eq!(page(&mut reader, "fixture.clicks").await, 3);
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn uncertain_first_click_is_never_repeated() {
    let (_chrome, mut reader) = fixture(&[]).await;
    page(&mut reader, "fixture.mode = 'no-write'").await;
    assert_eq!(
        reader.submit_message(None, TEXT).await,
        Err(BrowserSubmitError::Unknown)
    );
    assert_eq!(
        reader.submit_message(None, TEXT).await,
        Err(BrowserSubmitError::BeforeSend)
    );
    assert_eq!(
        page(&mut reader, "[fixture.input, fixture.clicks]").await,
        json!([1, 1])
    );
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn activity_open_and_read_check_provider_identity() {
    let (_chrome, mut reader) = fixture(&[]).await;
    assert_eq!(
        reader.session_activity(OLD).await.unwrap(),
        BrowserActivity::Unknown
    );
    page(&mut reader, "fixture.status = 'running'").await;
    assert_eq!(
        reader.session_activity(OLD).await.unwrap(),
        BrowserActivity::Busy
    );
    page(
        &mut reader,
        "fixture.listOwner = true; fixture.owner = 'other-account'",
    )
    .await;
    assert_eq!(
        reader.session_activity(OLD).await,
        Err(ZaiReadError::AccountMismatch)
    );
    page(
        &mut reader,
        "fixture.owner = fixture.user; fixture.status = 'completed'",
    )
    .await;
    assert_eq!(
        reader.session_activity(OLD).await.unwrap(),
        BrowserActivity::Idle
    );
    page(&mut reader, "fixture.mode = 'redirect'").await;
    assert!(reader.open_conversation(OLD).await.is_err());
    assert_eq!(
        reader.submit_message(Some(OLD), TEXT).await,
        Err(BrowserSubmitError::BeforeSend)
    );
    page(&mut reader, "fixture.wrongBatch = true").await;
    assert_eq!(
        reader.read_chat(OLD).await,
        Err(ZaiReadError::InvalidResponse)
    );
    page(
        &mut reader,
        "fixture.wrongBatch = false; fixture.messages[fixture.old]['old-user'].id = 'another-id'",
    )
    .await;
    assert_eq!(
        reader.read_chat(OLD).await,
        Err(ZaiReadError::InvalidResponse)
    );
    page(&mut reader, "fixture.messages[fixture.old]['old-user'].id = 'old-user'; fixture.mode = 'switch-after-read'").await;
    assert_eq!(
        reader.read_chat(OLD).await,
        Err(ZaiReadError::AccountMismatch)
    );
    assert_eq!(page(&mut reader, "fixture.clicks").await, 0);
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn new_blank_waits_for_the_editor_before_first_send_or_offscreen_open() {
    for target in [None, Some(OLD)] {
        let (_chrome, mut reader) = fixture(&["--delayed-render"]).await;
        assert_eq!(
            page(
                &mut reader,
                "[location.href, !!document.querySelector('textarea')]"
            )
            .await,
            json!(["https://chat.z.ai/", false])
        );
        // Start rendering only after the adapter has observed the unmounted page.
        page(&mut reader, "fixture.afterAuth = () => { delete fixture.afterAuth; setTimeout(fixture.render, 150) }").await;
        if let Some(id) = target {
            reader.open_conversation(id).await.unwrap();
            assert_eq!(
                page(
                    &mut reader,
                    "[fixture.navigations, fixture.input, fixture.clicks]"
                )
                .await,
                json!([1, 0, 0])
            );
        }
        assert_eq!(
            reader.submit_message(target, TEXT).await.unwrap(),
            (target.unwrap_or(FRESH).into(), "user-1".into())
        );
        assert_eq!(
            page(&mut reader, "[fixture.input, fixture.clicks]").await,
            json!([1, 1])
        );
    }
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn hydration_refuses_foreign_content_and_account_and_has_a_deadline() {
    let (_chrome, mut reader) = fixture(&["--delayed-render"]).await;
    page(&mut reader, "fixture.calls = []; fixture.afterAuth = () => { document.body.innerHTML = '<article class=user-message>existing</article>'; delete fixture.afterAuth }").await;
    assert_eq!(
        reader.open_conversation(OLD).await,
        Err(ZaiReadError::InvalidResponse)
    );
    assert_eq!(
        page(&mut reader, "fixture.calls.splice(0)").await,
        json!(["/api/v1/auths/"])
    );
    page(&mut reader, "document.body.replaceChildren(); fixture.afterAuth = () => { fixture.user = 'other-account'; delete fixture.afterAuth }").await;
    assert_eq!(
        reader.open_conversation(OLD).await,
        Err(ZaiReadError::AccountMismatch)
    );
    assert_eq!(
        page(&mut reader, "fixture.calls.splice(0)").await,
        json!(["/api/v1/auths/", "/api/v1/auths/"])
    );
    page(
        &mut reader,
        "fixture.user = fixture.owner; history.replaceState({}, '', '/c/' + fixture.old)",
    )
    .await;
    assert_eq!(
        reader.submit_message(Some(OLD), TEXT).await,
        Err(BrowserSubmitError::BeforeSend)
    );
    assert_eq!(page(&mut reader, "fixture.calls.length").await, 0);
    page(&mut reader, "history.replaceState({}, '', '/')").await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(6), reader.submit_message(None, TEXT))
            .await
            .unwrap(),
        Err(BrowserSubmitError::BeforeSend)
    );
    assert_eq!(
        page(
            &mut reader,
            "[fixture.input, fixture.clicks, fixture.navigations]"
        )
        .await,
        json!([0, 0, 0])
    );
}
