export const providers = {
  chatgpt: "https://chatgpt.com",
  zai: "https://chat.z.ai",
};

export function validToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(token);
}

export function validEndpoint(value) {
  try {
    const url = new URL(value);
    const secure = url.protocol === "wss:";
    const local = url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (secure || local) && url.pathname === "/browser-extension"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
