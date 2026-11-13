import type { AgentEvent } from "../shared/protocol";
import type { ObserveResult } from "../shared/types";
import { DEFAULTS, getSettings, saveSettings } from "../shared/settings";
import { clearSecrets, loadSecrets, saveSecrets } from "../vault";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Shows only what the background worker produced for sending: the redacted image and the outgoing JSON. */
function render(r: ObserveResult): void {
  $<HTMLImageElement>("shot").src = r.image;
  $("guard").textContent = r.guard.blocked ? `Leak guard blocked this step (secrets found: ${r.guard.hits.join(", ")})` : "";
  const timing = Object.entries(r.timingMs).map(([k, v]) => `${k} ${v}ms`).join(", ");
  const p = r.payload;
  const backend = r.ml ? ` [ner ${r.ml.backend.ner}${r.ml.backend.nerModel ? ` (${r.ml.backend.nerModel})` : ""}, face ${r.ml.backend.face}]` : "";
  $("info").textContent = (p ? `${p.elements.length} elements, ${r.regions.length} redacted; ${timing}` : timing) + backend;

  $("json").textContent = p ? JSON.stringify(p, null, 2) : "(blocked)";
  const regions = $<HTMLTableElement>("regions");
  regions.replaceChildren();
  for (const g of r.regions) {
    const tr = regions.insertRow();
    tr.insertCell().textContent = g.category;
    tr.insertCell().textContent = g.source;
    tr.insertCell().textContent = g.bbox.join(", ");
  }

  const table = $<HTMLTableElement>("els");
  table.replaceChildren();
  for (const e of p?.elements ?? []) {
    const tr = table.insertRow();
    tr.insertCell().textContent = String(e.id);
    tr.insertCell().textContent = `${e.tag}${e.type ? `[${e.type}]` : ""}`;
    tr.insertCell().textContent = e.redacted ? `${e.label ?? ""} [${e.category}]` : e.label || e.text || "";
  }
}

async function refreshVaultInfo(): Promise<void> {
  const names = Object.keys(await loadSecrets());
  $("vault-info").textContent = names.length ? `stored: ${names.join(", ")}` : "empty";
}

$("save-secrets").addEventListener("click", async () => {
  const secrets = await loadSecrets();
  const pw = $<HTMLInputElement>("secret-password");
  const otp = $<HTMLInputElement>("secret-otp");
  if (pw.value) secrets.PASSWORD = pw.value;
  if (otp.value) secrets.OTP = otp.value;
  await saveSecrets(secrets);
  pw.value = otp.value = "";
  await refreshVaultInfo();
});

$("clear-secrets").addEventListener("click", async () => {
  await clearSecrets();
  await refreshVaultInfo();
});

$<HTMLInputElement>("privacy").addEventListener("change", (e) => {
  $("privacy-box").style.display = (e.target as HTMLInputElement).checked ? "" : "none";
});

$("capture").addEventListener("click", async () => {
  $("err").textContent = "";
  // ?tab=<id> lets tests target a tab when the panel is opened as a normal tab.
  const tab = new URLSearchParams(location.search).get("tab");
  const res = await chrome.runtime.sendMessage({ type: "capture", tabId: tab ? Number(tab) : undefined });
  if (!res?.ok) {
    $("err").textContent = res?.error ?? "capture failed";
    return;
  }
  render(res.result as ObserveResult);
});

void refreshVaultInfo();

// ---- agent task loop UI -------------------------------------------------------------------
const tabParam = () => {
  const t = new URLSearchParams(location.search).get("tab");
  return t ? Number(t) : undefined;
};

function setRunning(running: boolean): void {
  $<HTMLButtonElement>("start").disabled = running;
  $<HTMLButtonElement>("stop").disabled = !running;
}

$("start").addEventListener("click", async () => {
  const task = $<HTMLInputElement>("task").value.trim();
  if (!task) return;
  $("log").replaceChildren();
  showQuestion(undefined);
  $("status").textContent = "running...";
  const res = await chrome.runtime.sendMessage({ type: "agent:start", task, tabId: tabParam() });
  if (res?.ok) setRunning(true);
  else $("status").textContent = res?.error ?? "could not start";
});

$("stop").addEventListener("click", () => void chrome.runtime.sendMessage({ type: "agent:stop" }));

// ---- settings -----------------------------------------------------------------------------
async function showSettings(): Promise<void> {
  const s = await getSettings();
  $<HTMLInputElement>("set-server").value = s.serverUrl;
  $<HTMLInputElement>("set-steps").value = String(s.maxSteps);
  $<HTMLInputElement>("set-timeout").value = String(Math.round(s.stepTimeoutMs / 1000));
  $<HTMLTextAreaElement>("set-origins").value = s.extraOrigins.join("\n");
}

$("save-settings").addEventListener("click", async () => {
  const origins = $<HTMLTextAreaElement>("set-origins").value.split("\n").map((x) => x.trim()).filter(Boolean);
  const res = await saveSettings({
    serverUrl: $<HTMLInputElement>("set-server").value,
    maxSteps: Number($<HTMLInputElement>("set-steps").value),
    stepTimeoutMs: Number($<HTMLInputElement>("set-timeout").value) * 1000,
    extraOrigins: origins,
  });
  $("settings-msg").textContent = res.errors.length ? res.errors.join(" ") : "saved";
  if (!res.errors.length) await showSettings();
});

$("reset-settings").addEventListener("click", async () => {
  await saveSettings(DEFAULTS);
  await showSettings();
  $("settings-msg").textContent = "defaults restored";
});

// ---- answering ask_user ---------------------------------------------------------------------
function showQuestion(question: string | undefined): void {
  $("reply-box").style.display = question ? "" : "none";
  if (question) $("status").textContent = `ask_user: ${question}`;
}

$("send-reply").addEventListener("click", async () => {
  const answer = $<HTMLInputElement>("reply").value.trim();
  if (!answer) return;
  const res = await chrome.runtime.sendMessage({ type: "agent:reply", answer });
  if (res?.ok) {
    $<HTMLInputElement>("reply").value = "";
    showQuestion(undefined);
    $("status").textContent = "running...";
    setRunning(true);
  } else $("status").textContent = res?.error ?? "could not send the answer";
});

// Reopening the panel (or a restarted worker) must show what the agent is doing now.
void showSettings();
void chrome.runtime.sendMessage({ type: "agent:status" }).then((s: { running: boolean; waiting?: string } | undefined) => {
  if (s?.running) {
    setRunning(true);
    $("status").textContent = "running...";
  } else showQuestion(s?.waiting);
});

chrome.runtime.onMessage.addListener((e: AgentEvent) => {
  if (e.type === "agent:step") {
    const div = document.createElement("div");
    div.className = "step";
    const timing = Object.entries(e.timings).map(([k, v]) => `${k} ${v}ms`).join(", ");
    div.append(`step ${e.step}: ${JSON.stringify(e.action)} [${e.status}] ${timing}`);
    if (e.note) div.append(document.createElement("br"), `note: ${e.note}`);
    const img = document.createElement("img");
    img.src = e.image;
    div.append(document.createElement("br"), img);
    $("log").append(div);
    // The Privacy view always shows exactly what left the device for the latest step.
    $<HTMLImageElement>("shot").src = e.image;
    $("json").textContent = JSON.stringify(JSON.parse(e.payloadJson), null, 2);
  } else if (e.type === "agent:resumed") {
    $("status").textContent = `resumed at step ${e.step} after the browser restarted the agent`;
    setRunning(true);
  } else if (e.type === "agent:end") {
    $("status").textContent = `${e.reason}: ${e.message}`;
    setRunning(false);
    showQuestion(e.reason === "ask_user" ? e.message : undefined);
  }
});
