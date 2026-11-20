// The page's Stop button may cancel more than one local run. Verify the active
// branch and any other unfinished leaves before invoking the provider control.
async function zaiStop({id, input, user, at, controls, detail, batch, currentUser, abort, validId, busyStatus}) {
    if (!at(id)) return false;
    const initial = controls();
    const chat = await detail(id, user);
    const history = chat.chat?.history;
    const sameAccount = async () => {
        if (await currentUser() !== user) abort('account_mismatch');
        if (!at(id)) abort('route_changed');
    };
    await sameAccount();
    const ui = controls();
    if (ui.phase !== initial.phase || ui.stop !== initial.stop) abort('generation_changed');
    if (ui.phase === 'idle') {
        if (busyStatus(chat.last_run?.status) || history?.messages?.[history.currentId]?.done === false) {
            abort('activity_conflict');
        }
        return false;
    }
    if (ui.phase !== 'busy' || !ui.stop) abort('stop_unavailable');

    const active = history?.currentId;
    const tree = history?.messages;
    if (!validId(active) || !tree || !Object.hasOwn(tree, active)) abort('unknown_generation');
    function openHeads(messages) {
        const parents = new Set(Object.values(messages).map(node => node?.parentId));
        return Object.keys(messages).filter(key => key === active ||
            (!parents.has(key) && !messages[key]?.childrenIds?.length && messages[key]?.done !== true &&
                (!messages[key]?.role || messages[key].role === 'assistant')));
    }
    const heads = openHeads(tree);
    if (heads.length > 60 || !heads.every(validId)) abort('ambiguous_generation');
    const rows = await batch(id, heads, user);
    function node(key, data) {
        const row = data[key], summary = tree[key];
        if (!Object.hasOwn(data, key) || row?.id !== key || (summary?.id != null && summary.id !== key) ||
            ['role', 'parentId'].some(k => row[k] != null && summary?.[k] != null && row[k] !== summary[k])) {
            abort('message_mismatch');
        }
        return {...summary, ...row};
    }
    const head = node(active, rows);
    if (head.role !== 'assistant' || head.done === true || head.error || head.childrenIds?.length ||
        !validId(head.parentId) || !Object.hasOwn(tree, head.parentId)) abort('unknown_generation');
    const nodes = heads.map(key => node(key, rows));
    const nonLeaves = new Set(nodes.map(n => n.parentId));
    if (nodes.some(n => n.id !== active && n.role === 'assistant' && !n.childrenIds?.length &&
        !nonLeaves.has(n.id) && n.done !== true && !n.error)) abort('ambiguous_generation');
    const parent = node(head.parentId, Object.hasOwn(rows, head.parentId) ? rows : await batch(id, [head.parentId], user));
    if (parent.role !== 'user' || (Array.isArray(parent.childrenIds) && !parent.childrenIds.includes(active))) {
        abort('unknown_generation');
    }

    const latest = await detail(id, user);
    const branch = latest.chat?.history;
    const leaf = branch?.messages?.[active];
    if (branch?.currentId !== active || !leaf || leaf.done === true || leaf.error || leaf.childrenIds?.length ||
        (leaf.parentId != null && leaf.parentId !== head.parentId) ||
        JSON.stringify(openHeads(branch.messages)) !== JSON.stringify(heads)) abort('generation_changed');
    await sameAccount();
    const current = controls();
    if (current.phase !== 'busy' || current.stop !== ui.stop || current.editor !== ui.editor) abort('generation_changed');
    // Some client versions also render native message IDs. When available,
    // they must still agree with the provider branch in the same JS task as Stop.
    for (const [role, expected] of [['user', head.parentId], ['assistant', active]]) {
        const rendered = Array.from(document.querySelectorAll('[data-message-author-role="' + role + '"], .' + role + '-message'))
            .filter(el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible').at(-1);
        const shown = rendered?.dataset.messageId ?? rendered?.id.match(/^message-(.+)$/)?.[1];
        if (shown && shown !== expected) abort('generation_changed');
    }
    if (head.parentId !== input) return false;

    const key = Symbol.for('agent-herder.zai.stop');
    if (globalThis[key]?.id === id && globalThis[key]?.active === active) abort('stop_unconfirmed');
    globalThis[key] = {id, active};
    ui.stop.click();
    for (let attempt = 0; attempt < 24; attempt++) {
        if (!at(id)) abort('route_changed');
        if (controls().phase === 'idle') {
            const confirmed = await detail(id, user);
            await sameAccount();
            const after = confirmed.chat?.history;
            if (after?.currentId !== active || controls().phase !== 'idle') abort('stop_unconfirmed');
            const record = after.messages?.[active];
            if (record && (!record.parentId || record.parentId === input) && record.done !== false &&
                !busyStatus(confirmed.last_run?.status)) return true;
        }
        await new Promise(resolve => setTimeout(resolve, 125));
    }
    abort('stop_unconfirmed');
}
