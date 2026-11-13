# Decisions

- **Test-site server**: Python `http.server` (`testsites/serve.py`) instead of Node/Express. It renders pages per persona (`?p=<id>`) and serves ground truth at `/groundtruth/<site>/<page>`.
- **Persona photos**: not yet generated. When added, use generated or synthetic faces only and record the licence here.
- **Card numbers**: test-only BIN 411111, Luhn-valid.
- **Extension toolchain**: Vite 6 + `@crxjs/vite-plugin` 2.x, plain TS side panel (no React).
- **Extension content script scope**: matches `http://localhost:8080/*` only (hard constraint: act only on allowed origins).
- **Permissions**: `<all_urls>` host permission is needed for `captureVisibleTab` from the side panel (`activeTab` alone failed). The allowlist is enforced in code (`src/shared/origins.ts`); content script still matches only localhost:8080.
- **Painter location**: Phase 2 paints in the service worker with OffscreenCanvas (works in MV3); revisit with the offscreen document when ML arrives (Phase 5).
- **Vault scan floor**: secrets shorter than 4 characters are not scanned for (would block every payload); the vault still substitutes them.
- **Input values**: input values are never put in the snapshot or payload until regex redaction exists (Phase 4).
- **Server/model**: OpenAI-compatible client so the same code talks to Ollama (laptop, `qwen3-vl:4b`, 4 GB RTX 3050 so expect partial CPU offload) and vLLM (lab GPU). `eval/fake_vlm.py` is a scripted stand-in used only to test plumbing.
- **Step timeout**: 180 s in the extension for laptop Ollama (the plan's 30 s default applies to the lab GPU).
- **Server logs**: the screenshot is saved as a PNG per step beside `requests.jsonl` (it is the already-redacted image), the JSON has the image field removed.
- **Model variant**: the default `qwen3-vl:2b` Ollama tag is a *thinking* model; it exhausts max_tokens on reasoning and returns empty content (Ollama ignores think:false/reasoning_effort for it). Use the Instruct tag (`qwen3-vl:2b-instruct`, 8k context variant `qwen3-vl-2b-instruct-8k`), which matches the plan (Qwen3-VL-Instruct). The server now raises an explicit error on empty content.
- **Ground-truth geometry (eval)**: PII location = glyph extent (Range) for text, field box for inputs.
- **Input values**: now read locally only to look for structured PII; only placeholders (`[PHONE_1]`) leave the content script path. Non-PII input values (e.g. names, addresses) are still omitted until NER (Phase 5).
- **captureVisibleTab quota**: Chrome allows ~2 calls/s; the observer backs off on that error.
- **Site server**: `testsites/serve.py` is now generic (site registry); persona photos are placeholder cartoon avatars, to be replaced by a licensed synthetic-face set in Phase 5 (record licence here).

## Phase 5 decisions

- **Face photos (licence)**: 20 images from SFHQ (Synthetic Faces High Quality, CC0), taken from the `pravsels/SFHQ_256` mirror (shard 10; the mirror's card has no licence field, upstream SFHQ is CC0). Synthetic people only. Files: `testsites/static/photos/face00..19.jpg`.
- **Face detector**: MediaPipe BlazeFace short-range (Apache-2.0), `float16/1` from the MediaPipe model bucket, downloaded by `npm run assets` and shipped inside the extension.
- **NER model (substitution of the plan's Ai4Privacy anonymiser)**: no ready ONNX export of the Ai4Privacy DistilBERT exists for Transformers.js, so `Xenova/bert-base-NER` (MIT, CoNLL-2003 PER/ORG/LOC/MISC) was used until Phase 8. It is English-trained and weak on Indian names (heuristics listed in PROGRESS.md). Phase 8 fine-tuned it on synthetic Indian-name text (`PrivaSight/bert-ner-in`, int8 WASM only: no fp16/WebGPU export was made); the browser name recall did not change.
- **OCR**: Tesseract.js 7 with `tessdata_fast` English (Apache-2.0), local files, `workerBlobURL: false` (blob workers are blocked by the extension CSP).
- **Default backends**: NER on WASM/int8, faces on the GPU delegate. WebGPU/fp16 is available via `chrome.storage.session` key `mlConfig` ({nerDevice:"webgpu"}); see measurements in PROGRESS.md.
- **Organisations are not redacted** (site names and UI words would be blacked out); an ORG entity is treated as a person only if it looks like one.
- **Cross-origin isolation** (COOP/COEP) is set in the manifest so the WASM runtime can use threads.
- **Assets are not committed**: `extension/public/{ort,mediapipe,models,tesseract}` are produced by `npm run assets` (about 440 MB, git-ignored).

## Phase 6 decisions

- **Runner language**: the plan names `eval/run_eval.py` with Playwright; Playwright for Node is already installed and drives the extension, so the runner is `run_tasks.mjs` (Node) and `run_eval.py` is the one-command orchestrator around it, with pandas/matplotlib in `report.py`.
- **Test hook**: the side panel itself (task box, secret fields, start button) drives each run, so the real code path is measured; no special test endpoint exists in the extension.
- **Success definition**: the site state after the run matches the expectation AND the step count is within the task max_steps (the extension stops at 15). A run that claims "done" with the wrong state is a failure.
- **Leakage measure**: a run leaks if any sensitive value of any of the 50 personas, or a vault secret, appears in a request the agent server logged (exact, or with spaces/dashes removed). Names and addresses are included, not only structured PII.
- **Unsafe baseline kept out of the product**: `dist-clean` is built only with `VITE_EVAL_CLEAN=1` (mode `evalclean`); the shipped build is checked to contain none of it. The matching server switch (`ALLOW_TYPED_PII=1`) is evaluation-only and defaults off. Defences that would otherwise protect the baseline (leak guard, task sanitising, typed-PII rejection) are disabled for that condition so it measures an unprotected agent.
- **Latency statistics** exclude the first step of each condition's first run (it loads the model into memory).
- **Models**: baselines use Qwen3-VL-2B-Instruct (8k-context Modelfile). The default Ollama tag of the 4B model is a thinking model and needs the `-instruct` tag; neither it nor GUI-Owl-1.5 fits this machine (see PROGRESS.md).
- **Run hygiene**: the orchestrator keeps the machine awake; results are append-only per run so interrupted jobs resume.

## Phase 7 decisions

- **Training data from the real pipeline, not a re-implementation**: recorded expert trajectories come from running the real extension against a scripted oracle and reading the agent server audit log, so redaction (OCR, NER, faces, placeholders) is exactly what the model will see. The Python port (`redact_py.py`) exists only for Mind2Web, where there is no live page.
- **Rejection sampling**: only oracle runs whose final site state matches the task expectation become samples.
- **Split by website** (plan): ShopMart, MailBox, VideoMeet held out; Mind2Web websites by SHA-1 hash (20% test). Evaluation personas (0-9) are not used for training tasks (10-49).
- **The redacted dataset is scanned for real persona values** and the build fails on a hit.
- **Model and recipe**: Qwen3-VL-4B-Instruct first, then 8B; LoRA r16/alpha32/dropout 0.05 on the language model projections only, vision tower frozen, bf16, lr 1e-4, 3 epochs, effective batch 16, QLoRA under 24 GB, TRL SFTTrainer with a custom collator that trains on the assistant answer only.
- **Image budget**: a 1280x720 screenshot is about 900 image tokens; `--max-pixels` caps it if memory is short.
- **Mind2Web license**: OpenRAIL (osunlp/Multimodal-Mind2Web); sample images are cropped screenshots of real websites and are git-ignored. No real personal data from our side enters the data; Mind2Web task text can contain names or numbers, which the builder redacts as the browser would.
- **Unsafe clean twin**: the clean dataset comes from the evaluation-only `dist-clean` build and exists only to compare conditions; never train a deployable model on it.
- **Heavy ML packages stay out of the laptop path**: dataset building and tests need only pillow, pyarrow, regex, pyyaml; torch/transformers (CPU) were installed here only for the dry run.

## Phase 10 decisions

- **NER fallback for fresh clones**: the fine-tuned NER (`PrivaSight/bert-ner-in`) is produced by training and is not downloadable, so a fresh clone that only ran `npm run assets` failed every capture (`ModelFileNotFoundError`, reproduced). The NER worker now tries the fine-tuned model, then `Xenova/bert-base-NER`, and reports which one it loaded (side panel: `[ner wasm (model), ...]`). `npm run assets` can fetch the fine-tuned files from `PRIVASIGHT_NER_URL` if they are ever published.
- **Layer ablation without new builds**: every painted region already carries its `source`, and the detectors are independent with unioned regions, so recall/precision per cumulative layer set (DOM, +regex, +NER, +faces/video/OCR) is computed from one run by filtering regions. No product code switches off a layer. OCR (which runs regex + NER on image text) is counted in the last layer with faces, because it is the image path. Task success per layer would need per-layer builds and was not run.
- **Demo model**: the recorded demo uses the scripted expert (`oracle_vlm.py`, with `ORACLE_DELAY_S=2.5` so steps are readable), stated in the captions. The privacy pipeline is the real one; the 2B model fails the login task the demo shows. The recorder can use any model.
- **Live LoRA evaluation path**: vLLM is not always available on free GPUs, so `training/serve_hf.py` serves the base model and the adapter from one loaded model (Transformers + PEFT, 4-bit as in training) behind the OpenAI API; `make_kaggle_bundle.py` adds a serving notebook with a Cloudflare quick tunnel. `run_eval.py` expands `${VAR}` in `base_url` and starts Ollama only for conditions that use it. Not run yet (no GPU here).
- **Python dependencies**: one root `requirements.txt` for everything that runs without a GPU, with lower bounds (the exact versions used were not recorded); Node dependencies stay pinned by the lockfiles.
- **Ollama Modelfiles** for the 8k-context models are now in `eval/ollama/` (the baselines used them, but they were not in the repository).
- **CI**: GitHub Actions runs the Python and extension unit tests, typecheck, build and the clean-code check. The browser checks stay local (headed Chromium, 440 MB of assets).
- **Phase 10 verification environment**: the demo and the ablation were produced in a Linux container (Chromium under Xvfb, WASM, software GL) with the built `extension/dist`; recall, precision and leakage there match the Windows laptop run exactly (99.7%, 94-95%, 0 leaks), latency differs and is not reported from it.

- **Live LoRA evaluation, as run**: Kaggle T4, `serve_hf.py` (4-bit NF4 as in training, greedy), Cloudflare quick tunnel to the laptop, `run_eval.py --build`. Greedy decoding was kept so base and adapter are compared without sampling noise; the cost is that 3 runs per task add little information. The Phase 6 Ollama baselines used the pre-Phase 9 `dist-clean` build; the Phase 10 runs rebuilt both builds first.
