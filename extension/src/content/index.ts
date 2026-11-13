import type { ExecuteMsg } from "../shared/protocol";
import type { Msg } from "../shared/types";
import { execute } from "./execute";
import { boxesForRanges, snapshot } from "./snapshot";

// The page may get this script twice (manifest match and background injection); only the first copy answers.
const w = window as unknown as { __privasightContent?: boolean };
if (!w.__privasightContent) {
  w.__privasightContent = true;
  chrome.runtime.onMessage.addListener((msg: Msg | ExecuteMsg | { type: "ping" }, _sender, sendResponse) => {
    if (msg.type === "ping") sendResponse({ ok: true });
    else if (msg.type === "snapshot") sendResponse(snapshot());
    else if (msg.type === "boxes") sendResponse(boxesForRanges(msg.items));
    else if (msg.type === "execute") sendResponse(execute(msg.action));
    return false;
  });
}
