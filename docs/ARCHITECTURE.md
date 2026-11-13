# PrivaSight architecture

PrivaSight is a browser agent that never shows the AI server the user's personal data. A Chrome (MV3) extension perceives
the page, finds and hides personal data **on the device**, and sends only a redacted screenshot plus sanitised element list to
an agent server. The server asks an open-weights vision-language model (VLM) for the next action. The extension puts the
real values back only at the moment it acts on the page.

The rule behind every design choice: **no raw screenshot, raw DOM text or secret value ever leaves the extension**. The leak
guard enforces it, and the evaluation checks it against the server's own request log.

## 1. Components

```
┌──────────────────────────── Chrome extension (on the device) ─────────────────────────────┐
│                                                                                          │
│  side panel ──── task, secrets, live log, Privacy view, Settings                          │
│      │  chrome.runtime messages                                                          │
│  background service worker (src/background)                                              │
│      ├── agent.ts      step loop, retries, step limit, ask_user, resume after the worker dies   │
│      ├── observe.ts    one perception step: capture → detect → paint → sanitise → leak guard  │
│      ├── capture.ts    captureVisibleTab, origin allowlist, content-script injection        │
│      ├── painter.ts    black boxes / blur, Set-of-Marks, downscale to 1280 px               │
│      └── ml.ts ──────► offscreen document (src/offscreen): MediaPipe faces, BERT NER       │
│                          (worker), Tesseract OCR. The only place ML runs.                │
│  content script (src/content) in the page: snapshot(), boxes for text ranges, execute()  │
│  redaction/ rules (Layer A), regex (Layer B), regions, placeholder map, leak guard       │
│  vault/ secrets in chrome.storage.session, {PASSWORD}/{OTP}/{SECRET:x} substitution     │
└──────────────────────────────────────┬───────────────────────────────────────────────────┘
                                       │ POST /v1/step  (redacted PNG + sanitised JSON only)
                                       ▼
┌──────────────── agent server (server/app, FastAPI, stateless per request) ────────────────┐
│ prompt.py (redaction-aware, versioned) → vlm.py (OpenAI-compatible client) → parser.py    │
│ (first JSON object, Pydantic validation, one retry, typed-PII rejection) → audit.py log   │
└──────────────────────────────────────┬───────────────────────────────────────────────────┘
                                       ▼
          VLM: Qwen3-VL (Ollama on a laptop, vLLM or training/serve_hf.py on a GPU)

testsites/ synthetic sites with Faker en_IN personas and ground truth  ·  eval/ Playwright harness
training/ dataset builders, LoRA trainer, NER fine-tune             ·  docs/ this file, decisions, progress
```

| Part | Where | Responsibility |
|---|---|---|
| Side panel | `extension/src/sidepanel` | Task box, secret entry, start/stop, `ask_user` reply box, live step log, **Privacy view** (the exact image and JSON that left the device), Settings |
| Service worker | `extension/src/background` | Runs the loop; only component that talks to the server; holds the raw screenshot only inside `observe()` |
| Offscreen document | `extension/src/offscreen` | On-device ML (service workers have no usable WebGPU/canvas): face detection, NER in a Web Worker, OCR |
| Content script | `extension/src/content` | DOM snapshot with boxes, `data-ps-id` marks, character-exact boxes for detected spans, action executor |
| Redaction library | `extension/src/redaction` | Pure functions, unit-tested: DOM rules, regex detectors with validators, region builder, outgoing payload builder, placeholder map, leak guard |
| Vault | `extension/src/vault` | Secrets in `chrome.storage.session` (memory only), substitution at execution time |
| Agent server | `server/app` | Prompt, VLM call, parsing/validation/retry, audit log; never receives or stores real values |
| Test sites | `testsites/` | DemoBank, HR Portal, Hospital, ShopMart, MailBox, VideoMeet rendered per persona, ground truth, `/check` state |
| Evaluation | `eval/` | Phase checks, redaction metrics, task harness, reports, demo recorder |
| Training | `training/` | Oracle trajectories, Mind2Web builder, LoRA trainer/evaluator/server, NER fine-tune |

## 2. One agent step

```
side panel: "Log in as user04 with the stored password, then change the mobile number to 9872057110"
   │                                   vault: PASSWORD = ******** (never sent)
   ▼
agent.ts loop(step n)
 1. observe(tab)
    a. content script snapshot(): interactive elements {id, tag, role, type, label, placeholder, text, bbox},
       visible text nodes with boxes, <img>/<video>/<canvas> boxes; password values are never read
    b. captureVisibleTab → raw PNG (stays in the worker / offscreen document)
    c. Layer B regex on node text in the page; a Range over the exact characters gives their boxes
    d. offscreen ML: faces (MediaPipe BlazeFace, full frame at 640 px + each image crop), NER on text
       nodes and input values (cached per text), OCR on images/canvases without a face
    e. regionsFor(): Layer A field rules + vault values in text + regex spans + NER spans + faces/video/OCR
    f. painter: black box + category label for text/fields, Gaussian blur (r ≥ 12 px) for faces and video,
       then numbered Set-of-Marks boxes on the redacted image, downscaled to ≤ 1280 px wide
    g. buildOutgoing(): labels kept, sensitive values dropped, PII replaced by [PHONE_1]-style placeholders
       (same value → same placeholder for the whole task), redaction_summary counts
    h. leak guard on the JSON string: vault values (exact and without spaces/dashes), every value the
       placeholder map replaced this session, and the regex detectors again → any hit blocks the send
 2. task text sanitised the same way ("… to [PHONE_1]"); the whole request leak-guarded again
 3. POST /v1/step  {session_id, step, task, url, title, viewport, elements, texts, available_secrets (names only),
                     redaction_summary, history, screenshot (redacted PNG)}
 4. server: system prompt v1.2 + user text → VLM → first JSON object → Pydantic → element id exists? →
    typed text that looks like real PII and is not a placeholder? → one retry with the error, else ask_user
 5. StepResponse {status, action, model, latency_ms, message}
 6. extension: type "{PASSWORD}" → vault value; type "[PHONE_1]" → value from the session map; executed by the
    content script (native value setter + input/change events, synthetic pointer/mouse event sequence for clicks, same-origin navigate)
 7. history keeps the placeholders; state saved to chrome.storage.session; repeat until done / ask_user / step limit
```

The placeholder map and loop state live in `chrome.storage.session` (memory only) and are cleared when the task ends.

## 3. Redaction pipeline

Three detector families produce **regions** `{bbox, category, source, confidence, placeholder}`; they are unioned, painted,
and mirrored in the text payload.

| Layer | Detects | How | Source tag |
|---|---|---|---|
| A. DOM rules | password, OTP, CVV, PIN, card, Aadhaar, PAN, account, IFSC, DOB, security-answer **fields** | `type=password`, `autocomplete` tokens, keyword tokens on name/id/aria-label/placeholder/`<label>` (word-boundary matching). The value is never read; the label stays visible | `dom` |
| Vault | a stored secret shown anywhere in page text | substring match (≥ 4 characters) | `vault` |
| B. Regex | Aadhaar (Verhoeff), PAN (4th letter), Indian phone, email, card (Luhn), IFSC, account and DOB (keyword within ±40 characters), Indian addresses, currency (off by default) | `redaction/regex.ts`; longest span wins | `regex` |
| B. NER | person names, locations (organisations only if they look like a person) | BERT token classifier (fine-tuned on Indian names, int8 ONNX, Transformers.js in a worker), whole-word widening, UI-vocabulary stoplist | `ner` |
| C. Faces | faces in the screenshot and in every image | MediaPipe BlazeFace short-range, box +15%, IoU merge; every `<video>` blurred by default | `face` |
| OCR fallback | PII inside `<img>`/`<canvas>` | Tesseract.js, then regex + NER on the OCR lines; at most 3 images per step, cached by pixel fingerprint | `ocr` |

Input fields holding ordinary values (a typed name or phone) are read locally, checked by regex and NER, and if they hold
PII the whole field is painted and only `[TYPE_n]` is sent.

**Defence in depth.** (1) Values are removed before the payload is built; (2) the leak guard re-checks the final JSON string;
(3) the server rejects typed text that looks like PII and is not a placeholder; (4) the evaluation scans the server's audit log
for every value of all 50 personas.

## 4. Protocol

`StepRequest` / `StepResponse` are defined twice and kept identical: TypeScript in `extension/src/shared/protocol.ts`
and Pydantic in `server/app/schemas.py`. Actions: `click`, `type` (with `clear_first`), `select`, `scroll`, `press_key`,
`navigate` (same origin), `wait` (≤ 3 s), `ask_user`, `done`. `available_secrets` carries names only.

Placeholders the model may use:

| Form | Meaning | Resolved by |
|---|---|---|
| `{PASSWORD}`, `{OTP}`, `{SECRET:name}` | a vault secret | `vault/substitute()` at execution time; a missing name pauses with `ask_user` |
| `[PHONE_1]`, `[NAME_2]`, … | a value the user can see, or that appeared in the task text | the session `RedactionMap` at execution time |
| `[REDACTED_PASSWORD]` etc. | a hidden field value | not typeable; the model must use the vault form |

## 5. Hardening (Phase 9)

- **Origins**: the agent acts only on `http://localhost:8080` plus exact origins added in Settings; it refuses every other tab, and `navigate` is same-origin.
- **Service-worker death**: loop state is saved after every step; a Chrome alarm wakes a killed worker and `resumeInterrupted()` continues. An action that was in flight is recorded as "interrupted: look at the screen" so it is not blindly repeated.
- **ask_user**: pauses with the placeholder map kept; the user's answer is sanitised like the task text.
- **Stuck loop**: the same action three times in a row pauses with a question.
- **Errors**: server unreachable, model timeout (no retry), HTTP errors, closed tab, blocked origin all end the task with a plain message.

## 6. Evaluation harness

| Script | Measures |
|---|---|
| `eval/phase1..4_*.mjs`, `phase9_check.mjs` | Acceptance checks per phase (capture, Privacy view, login with a vault secret, structured recall, placeholder round trip, hardening) |
| `eval/phase5_eval.mjs` | Recall per category, pixel check, precision, leakage in the outgoing JSON, local latency (WebGPU/WASM), **layer ablation** |
| `eval/run_eval.py` → `run_tasks.mjs` → `report.py` | Live task success over 32 task YAMLs × conditions × 3 runs, steps, latency, leakage from the server log |
| `eval/run_all.py` | The full check suite (no GPU, scripted model), run twice for the Phase 9 acceptance |
| `eval/final_report.py` | The final tables and charts (`docs/RESULTS.md`, `eval/reports/final/`) |
| `eval/record_demo.mjs` | The demo video (page + Privacy view side by side, captions, audit at the end) |

The **unsafe clean-screens baseline** exists only as an evaluation build (`npm run build:clean` → `dist-clean`, flag
`VITE_EVAL_CLEAN=1`) plus a server switch (`ALLOW_TYPED_PII=1`); `npm run check:no-clean` proves the shipped build has none of it.

## 7. Training

- **VLM LoRA** (`training/`): expert trajectories recorded by running the real extension against a scripted oracle (the server's
  audit log is the dataset, so the training screens carry the true on-device redaction), plus Mind2Web through a Python port of
  the redaction; split by website; the redacted dataset is scanned for persona values before it is written. QLoRA r16 on
  Qwen3-VL-2B (Kaggle T4). Served for live evaluation by vLLM (`--enable-lora`) or `serve_hf.py`.
- **NER** (`training/ner/`): 24k synthetic UI snippets with Indian names, fine-tune of `dslim/bert-base-NER`, int8 ONNX export
  straight into the extension's model folder. Without it the extension falls back to `Xenova/bert-base-NER`.

## 8. Where data lives

| Data | Lives in | Leaves the device? |
|---|---|---|
| Raw screenshot | service worker → offscreen document memory | never |
| DOM text, input values | content script → worker memory | never; only sanitised text |
| Vault secrets | `chrome.storage.session` (memory) | never; names only |
| Placeholder map | `chrome.storage.session` | never; cleared when the task ends |
| Redacted screenshot + sanitised JSON | sent to the agent server | yes, the only thing that does |
| Server audit log | `server/logs/<session>/` | server side; used by the evaluation, deletable via `POST /v1/session/end` |

## 9. Limits

Chromium only (see `FIREFOX.md`); the VLM runs on a server, not the device; names in free prose and non-Latin scripts are
less well covered than structured PII; OCR can misread characters and is capped at three images per step; the agent acts only
on allowed origins and does not handle CAPTCHAs or payments.
