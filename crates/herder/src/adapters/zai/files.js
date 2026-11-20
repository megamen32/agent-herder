// Helpers run inside the bound page. Only metadata and explicitly requested
// originals cross CDP. Download locations come from the provider's file schema.
function zaiFiles({abort, hash, isObject, maxBytes, signal, messageSelector, chipSelector}) {
    const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
    const safeName = name => typeof name === 'string' && name.trim() && !['.', '..'].includes(name)
        && !/[/\\\x00-\x1f\x7f-\x9f]/.test(name) && new TextEncoder().encode(name).length <= 255;
    const mime = value => typeof value === 'string' && value.length <= 255
        && /^[A-Za-z0-9!#$%&'+.^_\x60|~-]+\/[A-Za-z0-9!#$%&'+.^_\x60|~-]+$/.test(value);
    const decodedName = value => {
        try { return decodeURIComponent(value); } catch { return value; }
    };

    async function messageFiles(message, requireAll = false) {
        // A reference rejected anywhere in this message stays ambiguous even
        // if another entry with that ID happens to have valid metadata.
        const records = new Map();
        let incomplete = false;
        function reject(...ids) {
            incomplete = true;
            for (const id of ids) if (safeId(id)) records.set(id, null);
        }
        function add(id, name, type, source, image) {
            if (!safeId(id) || !safeName(name) || !mime(type) || records.has(id)) return reject(id);
            records.set(id, {id, name, mime_type: type, source, image: image && type === 'application/octet-stream'});
        }
        function nativeFile(item, referenceOnly = false) {
            const record = item.file;
            const id = item.pfs_file_id ?? item.id ?? item.file_id ?? record?.id;
            const ids = [id, item.id, item.file_id, record?.id].filter(id => id != null);
            if (!safeId(id) || ids.some(other => other !== id)) return reject(...ids);
            const name = record?.filename ?? item.filename ?? (typeof item.name === 'string'
                ? decodedName(item.name) : undefined);
            const contentType = record?.meta?.content_type ?? record?.content_type ?? item.mime_type ??
                item.content_type ?? (typeof item.type === 'string' && item.type.includes('/') ? item.type : undefined);
            const type = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase()
                : contentType;
            const image = item.media === 'image' || item.type === 'image' || item.type === 'image_url';
            const path = item.pfs_file_id ? '/api/v1/storage/pfs/files/' + id + '/download'
                : '/api/v1/files/' + id + '/content';
            if (referenceOnly && records.has(id)) {
                // A typed content block can also point at its native files[] entry.
                const known = records.get(id);
                if (known && (known.source.path !== path || (name != null && name !== known.name) ||
                    (type != null && type !== known.mime_type))) reject(id);
                else if (known && image && known.mime_type === 'application/octet-stream') known.image = true;
                return;
            }
            add(id, name ?? (referenceOnly ? id : undefined), type ?? 'application/octet-stream', {path}, image);
        }
        if (Array.isArray(message.files)) {
            for (const item of message.files) {
                if (isObject(item) && !['collection', 'web_search'].includes(item.type)) nativeFile(item);
                else reject();
            }
        } else if (message.files != null) {
            reject();
        }
        // Typed inline media can carry the original in the message itself.
        // Never use a thumbnail, a Markdown link or an arbitrary URL as an original.
        async function blockFile(block, index, field) {
            if (!isObject(block) || !['file', 'image', 'image_url', 'file_url'].includes(block.type)) return;
            const value = block.image_url?.url ?? block.file_url?.url ?? block.content ?? block.url;
            const nativePath = typeof value === 'string' &&
                /^(?:https:\/\/chat\.z\.ai)?\/api\/v1\/files\/([A-Za-z0-9_-]+)\/content$/.exec(value);
            if (block.file_id || block.file?.id || nativePath) {
                const id = block.file_id ?? block.file?.id ?? nativePath[1];
                if (nativePath && nativePath[1] !== id) return reject(id, nativePath[1]);
                nativeFile({...block, id}, true);
                return;
            }
            if (typeof value !== 'string' || !value.startsWith('data:')) return reject();
            const comma = value.indexOf(',');
            if (comma < 0 || comma > 300 || value.length - comma - 1 > 4 * Math.ceil(maxBytes / 3)) return reject();
            const header = value.slice(5, comma);
            if (!header.endsWith(';base64')) return reject();
            const type = header.split(';')[0].toLowerCase();
            const base64 = value.slice(comma + 1);
            let size;
            try {
                const binary = atob(base64);
                if (binary.length > maxBytes || btoa(binary) !== base64) return reject();
                size = binary.length;
            } catch { return reject(); }
            const label = field + '-' + index;
            add(label + '-' + await hash(base64), block.name ?? block.filename ?? label, type, {base64, size},
                block.type === 'image' || block.type === 'image_url');
        }
        for (const field of ['content_blocks', 'content']) {
            if (Array.isArray(message[field])) {
                for (const [index, block] of message[field].entries()) await blockFile(block, index, field);
            }
        }
        if (requireAll && incomplete) abort('unconfirmed_file_set');
        return Array.from(records.values()).filter(Boolean);
    }

    function metadata({id, name, mime_type, image}) {
        return image ? {id, name, mime_type, image: true} : {id, name, mime_type};
    }

    async function original(file, limit) {
        if (!Number.isSafeInteger(limit) || limit < 0) abort('invalid_file_limit');
        if (file.source.base64 !== undefined) {
            if (file.source.size > limit) abort('file_too_large');
            return {data: file.source.base64, size: file.source.size, type: file.mime_type};
        }
        const response = await fetch(file.source.path, {credentials: 'same-origin', cache: 'no-store',
            mode: 'same-origin', redirect: 'error', signal});
        if (!response.ok) throw {status: response.status};
        if (response.status !== 200 || response.redirected || !response.body ||
            (response.url && response.url !== location.origin + file.source.path)) abort('invalid_file_response');
        const reader = response.body.getReader();
        let size = 0, binary = '', type = file.mime_type;
        try {
            if (Number(response.headers.get('content-length')) > limit) abort('file_too_large');
            const header = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
            if (header && header !== 'application/octet-stream') {
                if (!mime(header) || (type !== 'application/octet-stream' && header !== type)) abort('file_mismatch');
                type = header;
            }
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                size += value.length;
                if (size > limit) abort('file_too_large');
                for (let i = 0; i < value.length; i += 0x8000) {
                    binary += String.fromCharCode(...value.subarray(i, i + 0x8000));
                }
            }
        } finally {
            await reader.cancel();
        }
        return {data: btoa(binary), size, type};
    }

    function composerChips(editor) {
        const root = editor?.form ?? document;
        const candidates = Array.from(root.querySelectorAll(chipSelector))
            .filter(el => !el.closest(messageSelector));
        return candidates.filter(el => !el.parentElement?.closest(chipSelector));
    }
    function composerInput(editor) {
        // Z.ai renders its picker immediately before the form. Embedded inputs
        // are also form-associated. A picker elsewhere on the page is unrelated.
        const form = editor.form;
        const inputs = form ? Array.from(form.querySelectorAll('input[type=file]')).filter(el => el.form === form)
            : Array.from(editor.parentElement.children).filter(el => el.matches('input[type=file]') && !el.form);
        if (form?.previousElementSibling?.matches('input[type=file]')) inputs.push(form.previousElementSibling);
        return inputs.length === 1 && !inputs[0].disabled ? inputs[0] : null;
    }
    function selectFiles(editor, attachments) {
        const input = composerInput(editor);
        if (!input || (attachments.length > 1 && !input.multiple)) abort('file_input_unavailable');
        const transfer = new DataTransfer();
        for (const attachment of attachments) {
            const bytes = Uint8Array.from(atob(attachment.data_base64), c => c.charCodeAt(0));
            transfer.items.add(new File([bytes], attachment.name, {type: attachment.mime_type}));
        }
        input.files = transfer.files;
        const selection = {input, files: Array.from(input.files)};
        input.dispatchEvent(new Event('change', {bubbles: true}));
        return selection;
    }
    function selectionReady(editor, selection) {
        const chips = composerChips(editor);
        const picked = Array.from(document.querySelectorAll('input[type=file]')).filter(i => i.files?.length);
        if (!selection) return !chips.length && !picked.length;
        const {input, files} = selection;
        if (composerInput(editor) !== input) abort('file_input_changed');
        const retained = picked.length === 1 && picked[0] === input && input.files.length === files.length &&
            files.every((file, i) => input.files[i] === file);
        if (picked.length && !retained) abort('selection_changed');
        // The provider clears its native picker and renders one chip per upload.
        // A FileList alone cannot prove that its change handler accepted it.
        if (!chips.length) return false;
        if (chips.length > files.length) abort('foreign_file');
        const names = files.map(f => f.name);
        for (const chip of chips) {
            const name = chip.getAttribute('data-file-name') ?? chip.querySelector('.truncate')?.textContent
                ?? chip.textContent;
            const index = names.indexOf(name);
            if (index < 0) abort('foreign_file');
            names.splice(index, 1);
            const loading = '[aria-busy=true], [role=progressbar], .animate-spin, [data-status=uploading]';
            if (chip.matches(loading) || chip.querySelector(loading)) return false;
        }
        return !names.length;
    }
    return {messageFiles, metadata, original, selectFiles, selectionReady};
}
