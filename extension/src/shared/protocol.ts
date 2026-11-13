// Wire protocol (Section 7). Keep identical to server/app/schemas.py.
import type { OutgoingElement } from "./types";

export type Action =
  | { type: "click"; element_id: number }
  | { type: "type"; element_id: number; text: string; clear_first?: boolean }
  | { type: "select"; element_id: number; option: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "press_key"; key: "Enter" | "Tab" | "Escape" }
  | { type: "navigate"; url: string }
  | { type: "wait"; ms?: number }
  | { type: "ask_user"; question: string }
  | { type: "done"; summary: string };

export interface HistoryItem {
  step: number;
  action: Action;
  result: string;
}

export interface StepRequest {
  session_id: string;
  step: number;
  task: string;
  url: string;
  title: string;
  screenshot: string;
  viewport: { width: number; height: number; scale: number };
  elements: OutgoingElement[];
  texts: string[];
  available_secrets: string[];
  history: HistoryItem[];
  redaction_summary: Record<string, number>;
}

export interface StepResponse {
  status: "continue" | "done" | "error";
  action: Action;
  model: string;
  latency_ms: number;
  message: string;
}

/** Messages between background, content script and side panel. */
export type ExecuteMsg = { type: "execute"; action: Action };
export interface ExecuteResult {
  ok: boolean;
  result: string;
}

export type AgentEvent =
  | { type: "agent:step"; step: number; image: string; action: Action; status: string; timings: Record<string, number>; payloadJson: string; note?: string }
  | { type: "agent:resumed"; step: number }
  | { type: "agent:end"; reason: "done" | "ask_user" | "error" | "stopped" | "step_limit"; message: string };
