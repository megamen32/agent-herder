  if (provider === "chatgpt") {
    if (op === "account") return chatGptAccount();
    const run = (action, args = params) => {
      const read = ["list", "read", "activity", "recovery"].includes(action);
      const handler = read ? readChatGpt
        : action === "cancel" ? cancelChatGptTurn
        : action === "download" ? downloadChatGptFile
        : useChatGptComposer;
      return chatGptNative(handler, { ...args, op: action });
    };
    if (op === "recover") {
      const baseline = await run("baseline");
      if (!Array.isArray(baseline.value)) return { status: "not_sent" };
      const before = baseline.value;
      const filled = await run("fill");
      if (filled.value === "unknown") return { status: "unknown" };
      if (filled.value !== true) return { status: "not_sent" };
      const click = await run("click");
      if (click.value === false) return { status: "not_sent" };
      if (click.value !== true) return { status: "unknown" };
      for (let attempt = 0; attempt < 7; ++attempt) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 200 * attempt));
        const receipt = await run("receipt", { ...params, observedId: params.id, before });
        const message = receipt.value;
        if (message?.id !== params.id) return { status: "unknown" };
        if (message.messageId && !before.includes(message.messageId)) {
          return { status: "sent", id: message.id, messageId: message.messageId };
        }
      }
      return { status: "unknown" };
    }
    if (["list", "read", "activity", "recovery", "cancel", "download",
      "opened", "open", "baseline", "fill", "click", "receipt"].includes(op)) {
      return run(op);
    }
  }
  if (provider === "zai") {
    if (op === "list") {
      const result = await listZaiChats(params.scope, params.authenticate);
      if (Array.isArray(result.chats)) {
        result.chats = result.chats.slice(0, params.limit).map(row => ({ id: row?.id }));
      }
      return result;
    }
    if (["account", "blank", "open", "activity", "recovery", "read",
      "prepare", "click", "receipt", "cancel", "attachment"].includes(op)) {
      return zaiPage({ ...params, op }, zaiFiles, zaiStop);
    }
  }
  throw new Error("unsupported_page_operation");
