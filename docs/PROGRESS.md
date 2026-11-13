# Progress

## Phase 1 — Skeleton and test site (in progress)

Built:
- Monorepo layout: `extension/`, `testsites/`, `server/`, `eval/`, `training/`, `docs/`.
- Persona generator (50 seeded en_IN personas, valid Aadhaar/Luhn/PAN) -> `testsites/personas.json`.
- DemoBank site (login, dashboard, profile, transfer) with ground-truth JSON and `/demobank/check`.
- MV3 extension: background capture, content-script snapshot + element marking (`data-ps-id`), side panel with numbered boxes.

Tests: `cd testsites/generator && python -m pytest`; `cd extension && npx tsc --noEmit && npx vite build` pass.

Acceptance verified automatically: `cd eval && node phase1_check.mjs` (needs `serve.py` running and `npx playwright install chromium`) loads the built extension in Chromium, opens DemoBank login and captures it. The side panel shows the screenshot with numbered boxes on all 3 interactive elements (`eval/phase1.png`). Password value is not read. CI not set up.

Known issues: no persona photos yet; no GitHub CI workflow.

## Phase 2 — DOM redaction and leak guard (done)

Built (`extension/src`):
- `redaction/rules.ts`: Layer A rules (type=password, autocomplete tokens, keyword tokens on name/id/aria-label/placeholder/label, word-boundary matching so "shipping" or "panel" do not match).
- `redaction/regions.ts`: region builder (DOM rules + vault values found in page text), text sanitiser, outgoing payload builder (redacted fields keep their label only).
- `redaction/leakGuard.ts`: blocks on exact or space/dash-stripped vault values; reports secret names, never values.
- `vault/index.ts`: chrome.storage.session vault, `substitute()` for {PASSWORD}, {OTP}, {SECRET:name}, missing names reported.
- `background/painter.ts`: black boxes with category label, then Set-of-Marks on the redacted image; the raw screenshot never leaves the background worker.
- Side panel: secret entry, Privacy view (redacted image, painted regions, exact outgoing JSON), leak-guard banner, per-stage timings.

Tests: `cd extension && npx vitest run` (33 pass: rule fixtures, sanitiser, vault, leak guard, outgoing payload). `cd eval && node phase2_check.mjs` (needs serve.py running): typed password and vault OTP never appear in outgoing JSON, password box pixels are black (`eval/phase2.png`). Phase 1 check still passes.

Bug caught by tests: the text walker read `<option>` text of a sensitive `<select>`; it now skips text inside select/textarea.

Known gaps (by design, later phases): values typed into ordinary inputs (e.g. username) and PII in page text/pixels are not redacted until Layer B (regex, Phase 4) and NER/faces (Phase 5); input values are not sent at all for now. Painter runs in the service worker (OffscreenCanvas) and moves to the offscreen document in Phase 5.

## Phase 3 — Server and first end-to-end loop (done)

Built:
- `server/app`: FastAPI (`/v1/step`, `/health`, `/v1/session/end`), Pydantic schemas (`schemas.py`, mirrored in `extension/src/shared/protocol.ts`), versioned redaction-aware prompt (`prompt.py`, v1.0), first-JSON extraction + validation + one retry with the error appended + `ask_user` fallback (`parser.py`, `agent.py`), PII-in-typed-text rejection, audit log of every request (`server/logs/<session>/requests.jsonl` + redacted step PNGs), OpenAI-compatible VLM client configured by env (`VLM_BASE_URL`, `VLM_MODEL`, `VLM_TEMPERATURE`, ...).
- Extension: step loop (`background/agent.ts`: observe, leak-guard, call server with 2 retries, execute, settle, history; keep-alive for the MV3 worker; 15-step limit; stop button), action executor (`content/execute.ts`: click, type via native setter, select, scroll, press_key, same-origin navigate, wait), placeholder substitution at execution time only, side panel task box + live step log + Privacy view of the latest step, screenshots downscaled to 1280 px wide.

Tests: `cd server && python -m pytest` (8 pass); `cd extension && npx vitest run` (37 pass).

Plumbing acceptance with a scripted stand-in model (`eval/fake_vlm.py`; reads the text prompt, not the image): `node phase3_check.mjs 3` -> login success 3/3 (reaches the dashboard in 4 steps, about 4 s), server logs contain no password. The model only ever sends `{PASSWORD}`; the extension substitutes it, so the login working proves substitution. This validates the pipeline, NOT model quality.

Real-model acceptance (Ollama, `qwen3-vl:2b-instruct` with an 8k-context Modelfile, laptop with 4 GB RTX 3050, partly CPU): `cd eval && node phase3_check.mjs 5` -> **login success 5/5**, 15 s per run after the first (28 s with model load), about 1.1-3.3 s model time per step, 6 steps per run; server logs contain no password.

Problems found with the real model and fixed:
- The default `qwen3-vl:2b` tag is a thinking model: it spent the 300-token budget on reasoning and returned empty content (Ollama ignores think:false). Switched to the Instruct tag; the server now raises an explicit error on empty content.
- The model typed the bare word `PASSWORD` instead of `{PASSWORD}` -> the parser now normalises bare secret names to placeholders; prompt v1.1 spells out the braces.
- The model claimed "done" while the login form was still showing -> prompt v1.1 requires the current page to show the result.
- `/health` reported `model_installed:false` for untagged names (Ollama lists `name:latest`) -> fixed.
Remaining quirk: the model clicks Sign in once before typing the password (a wasted step, harmless).

Not done yet (Phase 9): resuming a task after the MV3 worker is killed mid-run (loop state is not persisted yet; the keep-alive timer is the current mitigation).

## Phase 4 — Regex PII and remaining sites (done)

Built:
- `extension/src/redaction/regex.ts`: detectors with validators: Aadhaar (Verhoeff, 4-4-4 grouping), PAN (4th-letter check), Indian phone (+91/0/grouped), email, card (Luhn, spaces/dashes), IFSC, account number and date of birth (keyword within +-40 chars, including the sibling label), currency (off by default). Longest span wins overlaps.
- Span-to-box mapping (`content/snapshot.ts`): a Range over exactly the detected characters -> `getClientRects()`; text-input values with PII are read locally and the whole field is painted. Sensitive-field values are still never read.
- `redaction/redactionMap.ts`: `[PHONE_1]`-style placeholders, same value -> same placeholder (formatting-insensitive), restored only at execution time (`background/agent.ts`), mirrored to chrome.storage.session, cleared when the task ends. The task text is sanitised too.
- Leak guard now also re-runs the regex detectors over the outgoing JSON (`PII:<CATEGORY>` hits block the send; values are never reported). Viewport scale is rounded so float digits cannot look like numbers.
- Five more sites (`testsites/generator/site_*.py`): HR Portal, Hospital, ShopMart, MailBox, VideoMeet, plus DemoBank ported to the shared kit; layout variants `?v=dark|serif|large|shift`; ground truth live at `/groundtruth/<site>/<page>` and dumped by `dump_groundtruth.py`; generic `/<site>/api/<action>` + `/<site>/check` state for the Phase 6 task checks.
- Server: `value` on elements (placeholder-only), prompt v1.2 shows it.

Acceptance (`cd eval && node phase4_recall.mjs 5`; needs serve.py): 350 captures (14 pages x 5 layouts x 5 personas), **structured PII recall 100.00% (800/800)** (>= 98% required), every ground-truth location >= 90% covered by painted regions AND black in the redacted image, 0 PII values in any outgoing JSON; per category: Aadhaar, Account, Card, DOB, Email, IFSC, PAN, Phone all 100%. Report: `eval/reports/phase4_recall.json`.
Round trip (`node phase4_roundtrip.mjs`, scripted model): the model only saw `[PHONE_n]`; the extension typed the real number locally; the site's phone changed; server logs contain neither number.
Regression: Phase 1-3 checks pass, 53 extension + 11 server + 3 generator tests pass.

Method note: the first recall run showed 91.9% because misses were measured against the full element box; in the `shift` layout a flex item is ~650 px wide while its text is ~80 px. Ground-truth geometry is now the text extent (Range) for text and the field box for inputs; the redaction itself was already correct.

Known gaps (later phases): names, addresses and faces are not detected yet (NAME 450, ADDRESS 75, FACE 100 ground-truth items reported at 0% by design; Phase 5). Persona photos are cartoon SVG avatars (not real faces): Phase 5 needs a licensed synthetic-face set for the face detector. The real-model (Ollama) login was not re-run after the Phase 4 changes (scripted-model regression passes).

## Phase 5 — Faces and NER in the browser (done)

Built (`extension/src/offscreen/`, `background/ml.ts`, `observe.ts`):
- Offscreen document (the only place ML runs; config arrives by message because offscreen pages only get `chrome.runtime`). Models load in the background at extension start; first step does not wait.
- **Faces**: MediaPipe BlazeFace (GPU delegate, CPU fallback), two passes: full screenshot downscaled to 640 px, plus every <img>/<video> crop upscaled (a face in a 150 px photo is tiny in a 1280 px screenshot); boxes widened 15%, merged by IoU; painted with Gaussian blur (radius >= 12 px). Every <video> is blurred by default.
- **NER**: `Xenova/bert-base-NER` via Transformers.js in a worker, all files local (no network at runtime). One sequence per text node, length-sorted batches of 16, cache per text so unchanged text is never re-scored; texts that are generic UI vocabulary, have no capital letter, or are already covered by regex are not scored. Character offsets are rebuilt by aligning tokens to the text (Transformers.js returns none), entities widened to whole words, person words joined.
- **Addresses**: regex detector for Indian-style addresses (comma-separated parts ending in a PIN, or house-number + street word); all 100 synthetic persona addresses detected as one full-length span.
- **OCR fallback**: Tesseract.js (local files) for canvases and images that contain no face, max 3 per step, result cached by pixel fingerprint; detections (regex + NER on the OCR text) become one padded box per detection.
- **Placeholders for names/locations**: values found by NER are learned by the session map and replaced in every outgoing string (labels, titles, element text, input values); the leak guard now also blocks if any value that was replaced this session is still in the JSON (`PII:ENTITY`).
- Input values of ordinary text fields are read locally, checked (regex + NER), and the whole field is painted when it holds PII; only `[TYPE_n]` placeholders are sent.

Acceptance (`cd eval && node phase5_eval.mjs 3 ",dark,serif,large,shift" wasm`; 225 captures = 15 pages x 5 layouts x 3 personas; needs serve.py):
- Faces on VideoMeet and HR/Hospital photos: **90/90 covered and blurred** (GPU delegate; 97.2% on the CPU delegate).
- Text PII (structured + names + addresses): **recall 99.1% (922/930)**; per category 100% for Aadhaar, account, address, card, CVV, DOB, email, IFSC, phone; names 98.9%; PAN 83.3%. **0 ground-truth values in any outgoing JSON**; leak guard never had to block.
- Redaction precision (painted area on ground truth): 94.5% (target >= 80%).
- Local latency (ml + map + rules + paint, excl. screenshot capture and the one-time model load): realistic multi-step mix (6 personas x 15 pages): median **78 ms** (WASM NER) / 93 ms (WebGPU NER), p95 200 / 222 ms. Cache-miss pages (fresh names, 1 persona): median **337 ms**, p95 ~600 ms, NER median 171 ms (target < 200 ms on cache miss; total < 500 ms median). Face detection median 18 ms. First step after install: 2-5 s (WASM) or 4-12 s (WebGPU) model load.
- WebGPU vs WASM for NER: fp16 on WebGPU has the lower median (110 ms vs 171 ms) but a much worse p95 (~2.7 s: shaders recompile for each new padded length) and a 216 MB model; int8 on WASM is the default. int8 on WebGPU was slower than WASM (606 ms; int8 ops fall back to the CPU).
- OCR on the canvas ID card (`hr/idcard`, text not in the DOM): 15/16 items; the one miss is a PAN the OCR misread.
- Regression: Phase 1-4 checks pass; 69 extension tests, 11 server tests.

Misses and caveats (honest list):
- The English-trained NER model is the weak part for Indian names: it tags many as ORG or splits them into word-pieces. Fixes in place: widen to whole words, treat a short Title-case "organisation" without an organisation word as a person, promote a short Title-case node when the model saw part of it, a UI-vocabulary stoplist (it confidently tags "Aadhaar" as a person). These are heuristics; the Indian-PII fine-tune (Phase 8) is the real fix. Single-word names in UI-looking nodes and unusual names can still be missed on other sites.
- 3 "shift"-layout name misses are a measurement artefact (the name wraps over two lines; the reference box includes empty space), not a redaction miss.
- OCR can misread characters (one PAN), and OCR is capped at 3 images per step.
- Ground truth now also lists empty sensitive fields (payee account, card number, CVV) and the HR/Hospital photos; mail body names are not listed (counted as precision loss although correct).
- The real Qwen model (Ollama) login was not re-run after Phase 5 (scripted-model regression passes; memory on this laptop is tight).

## Phase 6 — Evaluation harness and baselines (harness done; 2B redacted and clean baselines complete; 4B and GUI-Owl not run)

Built (`eval/`):
- **32 tasks** in `eval/tasks/*.yaml` across the six sites (DemoBank 6, HR 6, Hospital 5, ShopMart 6, MailBox 5, VideoMeet 4): login, form updates with a new phone or address in the task text (exercises the placeholder round trip), leave and appointment booking, add-to-cart, checkout with vault secrets (card, CVV), mail reply and compose, leave a meeting. Each task has a start page, a persona, secrets and `expect` rules checked against the site state.
- **Site `/check` state**: every `/<site>/api/<action>` stores the last body; logins are recorded too; `/<site>/check?p=<id>` returns it. `POST /reset` clears it before each run.
- **Runner** `run_tasks.mjs` (Node + Playwright, driving the real unpacked extension through the side panel as the test hook): resets the site, loads the vault secrets, starts the task, records every step event with timestamps, checks the final site state and the step limit, and scans the agent server request logs for every sensitive value of all 50 personas (exact and with spaces/dashes removed) plus the task secrets. Results are appended per run to `eval/results/<condition>.jsonl`; `--resume` continues and re-runs runs that ended in a timeout or an error before step 1.
- **`report.py`**: tables and four charts (success by site, steps, latency, leakage) into `eval/reports/phase6/` (`summary.md`, `runs.csv`, `per_task.csv`); success is mean ± std over runs.
- **`run_eval.py`**: the one command. Starts the test sites, Ollama and the agent server for each condition, builds the extensions, runs the tasks, writes the report. Keeps the machine awake (a sleeping laptop stalls Chrome screenshots and looks like a hung agent).
- **Evaluation-only clean build**: `npm run build:clean` makes `extension/dist-clean`, the unsafe baseline that sends clean screens (no redaction, no leak guard, task text unsanitised); `ALLOW_TYPED_PII=1` on the server turns off the typed-PII rejection for that condition. All of it is compiled out of the shipped build (`npm run check:no-clean` verifies, and `run_eval.py` runs it) and the server switch is off by default (a test covers both).

Baseline results, Qwen3-VL-2B-Instruct on Ollama (8k context), this laptop (RTX 3050 4 GB, partly on CPU), 32 tasks x 3 runs = 96 runs (`python run_eval.py`; tables in `eval/reports/phase6/summary.md`):

| Condition (redacted = PrivaSight) | Task success (mean ± std over 3 runs) | Steps/task | E2E step median / p95 | Local redaction median / p95 | Model median / p95 | Runs with a PII leak |
|---|---|---|---|---|---|---|
| Qwen3-VL-2B, redacted | **44.8% ± 3.6** (43/96; runs: 46.9, 46.9, 40.6) | 6.3 | 3.7 s / 7.5 s | 176 ms / 660 ms | 2.7 s / 5.9 s | **0 of 96** |
| Qwen3-VL-2B, clean screens (unsafe) | **38.5% ± 1.8** (37/96) | 5.9 | 2.9 s / 41.9 s | 159 ms / 358 ms (no redaction done) | 2.1 s / 41.1 s | **66 of 96** (NAME 108, PHONE 69, EMAIL 63, ADDRESS 30, DOB 21, AADHAAR 18, ACCOUNT 9, IFSC 9 occurrences) |

Redacted success by site: ShopMart 66.7%, Hospital 60.0%, HR 50.0%, VideoMeet 50.0%, DemoBank 27.8 ± 9.6, MailBox 13.3 ± 11.5. Leakage is 0 for the redacted condition, which is the Phase 6 requirement.

How the 53 failed redacted runs ended: 30 claimed "done" with the wrong final state, 13 hit the 15-step limit, 10 stopped with `ask_user`. Tasks passed 3/3: DemoBank update phone, Hospital login and book Neurology, HR open ID card, update address and update contact, ShopMart login and three add-to-cart tasks, VideoMeet leave (x2). Passed 0/3: the DemoBank, HR and VideoMeet logins, both mail replies, both mail composes, both checkouts, the payee tasks, HR leave requests. Observed failure modes of the 2B model (not harness problems; checked in the server logs):
- It clicks the username field and then types the password into the next field without ever typing the username (DemoBank/HR/VideoMeet login), then reports success after seeing "Invalid credentials".
- Fields that were redacted on purpose (payee account and IFSC, card, CVV) look like missing information, so it stops with `ask_user` (DemoBank add-payee 3/3 runs) instead of typing the placeholder or vault secret.
- Multi-field forms (leave dates and reasons, mail bodies) are filled partly or into the wrong field.
These are the gaps Phase 7 (redaction-aware LoRA) targets.

Not done, stated plainly:
- **Qwen3-VL-4B and GUI-Owl-1.5-4B baselines not run**: the 4B model needs about 3.3 GB of model memory on a machine that already runs out of RAM; GUI-Owl has no Ollama build (it needs vLLM on the lab GPU). Both are defined, disabled, in `eval/conditions.yaml`.
- **Redaction did not cost task success in this run, but the difference is not significant.** Redacted 44.8% vs clean 38.5% (6 points, about 6 of 96 runs, same 32 tasks, 3 runs each, one model). The two conditions pass different tasks (redacted wins DemoBank update-phone, Hospital login, ShopMart login, MailBox login; clean wins DemoBank login, Hospital cardiology, HR sick leave), which at 3 runs per task looks like model variance, not a redaction effect. Safe reading: with a 2B model, task success is about the same with and without redaction (roughly 40%), while the clean screens leaked PII in 66 of 96 runs and the redacted ones in 0 of 96. The clean runs also had a long tail (model p95 41 s vs 5.9 s), probably from the longer, denser prompts; not investigated.
- The failure modes above (skipped username, redacted fields treated as missing information) appear in the redacted runs; the clean runs fail mainly on the same tasks (DemoBank payee and transfer, mail replies and composes, checkouts, VideoMeet logins), so most failures come from the 2B model, not from redaction.

Process notes: a first clean-condition run was invalid (my own leak guard blocked 59 of 96 runs before step 1, so the "unprotected" baseline was protected); it is kept as `eval/results/archive/qwen3vl-2b-clean.guard-active.jsonl` and was redone with the guard, task sanitising and typed-PII check switched off for that condition only. One ShopMart run showed a 58-minute gap that the model could not explain (the laptop slept); it was excluded by the re-run rule and the keep-awake fix.

## Phase 7 — VLM LoRA fine-tuning (trained on Kaggle; offline step accuracy measured, live task success NOT measured)

Built (`training/`, see `training/README.md`):
- **Python port of the redaction** (`redact_py.py`): DOM rules, structured-PII regex with validators (Verhoeff, Luhn), address detector, placeholder map. 17 tests with the extension's inputs, plus all 100 synthetic persona addresses, keep it equal to the TypeScript rules.
- **Expert trajectories through the real extension**: `oracle_vlm.py` is a scripted expert behind the same chat API as the VLM; the agent server's audit log of an oracle run IS the training data (the exact observation, the redacted screenshot, the gold action), so the data has the true on-device redaction with no re-implementation. `gen_tasks.py` writes 160 varied tasks (personas 10-49, rephrased wording, random dates/amounts/accounts/subjects, layout variants); `generate_data.py` runs them on the redacted build and on the evaluation-only clean build. Result: **160/160 expert runs correct in both builds**, none blocked by the leak guard.
- **Mind2Web builder** (`mind2web_builder.py`, OpenRAIL): crop the full-page screenshot to 1280x720 around the target, up to 40 interactive candidates as numbered elements with Set-of-Marks, browser-equivalent redaction, typed secrets turned into `{PASSWORD}` / `{SECRET:x}`, other typed PII into `[TYPE_n]` placeholders; clean twin with `--condition clean`; optional `--ner`. Validated on a real shard (one of 47; 60 steps built per condition).
- **Dataset builder** (`build_dataset.py`): chat samples that use the server's own system prompt and `user_text()` (training and deployment cannot drift), split by website, and a scan that refuses to write the redacted dataset if any real value of the 50 personas is in it (0 found).
- **Trainer** (`train_lora.py`): TRL `SFTTrainer`, LoRA rank 16 / alpha 32 / dropout 0.05 on the language model's q,k,v,o,gate,up,down projections, vision encoder frozen, bf16, lr 1e-4 cosine, 3 epochs, effective batch 16, gradient checkpointing, QLoRA automatically under 24 GB; plus `merge_adapter.py`, vLLM serving commands, and `eval_offline.py` (valid-JSON, action-type, element and exact-match accuracy on the held-out websites).
- **Live conditions** in `eval/conditions.yaml` (disabled until a GPU server exists): Qwen3-VL-4B base on clean screens, base on redacted screens, and base + LoRA on redacted screens; conditions now carry their own `base_url`.

Datasets built here (`training/data/final_redacted`, `final_clean`; git-ignored): **696 samples each** (499 train, 197 test): 636 synthetic + 60 Mind2Web; actions: 273 type, 247 click, 160 done, 16 select. Held-out (unseen) websites: ShopMart, MailBox, VideoMeet, plus the Mind2Web test websites by hash (ESPN, SoundCloud). Redacted dataset PII scan: 0 persona values.

Validation without a GPU: `python train_lora.py --data data/final_redacted --dry-run` runs the real Qwen3-VL processor: sequences of 1,546-1,715 tokens (mean 1,612), and the supervised span is exactly the action JSON plus the end token (1.5% of tokens), so the label masking is correct. Tests: 25 in `training/tests`, all pass; extension 69, server 12, generator 3 still pass.

NOT done, stated plainly:
- **No model was trained and no LoRA result exists.** The Phase 7 acceptance (LoRA task success on redacted screens reported against both baselines) needs a GPU with enough memory; this laptop's 4 GB RTX 3050 cannot train Qwen3-VL-4B or 8B even with QLoRA at ~1,600 tokens per sample. Run the commands in `training/README.md` on the lab GPU.
- **The dataset is small** (696 samples, of which only 60 are real-site Mind2Web steps): enough to validate the pipeline and for a first small run, not enough to expect a strong model. A real run should build many Mind2Web shards (13.6 GB in total) with `--ner`, and 1-2 orders of magnitude more synthetic trajectories (the generator and the oracle make that a matter of running time).
- **The Mind2Web redaction is coarser than the browser's**: no per-character boxes, so an element holding PII is painted whole; names need `--ner` (the validation build ran without it, so names on those 60 real-site samples are not redacted); no face blurring (the flag is a stub).
- **Mind2Web history** is text only (`{"type":"step","target":...}`), because the element ids of earlier steps are unknown; synthetic samples carry real history actions. The train/deploy mismatch is small but real.
- **Oracle data is expert and clean-path only**: it never shows recovery from a wrong action, the failure mode the 2B baseline mostly has (skipped username, stopping with `ask_user` on a redacted field). The oracle does type placeholders into redacted fields, which is the behaviour the baseline lacked.
- Cosmetic: input fields whose value was replaced by a placeholder print as `REDACTED(None)` in the prompt (the extension sets no category for them). It is the same at training and deployment time, so it was left alone; a prompt change would need a version bump and new baselines.

### Phase 7 result: LoRA trained on Kaggle (Qwen3-VL-2B-Instruct)

Run: Kaggle T4, QLoRA 4-bit, fp16, 499 train samples, 3 epochs (96 optimizer steps), rank 16. Files: `training/results/res_*.json`, adapter in `training/results/adapter-privasight-2b/` (70 MB).
Metric: offline **step accuracy** on the 197 held-out samples (ShopMart, MailBox and VideoMeet were never in training, plus 9 Mind2Web samples from unseen sites): the model sees one screen and must produce the same action as the expert.

| Condition | valid JSON | action type | element | **exact match** |
|---|---|---|---|---|
| Base model, clean screens | 1.00 | 0.553 | 0.477 | **0.355** |
| Base model, redacted screens | 1.00 | 0.482 | 0.391 | **0.320** |
| Base + LoRA, redacted screens | 1.00 | 0.909 | 0.878 | **0.827** |

By held-out site (exact, LoRA on redacted): MailBox 0.908, VideoMeet 0.909, ShopMart 0.721. Training loss fell from 1.00 to 0.007; token accuracy on the test split stayed at 0.977 from epoch 1 to 3.

What this does and does not show:
- Redaction hurts the base model a little (exact 0.355 -> 0.320, within noise at n=197), and LoRA on redacted screens is far above both (0.827). It meets and exceeds the "LoRA on redacted >= base on clean" target of the plan.
- **Most of the gain is probably not about redaction.** The base 2B model is poor at this prompt's conventions (which element number, when to say done, when to type a placeholder), and the expert data teaches them. A fair test of "redaction-aware" needs a fourth condition we did not run: LoRA trained on the **clean** twin dataset (`data/final_clean`), evaluated on clean screens. If that scores about the same as 0.827, the adapter learned the task, not redaction handling.
- Test eval loss rose slightly after epoch 1 (0.101 -> 0.119) while accuracy stayed flat: a small sign of overfitting on 499 samples. One epoch may be enough; not tested.
- The held-out sites share the generator, the oracle's style and the prompt with the training sites, so 0.83 is an optimistic estimate for real websites. Mind2Web (real sites) is n=9: LoRA 0.556 vs base 0.111 on exact, too few to conclude anything.
- Step accuracy is not task success. A model that is right on 83% of single steps can still fail a 6-step task; the live harness (`run_eval.py` with the adapter behind vLLM) was not run, because it needs a GPU server.
- One run, one seed, no confidence intervals.

Kaggle needed fixes that are now merged into the repo scripts: `datasets.Dataset` wrapper for TRL (rows as JSON strings), `get_device_capability()[0] >= 8` instead of `is_bf16_supported()` (it returns True on T4 through emulation), `dtype=` instead of `torch_dtype=`, fp32 trainable weights under fp16 AMP (TRL casts QLoRA adapters to bf16), and `--max-steps/--limit` smoke-test flags.

### Phase 7 control: LoRA trained on CLEAN screens (Kaggle, same settings)

Files: `training/results/res_lora_clean.json`, `res_loraclean_on_redacted.json`. Same 197 held-out steps, exact match:

| Model | Evaluated on clean | Evaluated on redacted |
|---|---|---|
| Base 2B | 0.355 | 0.320 |
| LoRA trained on clean | **0.878** | 0.833 |
| LoRA trained on redacted | not run | **0.827** |

Reading (n=197, one seed; the standard error of each cell is about 2.5 points):
- **The big gain is task learning, not redaction handling.** Base 0.32-0.36 -> 0.83-0.88 happens with either training set.
- **Training on redacted screens did not help measurably.** On redacted test screens the clean-trained adapter scores 0.833 and the redacted-trained one 0.827, a difference of under one point, well inside noise. So the plan's claim that redaction-aware training closes a gap is not supported by this experiment.
- **Redaction costs about 5 points for a trained model** (0.878 on clean vs 0.83 on redacted), borderline given the noise. The VLM cannot be given the hidden values, so some of this is unavoidable; the placeholders let it act without them.
- Likely reasons the redacted training did not add much: only 499 samples, 152 with placeholders; the redacted screens differ from clean ones mostly by black boxes over fields the oracle fills with a fixed placeholder, which a clean-trained model also handles; and the held-out test shares the generator with training. Real sites (Mind2Web, n=9) are identical in both (0.556).
- Not tested: a larger or more varied dataset, more Mind2Web, the 4B model, live task success. This is a negative-to-neutral result for the redaction-aware part and should be reported that way.

## Phase 8 — Indian-name NER fine-tune (done; improvement on synthetic tests, no change in the browser test)

Built (`training/ner/`): `gen_ner_data.py` (24,000 UI-style text snippets with BIO tags: names in many styles, cities and states, organisations, UI vocabulary as negatives), `train_ner.py` (fine-tunes `dslim/bert-base-NER`, same label set, so it is a drop-in; evaluates any checkpoint), `export_onnx.py` (int8 ONNX in the Transformers.js layout, with a check against PyTorch). The extension now loads `PrivaSight/bert-ner-in` (`extension/public/models/`, generated by `export_onnx.py`, git-ignored like the other models); `Xenova/bert-base-NER` is still what `npm run assets` downloads.

No overlap between training and test: Faker en_IN first names, surnames and cities are split 70/30 by hash; templates are split too; `test_hard` is a hand-written list of 50 names in regional, religious and initial styles that Faker cannot produce.

Python evaluation (person names; trained 3 epochs on the CPU, one seed):

| Set | Name-word recall, shipped model | Fine-tuned | False person tags, shipped | Fine-tuned |
|---|---|---|---|---|
| Held-out Faker names, held-out templates (n=1500) | 86.8% | **99.9%** | 4.5% of rows | 2.8% |
| Hand-written hard list (n=1200) | 98.0% | **100%** | n/a | n/a |
| Rows with no names (n=1200) | n/a | n/a | 3.1% | 1.5% |

The int8 browser model matches PyTorch (held-out recall 99.85%, hard 100%, false tags 2.7%); 108 MB, same as before.

Browser test (Phase 5 harness, 225 captures, WASM): text-PII recall **99.7%** (927/930; was 99.1%), names **98.9%** (unchanged), zero values in outgoing JSON, redaction precision **94.0%** (was 94.5%), 69 extension tests and 25 training tests pass.

What this does and does not show:
- On real page layouts the gain is **nil for names** (98.9% before and after). The Phase 5 heuristics (word widening, short-Title-case promotion, UI stoplist) already recovered the persona names, and the 3 remaining "misses" are the wrapped-name measurement artefact. The overall 99.1 -> 99.7 comes from other text, not names; not investigated further.
- The model's real improvement is on names the heuristics do not rescue (the 87% -> 99.9% test). That test is synthetic and templated, with Faker-style names, so 99.9% is an upper bound for real pages. The hand-written list contains many well-known or common names, so the shipped model's 98% there is also optimistic.
- Not measured: names in running prose (mail bodies, free text), non-Latin scripts and transliteration variants, and whether the Phase 5 heuristics can now be removed (they were left in).
- The false-positive on form labels such as "From (DD/MM/YYYY)" is still painted (visible in the precision-loss list), so the fine-tune did not fix over-redaction of UI labels.
- Training is reproducible with `python gen_ner_data.py && python train_ner.py --out runs/ner-in --batch 16` (about 70 minutes on this laptop's CPU; the installed PyTorch has no CUDA).

## Phase 9 — Hardening (done; Firefox port NOT done)

Built (`extension/src/`):
- **Settings** (side panel > Settings, stored in `chrome.storage.local`, validated in `shared/settings.ts`): server URL, step limit (1-30), step timeout (5-600 s), and extra allowed origins (exact origins only; wildcards, non-http(s) schemes and junk are rejected, nothing is saved on error). `http://localhost:8080` is always allowed; the agent still refuses every other origin in code. Origins added in Settings get a self-contained content script (`content-standalone.js`, built by `vite.content.config.ts`, not web-accessible) registered for exactly those origins and removed when they are removed.
- **Resume after the service worker dies**: the loop state (task, tab, next step, history, session id) is saved to `chrome.storage.session` after every step; a Chrome alarm (every 30 s, only while a task runs) wakes a killed worker and `resumeInterrupted()` continues. An action that was sent to the page but whose result was not recorded is added to the history as "interrupted: ... look at the screen", so the model checks instead of repeating it. State older than 10 minutes is discarded. Saved actions keep placeholders, never real values.
- **ask_user is a conversation**: the task pauses (the placeholder map is kept), the panel shows a reply box, and the answer is sanitised exactly like the task text (vault secrets, regex PII, learned entities become placeholders) before it enters the history. Waiting state expires after 30 minutes. Reopening the panel shows the pending question or the running task.
- **Stuck-loop detection**: the same action 3 times in a row (not scroll or wait) pauses with an `ask_user` instead of using up the step limit.
- **Plain error messages**: server unreachable ("Cannot reach the agent server at ... Is it running?"), model timeout (no pointless retry), HTTP errors with the response text, closed tab, page outside the allowlist.
- **Transient capture failures**: `captureVisibleTab` is now retried on "image readback failed" (a tab that has not painted a frame yet), as well as on the rate limit. Found by the suite: the Phase 4 recall check failed on its first capture after a page load; a 1.5 s wait fixed it, which showed it was a real race in the product.

Acceptance: **the full suite ran clean twice in a row** (`cd eval && python run_all.py --passes 2`, 13 steps per pass, about 10 minutes per pass, no GPU or real model needed). Per pass: typecheck; 82 extension tests; build; no clean-mode code in the shipped build; 12 server and 25 training tests; Phase 1 capture; Phase 2 privacy view; Phase 3 login with a vault secret; Phase 4 structured-PII recall (35/35, 100%, 0 leaks); Phase 4 placeholder round trip; Phase 5 (text-PII recall 99.7%, precision 94.0%, faces 100%, 0 values leaked); Phase 9 browser checks (22 checks: settings validation, server down, origin guard and adding an origin, blocked navigation, ask_user round trip with a PII answer that never leaves the device, stuck loop, configured step limit, worker killed mid-task and resumed by the alarm after about 27 s, resume with an in-flight action).

Test fixes made while getting there (the checks were wrong, not the product):
- The Phase 3 and Phase 4 round-trip checks scanned **every** server log session. Since Phase 6 those include the deliberately unprotected clean-screens baseline and the oracle training runs, which hold real values on purpose, so the round trip reported a false leak. They now scan only the sessions created by their own run (and fail if none were created).
- Phase 3 and the round trip send their requests to a suite-owned agent server (port 8001, scripted model), so an Ollama-backed server on 8000 is left alone.

What is not covered, stated plainly:
- **Firefox: not attempted.** No Firefox on this machine and Playwright cannot load extensions into it. `docs/FIREFOX.md` lists what a port needs (event page instead of service worker, no side panel or offscreen API, ML moved into the background page) and marks everything unverified.
- The suite's agent checks use a **scripted model**. After the loop refactor I ran the real model once (Phase 3 login, Qwen3-VL-2B): the loop worked (4 steps, placeholders, no password in the run's logs) and the model failed the login in its known way (never types the username; 0/3 in the Phase 6 baseline), so this says the loop still runs, not that task success is unchanged. The Phase 6 baselines were **not re-run** after the refactor.
- Resume is tested with a killed worker and a hand-written in-flight state, not by waiting for Chrome to kill the worker on its own timer (the keep-alive normally prevents that).
- Settings are not synced across devices and the vault password still lives only in session memory.
- The 82 extension tests cover the pure logic (settings, origin matching, stuck detection, freshness); the loop itself is covered only by the browser checks.

## Phase 10 — Report and demo (done)

Built:
- `docs/ARCHITECTURE.md` (components, one agent step, the redaction layers, protocol, hardening, harness, training, where data lives), `docs/RESULTS.md` (final report with the definition-of-done status; its tables are generated), `docs/DEMO.md` (how to record, a 5-minute presenter script, likely viva questions).
- **Final metrics**: `eval/final_report.py` rebuilds every table and chart from saved results (Phases 5-8 + ablation) into `docs/RESULTS.md` and `eval/reports/final/` (summary, `ablation.png`, `step_accuracy.png`). The Phase 8 NER evaluations were copied from the git-ignored `training/ner/runs/` to `training/results/ner_eval_*.json`.
- **Layer ablation** (plan Section 10, experiment 1) in `phase5_eval.mjs`: recall and precision per cumulative layer set, on the same 225 captures (`eval/reports/phase10_ablation_wasm.json`):

| Layers | Structured | Names | Addresses | Faces | All text PII | Precision |
|---|---|---|---|---|---|---|
| DOM rules only | 10.3% | 0% | 0% | 0% | 6.5% | 100% |
| + regex | 92.3% | 0% | 100% | 0% | 64.5% | 99.9% |
| + NER | 92.3% | 93.7% | 100% | 0% | 93.2% | 98.1% |
| + faces, video, OCR (full) | 100% | 98.9% | 100% | 100% | 99.7% | 95.2% |

  The full-pipeline numbers reproduce the Phase 8 laptop run (927/930 text PII, 0 leaks).
- **Demo video**: `eval/record_demo.mjs` records the page and the side panel, puts them side by side with captions and ends with an audit of the server log. Recorded: `eval/reports/demo/privasight_demo.mp4` (84 s; HR profile capture, DemoBank login + phone change with `{PASSWORD}` and `[PHONE_1]`, VideoMeet faces; 9 requests, **0 personal values in the server log**).
- **Fresh-clone fixes**: NER fallback (a fresh clone failed every capture without the fine-tuned model; reproduced, fixed); root `requirements.txt`; Ollama Modelfiles in `eval/ollama/`; `.gitignore` for the 1 GB result zips, NER runs and the adapter; GitHub Actions CI; README rewritten as a step-by-step setup.
- **Live LoRA evaluation path**: `training/serve_hf.py` (base + adapter behind one OpenAI-compatible endpoint), a Kaggle serving notebook with a tunnel, three conditions (`qwen3vl-2b-hf-clean`, `-hf-redacted`, `qwen3vl-2b-lora-redacted`), `${VAR}` support in `base_url`.

Checks run for Phase 10 (Linux container with the built `extension/dist`; no Windows machine and no GPU): Phase 1 capture check passes; `phase5_eval` with the ablation (225 captures, 0 leaks); the NER fallback with the fine-tuned model removed (before: capture fails; after: names still detected); server tests 12 pass; demo recording with 0 leaks.

Not verified, stated plainly:
- The TypeScript changes (NER fallback, model name in the panel) typecheck with TypeScript 6 and the project's real `@types/chrome` (no new errors versus the Phase 9 source), and the fallback logic was tested on a patched copy of the built worker, but they were **not built with the project's own TypeScript 7 / Vite toolchain** (its node_modules are Windows-only). Run `cd extension && npm run build && cd ../eval && python run_all.py --passes 1` once to confirm.
- "A fresh clone can be set up by following the README": every command was checked against the scripts, but the full sequence from an empty machine (npm ci, asset download, Ollama) was not executed, because no machine with network access and a browser was available to me. It is the next thing to do before submission.
- `serve_hf.py` and the serving notebook have not run on a GPU; the live LoRA task success (definition of done, item 5) is therefore still open.
- Training tests were not re-run here (`regex` package unavailable in the container); the training code was not changed except `oracle_vlm.py` (an optional delay) and `make_kaggle_bundle.py`.

### Phase 10 result: live task success with the LoRA adapter (Kaggle T4 + laptop)

Setup: `training/serve_hf.py` on a Kaggle T4 (Qwen3-VL-2B-Instruct, 4-bit, greedy decoding) behind a Cloudflare quick tunnel; the laptop ran
`run_eval.py` with the real extension. One loaded model serves `base` (adapter off) and `privasight-2b` (adapter on), so the three
conditions differ only in the adapter and the screens. Both extension builds were rebuilt first (`--build`): `dist-clean` was still from
before Phase 9, which would have left the clean baseline without the stuck-loop stop and the capture retry.

| Condition | Task success (32 tasks x 3) | Training sites | Unseen sites | Steps/task | Runs with a leak |
|---|---|---|---|---|---|
| Base, clean screens (unsafe) | 62.5% | 58.8% | 66.7% | 7.1 | 78 of 96 |
| Base, redacted (PrivaSight) | 46.9% | 35.3% | 60.0% | 6.9 | 0 of 96 |
| **Base + LoRA, redacted (PrivaSight)** | **90.6%** | **100%** | **80.0%** | 4.1 | **0 of 96** |

Reading:
- With these weights and decoding, redaction costs the base model 15.6 points (5 tasks). Its failures on redacted screens end mostly in
  `ask_user` (45 runs): it stops at fields that were hidden on purpose instead of typing the placeholder or vault secret.
- The adapter completes every task on the sites it was trained on and 12 of 15 tasks on the unseen sites, 20 points above the base model
  on those sites. It fails `shopmart-add-headphones`, `shopmart-checkout-address` and `videomeet-login-then-leave` (all three runs each).
- Greedy decoding makes the three runs of a task almost identical (std 0), so the effective sample is 32 tasks; one task is about 3 points.
- The Ollama baseline (Phase 6) showed no clear redaction cost (44.8% vs 38.5%). Ollama uses a different quantisation and its own
  sampling, so results are compared only within one serving setup.
- Not shown: whether the gain comes from redaction-awareness. The clean-trained adapter (the Phase 7 control) was not run live; offline it
  did as well on redacted screens as the redacted-trained one.

This closes the last definition-of-done item. `docs/RESULTS.md` and `eval/reports/final/` were regenerated with `final_report.py`.
