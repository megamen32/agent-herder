# Управление удалённой сессией из центрального чата

Root 01a12740. User explicitly requested completing remote session controls without URL navigation.

Implemented own owner-HTTP session request for details/message/status/stop/resume, typed full host+harness+nativeSID. Existing verified cookie/principal/TLS/native host + session read guards retained. One POST to existing owner UDM, stable inputId; unknown is receipt-only, no replay/create/retarget. Old fleet read/create/journal stays in place.

RemoteSessionView now uses normal message renderer and chat/composer classes. Scoped existing outbox helpers persist independently per principal+host+harness+SID; admitted messages appear in the conversation, pending/unknown carry status. Cache is read-only until fresh identity. Stop/resume intent survives lost replies; unknown does not silently repeat. Owner URL is only an optional menu link.

Release1: 60 focused checks + strict compile + Vite succeeded 39.214s/max120, native helper0/peak623456256/swapOOM0/samegeneration cleanup. Budget mismatch refusal and old-system-Node syntax failure preserved separately. No framework/cap changes.

Fresh official existing-only SDK observation: controller1072026, SDK1072381, 155 native sessions idle, but 9 accepted/pending native input rows remain. They must not be discarded/replayed by maintenance. Deployment is pending an exact live WebDependencies fleetApiHandler update retaining original guard/other handlers/native owners and original read/create journal, plus selected published modules for cold boot. No blanket restart authorized by this receipt.

Acceptance pending: authenticated site44/88; own remote native session only, send/stop/resume with sameID, no URL switch, actual history/effect receipts. Foreign releaseJS untouched.
