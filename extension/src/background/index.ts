import { WATCHDOG, agentStatus, isRunning, replyToAgent, resumeInterrupted, runTask, stopTask } from "./agent";
import { syncContentScripts } from "./capture";
import { warmUp } from "./ml";
import { observe } from "./observe";
import { resetMap } from "./session";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Load the on-device models in the background so the first step does not pay for it.
void warmUp().catch((e) => console.warn("[ml] warm-up failed", e));

// Settings changes take effect at once (origins, server URL, limits are read when a task starts).
void syncContentScripts().catch((e) => console.warn("[settings] content script sync failed", e));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void syncContentScripts().catch((e) => console.warn("[settings] content script sync failed", e));
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === WATCHDOG) void resumeInterrupted().catch((e) => console.warn("[agent] resume failed", e));
});
// If the previous worker was killed in the middle of a task, continue it.
void resumeInterrupted().catch((e) => console.warn("[agent] resume failed", e));

type PanelMsg =
  | { type: "capture"; tabId?: number }
  | { type: "agent:start"; task: string; tabId?: number }
  | { type: "agent:stop" }
  | { type: "agent:reply"; answer: string }
  | { type: "agent:status" };

chrome.runtime.onMessage.addListener((msg: PanelMsg, _sender, sendResponse) => {
  if (msg.type === "capture") {
    // A manual capture is its own session: start with a fresh placeholder map.
    resetMap().then(() => observe(msg.tabId)).then(
      (result) => sendResponse({ ok: true, result }),
      (e) => sendResponse({ ok: false, error: String(e) }),
    );
    return true; // async response
  }
  if (msg.type === "agent:start") {
    if (isRunning()) sendResponse({ ok: false, error: "a task is already running" });
    else {
      void runTask(msg.task, msg.tabId); // progress arrives as agent:* events
      sendResponse({ ok: true });
    }
    return false;
  }
  if (msg.type === "agent:stop") {
    stopTask();
    sendResponse({ ok: true });
  }
  if (msg.type === "agent:reply") {
    replyToAgent(msg.answer).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "agent:status") {
    agentStatus().then(sendResponse, () => sendResponse({ running: false }));
    return true;
  }
  return false;
});
