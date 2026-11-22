use super::*;
use crate::adapters::browser::{BrowserActivity, BrowserAttachment, BrowserSubmitError};
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

fn file(name: &str, mime_type: &str, data_base64: &str) -> BrowserAttachment {
    BrowserAttachment {
        name: name.into(),
        mime_type: mime_type.into(),
        data_base64: data_base64.into(),
    }
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn captioned_uploads_and_attachment_only_history_keep_their_originals_scoped() {
    let (_chrome, mut reader) = fixture(&[]).await;
    let files = [
        file("снимок & 1.png", "image/png", "iVBORw0KGgo="),
        file("original.bin", "application/octet-stream", "APEJ/w=="),
    ];
    let operations = "[fixture.calls.length, fixture.uploads, fixture.input, fixture.clicks, fixture.navigations]";
    let before = page(&mut reader, operations).await;
    assert_eq!(
        reader.submit_with_attachments(None, " \n", &files).await,
        Err(BrowserSubmitError::BeforeSend)
    );
    assert_eq!(page(&mut reader, operations).await, before);
    let caption = "Two files";
    let (chat, mid) = reader
        .submit_with_attachments(None, caption, &files)
        .await
        .unwrap();
    let rows = reader.read_chat(&chat).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, mid);
    assert_eq!(rows[0].text, caption);
    assert_eq!(rows[0].attachments.len(), 2);
    for (meta, original) in rows[0].attachments.iter().zip(&files) {
        assert_eq!(
            (&meta.name, &meta.mime_type),
            (&original.name, &original.mime_type)
        );
        assert_eq!(
            reader.read_attachment(&chat, &mid, &meta.id).await.unwrap(),
            *original
        );
    }
    page(&mut reader, "fixture.mode = 'generic-image'").await;
    let (_, image_mid) = reader
        .submit_with_attachments(Some(&chat), "image", &files[..1])
        .await
        .unwrap();
    let image = reader
        .read_chat(&chat)
        .await
        .unwrap()
        .pop()
        .unwrap()
        .attachments
        .remove(0);
    assert!(image.image);
    assert_eq!(image.mime_type, "application/octet-stream");
    assert_eq!(
        reader
            .read_attachment(&chat, &image_mid, &image.id)
            .await
            .unwrap()
            .data_base64,
        files[0].data_base64
    );
    page(&mut reader, "fixture.mode = ''").await;
    // No outbound request can be constructed from a caller-provided URL,
    // unrelated file id, wrong message, or user-written link.
    page(
        &mut reader,
        r#"
        fixture.calls = [];
        fixture.messages[fixture.old]['old-user'].content =
            'https://chat.z.ai/api/v1/files/file-1/content';
        fixture.originals.historical = {type: 'application/octet-stream', bytes: new Uint8Array([65])};
        fixture.messages[fixture.old].archive = {id: 'archive', role: 'user', content: '',
            files: [{id: 'historical', name: 'archive.bin', mime_type: 'application/octet-stream'}]};
        fixture.messages[fixture.old].inline = {id: 'inline', role: 'assistant', content_blocks: [
            {type: 'image', name: 'answer.png', content: 'data:image/png;base64,AP//'},
            {type: 'image', name: 'broken.png', content: 'data:image/png;base64,??'},
            {type: 'image', url: 'https://example.invalid/preview'}
        ]};
    "#,
    )
    .await;
    for (chat, msg, id) in [
        (OLD, "old-user", "file-1"),
        (FRESH, "missing", "file-2"),
        (
            FRESH,
            mid.as_str(),
            "https://chat.z.ai/api/v1/files/file-1/content",
        ),
    ] {
        assert!(reader.read_attachment(chat, msg, id).await.is_err());
    }
    assert_eq!(
        page(
            &mut reader,
            "fixture.calls.filter(p => p.startsWith('/api/v1/files/'))"
        )
        .await,
        json!([])
    );
    let history = reader.read_chat(OLD).await.unwrap();
    let archive = history.iter().find(|row| row.id == "archive").unwrap();
    assert_eq!(archive.role, Role::User);
    assert!(archive.text.is_empty());
    assert_eq!(archive.attachments.len(), 1);
    assert_eq!(
        reader
            .read_attachment(OLD, &archive.id, &archive.attachments[0].id)
            .await
            .unwrap(),
        file("archive.bin", "application/octet-stream", "QQ==")
    );
    let inline = history.iter().find(|row| row.id == "inline").unwrap();
    assert_eq!(inline.role, Role::Assistant);
    assert!(inline.text.is_empty());
    assert_eq!(inline.attachments.len(), 1);
    assert_eq!(
        reader
            .read_attachment(OLD, "inline", &inline.attachments[0].id)
            .await
            .unwrap(),
        file("answer.png", "image/png", "AP//")
    );
    page(&mut reader, "fixture.messages[fixture.old].inline.content_blocks[0].content = 'data:image/png;base64,AA=='").await;
    assert!(
        reader
            .read_attachment(OLD, "inline", &inline.attachments[0].id)
            .await
            .is_err()
    );

    page(
        &mut reader,
        "void (fixture.originals['file-2'].bytes = new Uint8Array(2 * 1024 * 1024 + 1))",
    )
    .await;
    assert!(reader.read_attachment(FRESH, &mid, "file-2").await.is_err());
    page(&mut reader, "fixture.mode = 'switch-on-download'").await;
    assert_eq!(
        reader.read_attachment(FRESH, &mid, "file-1").await,
        Err(ZaiReadError::AccountMismatch)
    );
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn malformed_files_preserve_text_and_valid_siblings_but_ambiguous_ids_cannot_download() {
    let (_chrome, mut reader) = fixture(&[]).await;
    page(&mut reader, r#"
        const rows = fixture.messages[fixture.old];
        rows['old-user'].files = [
            {id:'good', name:'same.txt', file:{id:'good', meta:{content_type:'Text/Plain; charset=utf-8'}}},
            {id:'second-good', name:'same.txt', mime_type:'text/plain'},
            {id:'image-mime-unknown', type:'image', name:'picture', mime_type:'application/octet-stream'},
            {id:'file-mime-unknown', type:'file', name:'document'},
            {id:'conflict', name:'first.txt', mime_type:'text/plain'},
            {id:'conflict', name:'second.txt', mime_type:'text/plain'},
            {id:'bad-name', name:'../bad', mime_type:'text/plain'},
            {id:'bad-mime', name:'ok.txt', mime_type:{unknown:true}},
            {id:'inconsistent', name:'ok.txt', file:{id:'other-id'}},
            null
        ];
        rows.another = {id:'another', role:'assistant', content:'still readable', files:{unknown:true}};
        fixture.originals.good = {type:'text/plain; charset=utf-8', bytes:new Uint8Array([65])};
        fixture.calls = [];
    "#).await;
    let rows = reader.read_chat(OLD).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].text, TEXT);
    assert_eq!(rows[1].text, "still readable");
    assert!(rows[1].attachments.is_empty());
    assert_eq!(
        rows[0]
            .attachments
            .iter()
            .map(|f| (
                f.id.as_str(),
                f.name.as_str(),
                f.mime_type.as_str(),
                f.image
            ))
            .collect::<Vec<_>>(),
        [
            ("good", "same.txt", "text/plain", false),
            ("second-good", "same.txt", "text/plain", false),
            (
                "image-mime-unknown",
                "picture",
                "application/octet-stream",
                true
            ),
            (
                "file-mime-unknown",
                "document",
                "application/octet-stream",
                false
            ),
        ]
    );
    for denied in [
        "conflict",
        "bad-name",
        "bad-mime",
        "inconsistent",
        "other-id",
    ] {
        assert!(
            reader
                .read_attachment(OLD, "old-user", denied)
                .await
                .is_err()
        );
    }
    assert_eq!(
        page(
            &mut reader,
            "fixture.calls.filter(p => p.startsWith('/api/v1/files/'))"
        )
        .await,
        json!([])
    );
    assert_eq!(
        reader
            .read_attachment(OLD, "old-user", "good")
            .await
            .unwrap(),
        file("same.txt", "text/plain", "QQ==")
    );
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn refuse_extra_chips_and_never_replay_a_send_with_wrong_original_bytes() {
    let (_chrome, mut reader) = fixture(&[]).await;
    reader.open_conversation(OLD).await.unwrap();
    let files = [file("a.bin", "application/octet-stream", "AP8=")];
    page(&mut reader, "fixture.mode = 'extra-chip'").await;
    assert_eq!(
        reader
            .submit_with_attachments(Some(OLD), TEXT, &files)
            .await,
        Err(BrowserSubmitError::BeforeSend)
    );
    assert_eq!(page(&mut reader, "fixture.clicks").await, 0);

    page(
        &mut reader,
        "fixture.mode = 'corrupt-original'; dispatchEvent(new PopStateEvent('popstate'))",
    )
    .await;
    assert_eq!(
        reader
            .submit_with_attachments(Some(OLD), TEXT, &files)
            .await,
        Err(BrowserSubmitError::Unknown)
    );
    assert_eq!(
        reader
            .submit_with_attachments(Some(OLD), TEXT, &files)
            .await,
        Err(BrowserSubmitError::BeforeSend)
    );
    assert_eq!(
        page(&mut reader, "[fixture.clicks, fixture.uploads]").await,
        json!([1, 2])
    );
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn stop_requires_one_active_assistant_with_the_exact_user_parent() {
    let (_chrome, mut reader) = fixture(&[]).await;
    reader.open_conversation(OLD).await.unwrap();
    assert!(!reader.cancel_turn(OLD, "old-user").await.unwrap());
    page(&mut reader, "fixture.activate(fixture.old, 'old-user')").await;
    assert!(!reader.cancel_turn(OLD, "unrelated").await.unwrap());
    assert!(!reader.cancel_turn(FRESH, "old-user").await.unwrap());
    page(&mut reader, "document.body.insertAdjacentHTML('beforeend', '<article class=user-message data-message-id=wrong>other input</article>')").await;
    assert!(reader.cancel_turn(OLD, "old-user").await.is_err());
    page(&mut reader, "document.querySelector('article').remove()").await;
    page(&mut reader, "fixture.messages[fixture.old].branch = {id:'branch', role:'assistant', parentId:'old-user', done:false}").await;
    assert!(reader.cancel_turn(OLD, "old-user").await.is_err());
    page(
        &mut reader,
        "delete fixture.messages[fixture.old].branch; fixture.mode = 'switch-branch'",
    )
    .await;
    assert!(reader.cancel_turn(OLD, "old-user").await.is_err());
    page(&mut reader, "fixture.mode = ''; fixture.current[fixture.old] = 'assistant-for-old-user'; fixture.user = 'other'").await;
    assert_eq!(
        reader.cancel_turn(OLD, "old-user").await,
        Err(ZaiReadError::AccountMismatch)
    );
    assert_eq!(page(&mut reader, "fixture.stops").await, 0);
    page(&mut reader, "fixture.user = fixture.owner").await;
    assert!(reader.cancel_turn(OLD, "old-user").await.unwrap());
    assert!(!reader.cancel_turn(OLD, "old-user").await.unwrap());
    assert_eq!(page(&mut reader, "fixture.stops").await, 1);
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn an_unconfirmed_stop_is_not_clicked_twice() {
    let (_chrome, mut reader) = fixture(&[]).await;
    reader.open_conversation(OLD).await.unwrap();
    page(
        &mut reader,
        "fixture.activate(fixture.old, 'old-user'); fixture.mode = 'stuck-stop'",
    )
    .await;
    assert!(reader.cancel_turn(OLD, "old-user").await.is_err());
    assert!(reader.cancel_turn(OLD, "old-user").await.is_err());
    assert_eq!(page(&mut reader, "fixture.stops").await, 1);
}

#[tokio::test]
#[ignore = "requires local Google Chrome and Node.js"]
async fn native_empty_list_needs_its_own_auth_proof() {
    let (_chrome, mut reader) = fixture(&[]).await;
    assert_eq!(reader.list_native_ids(10).await.unwrap(), [OLD]);
    page(&mut reader, "fixture.user = 'other-login'").await;
    assert_eq!(
        reader.list_native_ids(10).await,
        Err(ZaiReadError::AccountMismatch)
    );
    page(&mut reader, "fixture.user = fixture.owner").await;
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
async fn late_first_route_can_only_settle_the_clicked_ticket() {
    let (_chrome, mut reader) = fixture(&[]).await;
    page(
        &mut reader,
        r#"
        const replace = history.replaceState.bind(history);
        history.replaceState = (...args) => {
            fixture.publishRoute = () => replace(...args);
        };
        true
    "#,
    )
    .await;
    let mut ticket = String::new();
    let files = [file("parcel.txt", "text/plain", "cGFyY2Vs")];
    let send = reader.submit_with_ticket(None, TEXT, &files, |prepared| {
        ticket = prepared.to_owned();
        Ok(())
    });
    assert!(
        tokio::time::timeout(Duration::from_secs(2), send)
            .await
            .is_err()
    );
    assert_eq!(page(&mut reader, "fixture.clicks").await, 1);
    assert_eq!(reader.read_submission(None, &ticket).await.unwrap(), None);
    page(&mut reader, "fixture.publishRoute(); true").await;
    assert!(
        reader
            .read_submission(None, "another-ticket")
            .await
            .is_err()
    );
    for _ in 0..2 {
        assert_eq!(
            reader.read_submission(None, &ticket).await.unwrap(),
            Some((FRESH.into(), "user-1".into()))
        );
    }
    assert_eq!(
        page(&mut reader, "[fixture.clicks, fixture.uploads]").await,
        json!([1, 1])
    );
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
async fn recovery_reports_last_run_and_current_node_but_never_claims_failed_lineage() {
    let (_chrome, mut reader) = fixture(&[]).await;
    page(
        &mut reader,
        "fixture.status = 'failed'; fixture.current[fixture.old] = 'old-user'",
    )
    .await;
    let evidence = reader
        .native_read("recovery", Some(OLD), Value::Null)
        .await
        .unwrap();
    assert_eq!(evidence["available"], false);
    assert_eq!(evidence["reason"], "terminal_failure_lineage_unavailable");
    assert_eq!(evidence["lastRunStatus"], "failed");
    page(&mut reader, "fixture.status = 'completed'").await;
    let completed = reader
        .native_read("recovery", Some(OLD), Value::Null)
        .await
        .unwrap();
    assert_eq!(completed["available"], false);
    assert_eq!(completed["lastRunStatus"], "completed");
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
