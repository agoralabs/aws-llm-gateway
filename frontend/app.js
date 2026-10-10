const $ = (selector) => document.querySelector(selector);
const DEFAULT_API = "https://llm.kaiac.io";
const targetInput = $("#target-url");
const apiStatus = $("#api-status");
const apiStatusText = $("#api-status-text");
const wsStatus = $("#ws-status");
const wsStatusText = wsStatus.querySelector("span");
const jobIdInput = $("#job-id");
const streamOutput = $("#stream-output");
const eventList = $("#event-list");
const logEntries = [];
let socket;
let outputText = "";
let outputBytes = 0;
let activeJobId = "";

function apiBase() { return targetInput.value.trim().replace(/\/+$/, ""); }
function apiUrl(path) { return `${apiBase()}${path}`; }
function setApiState(state, text) { apiStatus.dataset.state = state; apiStatusText.textContent = text; }
function setSocketState(state, text) {
  wsStatus.dataset.state = state;
  wsStatusText.textContent = text;
  const connected = state === "open";
  $("#send-generation").disabled = !connected;
  $("#get-job-ws").disabled = !connected;
  $("#watch-job").disabled = !connected;
  $("#cancel-job").disabled = !connected;
  $("#connect-ws").querySelector("span:last-child").textContent = connected ? "Déconnecter WS" : "Connecter WS";
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} octet${bytes === 1 ? "" : "s"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}
function recordEvent(title, payload, options = {}) {
  logEntries.unshift({ time: new Date().toLocaleTimeString("fr-FR", { hour12: false }), title, code: options.code ?? "WS", kind: options.kind ?? "ok", payload });
  logEntries.splice(24);
  renderEvents();
}
function renderEvents() {
  eventList.replaceChildren();
  if (!logEntries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-log";
    empty.textContent = "Les appels HTTP et événements WebSocket apparaîtront ici.";
    eventList.append(empty);
    return;
  }
  for (const entry of logEntries) {
    const article = document.createElement("article");
    article.className = "event-item";
    article.dataset.kind = entry.kind;
    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = entry.time;
    const content = document.createElement("div");
    content.className = "event-content";
    const heading = document.createElement("div");
    heading.className = "event-title";
    const title = document.createElement("span");
    title.textContent = entry.title;
    const code = document.createElement("span");
    code.className = "event-code";
    code.textContent = entry.code;
    heading.append(title, code);
    const detail = document.createElement("pre");
    detail.textContent = typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload, null, 2);
    content.append(heading, detail);
    article.append(time, content);
    eventList.append(article);
  }
}
async function requestJson(path, title) {
  try {
    const response = await fetch(apiUrl(path), { headers: { accept: "application/json" } });
    const type = response.headers.get("content-type") ?? "";
    const payload = type.includes("json") ? await response.json() : await response.text();
    recordEvent(title, payload, { code: `HTTP ${response.status}`, kind: response.ok ? "ok" : "error" });
    if (path === "/health") setApiState(response.ok ? "online" : "error", response.ok ? "API disponible" : `API HTTP ${response.status}`);
    return { response, payload };
  } catch (error) {
    recordEvent(title, `${error.message}. Vérifiez la cible et le CORS.`, { code: "ÉCHEC RÉSEAU", kind: "error" });
    setApiState("error", "API inaccessible");
    return null;
  }
}
async function loadModels() {
  const result = await requestJson("/v1/models", "GET /v1/models");
  if (!result?.response.ok || !Array.isArray(result.payload?.data)) return;
  const select = $("#model-select");
  const previous = select.value;
  select.replaceChildren();
  for (const model of result.payload.data) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = ({ "gpt-6-luna": "GPT-6 Luna", "claude-haiku-5.5": "Claude Haiku 5.5", "MAI-Code-1.1-Flash": "MAI-Code-1.1-Flash" })[model.id] ?? model.id;
    select.append(option);
  }
  if (result.payload.data.some((model) => model.id === previous)) select.value = previous;
  setApiState("online", "API disponible");
}
function setActiveJob(jobId, status = "En attente") {
  activeJobId = jobId || "";
  if (jobId) jobIdInput.value = jobId;
  $("#active-job").textContent = activeJobId || "Aucun job sélectionné";
  $("#job-state").textContent = status;
}
function resetStream() {
  outputText = "";
  outputBytes = 0;
  streamOutput.replaceChildren();
  const pre = document.createElement("pre");
  pre.id = "stream-text";
  streamOutput.append(pre);
  $("#stream-bytes").textContent = "0 octet reçu";
}
function appendDelta(text) {
  if (!$("#stream-text")) resetStream();
  outputText += text;
  outputBytes += new TextEncoder().encode(text).length;
  $("#stream-text").textContent = outputText;
  $("#stream-bytes").textContent = `${formatBytes(outputBytes)} reçus`;
  streamOutput.scrollTop = streamOutput.scrollHeight;
}
function handleSocketMessage(raw) {
  let message;
  try { message = JSON.parse(raw); }
  catch { recordEvent("Message WebSocket brut", raw, { kind: "error" }); return; }
  $("#last-event").textContent = `${message.type ?? "message"} · ${new Date().toLocaleTimeString("fr-FR", { hour12: false })}`;
  if (message.type === "delta") {
    if (message.jobId) setActiveJob(message.jobId, "Génération");
    appendDelta(message.text ?? "");
    return;
  }
  if (message.type === "accepted") {
    setActiveJob(message.jobId, message.duplicate ? "Déjà reçu" : "En file");
  } else if (message.type === "job") {
    setActiveJob(message.jobId, message.status ?? "État reçu");
  } else if (["completed", "truncated", "cancelled", "interrupted", "failed"].includes(message.type)) {
    setActiveJob(message.jobId ?? activeJobId, message.type);
  }
  recordEvent(`WS · ${message.type ?? "message"}`, message, { kind: message.type === "failed" ? "error" : "ok" });
}
function connectSocket() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) {
    socket.close(1000, "user disconnect");
    return;
  }
  try {
    const target = new URL(apiUrl("/v1/ws"));
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(target);
  } catch (error) {
    recordEvent("Cible WebSocket invalide", error.message, { kind: "error" });
    return;
  }
  setSocketState("connecting", "Connexion…");
  socket.addEventListener("open", () => {
    setSocketState("open", "Connecté");
    recordEvent("WebSocket connecté", apiUrl("/v1/ws"));
  });
  socket.addEventListener("message", (event) => handleSocketMessage(event.data));
  socket.addEventListener("error", () => {
    setSocketState("error", "Erreur WS");
    recordEvent("Erreur WebSocket", "Vérifiez la cible et la disponibilité du gateway.", { kind: "error" });
  });
  socket.addEventListener("close", (event) => {
    setSocketState("closed", "Déconnecté");
    if (event.code !== 1000) recordEvent("WebSocket fermé", { code: event.code, reason: event.reason }, { kind: "error" });
  });
}
function sendSocketAction(action, values = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    recordEvent("WebSocket non connecté", "Connectez le WebSocket avant cette action.", { kind: "error" });
    return;
  }
  const message = { action, ...values };
  socket.send(JSON.stringify(message));
  recordEvent(`WS → ${action}`, message);
}
async function fetchResult() {
  const jobId = $("#job-id").value.trim();
  if (!jobId) return recordEvent("GET résultat", "Saisissez un Job ID.", { kind: "error" });
  try {
    const response = await fetch(apiUrl(`/v1/jobs/${encodeURIComponent(jobId)}/result`));
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || type.includes("application/json")) {
      const payload = type.includes("json") ? await response.json() : await response.text();
      recordEvent(`GET /v1/jobs/${jobId}/result`, payload, { code: `HTTP ${response.status}`, kind: "error" });
      return;
    }
    const blob = await response.blob();
    recordEvent(`GET /v1/jobs/${jobId}/result`, `${formatBytes(blob.size)} téléchargés`, { code: `HTTP ${response.status}` });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${jobId}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    recordEvent("GET résultat", `${error.message}. Vérifiez le CORS.`, { code: "ÉCHEC RÉSEAU", kind: "error" });
  }
}
function applyTarget() {
  let target;
  try {
    target = new URL(targetInput.value.trim());
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Utilisez une URL HTTP(S) sans chemin ni identifiants.");
  } catch (error) {
    recordEvent("Cible API invalide", error.message, { code: "CONFIG", kind: "error" });
    return;
  }
  targetInput.value = target.origin;
  localStorage.setItem("gateway-api-url", target.origin);
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.close(1000, "target changed");
  setApiState("unknown", "Cible mise à jour");
  recordEvent("Cible API appliquée", target.origin, { code: "LOCAL" });
}
function initialize() {
  renderEvents();
  targetInput.value = localStorage.getItem("gateway-api-url") || DEFAULT_API;
  $("#request-id").value = crypto.randomUUID?.() ?? `req-${Date.now()}`;
}

$("#check-health").addEventListener("click", () => requestJson("/health", "GET /health"));
$("#check-models").addEventListener("click", loadModels);
$("#refresh-models").addEventListener("click", loadModels);
$("#connect-ws").addEventListener("click", connectSocket);
$("#apply-target").addEventListener("click", applyTarget);
$("#new-request-id").addEventListener("click", () => { $("#request-id").value = crypto.randomUUID?.() ?? `req-${Date.now()}`; });
$("#send-generation").addEventListener("click", () => {
  const prompt = $("#prompt").value;
  if (!prompt.trim()) return recordEvent("Prompt vide", "Saisissez un prompt avant l’envoi.", { kind: "error" });
  const requestId = $("#request-id").value.trim() || (crypto.randomUUID?.() ?? `req-${Date.now()}`);
  $("#request-id").value = requestId;
  resetStream();
  setActiveJob("", "Soumission…");
  sendSocketAction("startGeneration", { requestId, model: $("#model-select").value, prompt });
});
$("#get-job-http").addEventListener("click", async () => {
  const jobId = $("#job-id").value.trim();
  if (!jobId) return recordEvent("GET statut", "Saisissez un Job ID.", { kind: "error" });
  const result = await requestJson(`/v1/jobs/${encodeURIComponent(jobId)}`, `GET /v1/jobs/${jobId}`);
  if (result?.response.ok) setActiveJob(jobId, result.payload.status ?? "État reçu");
});
$("#get-job-ws").addEventListener("click", () => sendSocketAction("getJob", { jobId: $("#job-id").value.trim() }));
$("#watch-job").addEventListener("click", () => sendSocketAction("watchJob", { jobId: $("#job-id").value.trim() }));
$("#cancel-job").addEventListener("click", () => sendSocketAction("cancelJob", { jobId: $("#job-id").value.trim() }));
$("#get-result").addEventListener("click", fetchResult);
$("#clear-stream").addEventListener("click", resetStream);
$("#clear-log").addEventListener("click", () => { logEntries.length = 0; renderEvents(); });
$("#prompt").addEventListener("input", (event) => {
  const bytes = new TextEncoder().encode(event.currentTarget.value).length;
  $("#prompt-count").textContent = formatBytes(bytes);
  $("#prompt-count").style.color = bytes > 200 * 1024 ? "#b24e3d" : "";
});
targetInput.addEventListener("keydown", (event) => { if (event.key === "Enter") applyTarget(); });
initialize();
