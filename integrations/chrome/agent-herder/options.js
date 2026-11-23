import { validEndpoint, validToken } from "./connection.js";

const form = document.querySelector("form");
const status = document.getElementById("status");
const { provider, endpoint, token } = form.elements;

async function showStatus() {
  const { connections = {} } = await chrome.storage.local.get("connections");
  const saved = connections[provider.value];
  endpoint.value = saved?.endpoint ?? "";
  token.required = !saved;
  token.value = "";
  status.textContent = saved ? "Connection configured." : "Disconnected.";
}

provider.addEventListener("change", showStatus);
form.addEventListener("submit", async event => {
  event.preventDefault();
  const { connections = {} } = await chrome.storage.local.get("connections");
  const value = {
    endpoint: endpoint.value.trim(),
    token: token.value || connections[provider.value]?.token,
  };
  if (!validEndpoint(value.endpoint) || !validToken(value.token)) {
    status.textContent = "Enter a Herder WebSocket URL and connection token.";
    return;
  }
  connections[provider.value] = value;
  await chrome.storage.local.set({ connections });
  await showStatus();
});

document.getElementById("disconnect").addEventListener("click", async () => {
  const { connections = {} } = await chrome.storage.local.get("connections");
  delete connections[provider.value];
  await chrome.storage.local.set({ connections });
  await showStatus();
});
await showStatus();
