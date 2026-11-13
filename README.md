# PrivaSight

A privacy-preserving AI browser agent. A Chrome extension perceives the page, **redacts faces, passwords and personal data on
the device**, and sends only the sanitised screenshot and element list to a server-side vision-language model (Qwen3-VL), which
returns UI actions. Secrets travel as placeholders (`{PASSWORD}`, `[PHONE_1]`) and are filled in locally when the extension acts.

- How it works: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Results (recall, leakage, latency, task success, fine-tuning): [`docs/RESULTS.md`](docs/RESULTS.md)
- Demo video and presenter script: [`eval/reports/demo/privasight_demo.mp4`](eval/reports/demo/privasight_demo.mp4), [`docs/DEMO.md`](docs/DEMO.md)
- Build log and design decisions: [`docs/PROGRESS.md`](docs/PROGRESS.md), [`docs/DECISIONS.md`](docs/DECISIONS.md)

All test data is synthetic (Faker `en_IN` personas, CC0 synthetic faces). The agent acts only on `http://localhost:8080`
(the synthetic sites) unless you add an origin in its Settings.

```
privasight/
├── extension/   Chrome MV3 extension (TypeScript, Vite): capture, on-device ML, redaction, vault, side panel
├── server/      FastAPI agent server: redaction-aware prompt, VLM client, action parser, audit log
├── testsites/   six synthetic sites + persona generator + ground truth
├── eval/        acceptance checks, redaction metrics, task harness, reports, demo recorder
├── training/    VLM LoRA (dataset, trainer, evaluator, server) and the Indian-name NER fine-tune
└── docs/
```

## 1. Requirements

| Tool | Version | Used for |
|---|---|---|
| Python | 3.11 or newer | test sites, agent server, evaluation |
| Node.js | 22 or newer (with npm) | extension build, Playwright checks |
| Google Chrome or Chromium | recent | running the extension |
| Ollama | recent | the VLM on a laptop (any 4 GB+ GPU, or CPU, works slowly) |
| ffmpeg (optional) | any | composing the demo video |

The commands below are for a terminal opened in the repository root. On Windows, use `py` in place of `python` if that is how
Python is installed, and `set NAME=value` in place of `NAME=value` before a command.

## 2. Set up (about 15 minutes, mostly downloads)

```
python -m pip install -r requirements.txt

cd extension
npm ci                     # exact versions from package-lock.json
npm run assets             # ONNX Runtime, MediaPipe face model, NER model, Tesseract (about 440 MB, into public/)
npm run build              # -> extension/dist
cd ..

cd eval
npm ci
npx playwright install chromium
cd ..
```

`npm run assets` downloads the original English NER model (`Xenova/bert-base-NER`). The Indian-name fine-tune used for the
final results (`PrivaSight/bert-ner-in`) is produced by `training/ner` (see section 7). The extension uses it automatically
when it is present and falls back to the original model otherwise. If the fine-tuned folder was published, run
`PRIVASIGHT_NER_URL=<base url> npm run assets` to download it.

Install the model for the agent:

```
ollama pull qwen3-vl:2b-instruct
ollama create qwen3-vl-2b-instruct-8k -f eval/ollama/qwen3-vl-2b-instruct-8k.Modelfile
```

## 3. Run it

Three terminals:

```
python testsites/serve.py                                   # http://localhost:8080/demobank/login (also hr, hospital, shopmart, mailbox, videomeet)

cd server
VLM_MODEL=qwen3-vl-2b-instruct-8k python -m uvicorn app.main:app --port 8000
                                                            # VLM_BASE_URL defaults to Ollama (http://localhost:11434/v1)
```

Then in Chrome:

1. Open `chrome://extensions` and turn on Developer mode. Click **Load unpacked** and choose `extension/dist`.
2. Open `http://localhost:8080/demobank/login`. Click the PrivaSight icon to open the side panel.
3. Click **Capture & mark** to see the Privacy view: the redacted screenshot, the regions painted over, and the exact JSON that would leave the device.
4. Run a task. Open `http://localhost:8080/demobank/profile?p=1`, enter `Change my mobile number to 9876543210 and save the changes`
   and click **Start**. The Qwen3-VL-2B baseline completes this task in 3 of 3 runs. For a login task, put the persona's password
   (synthetic, in `testsites/personas.json`) under *Secrets* and ask, for example, `Log in to DemoBank as user00 using the stored password`.
   The 2B model often fails logins (see `docs/RESULTS.md`), but nothing private is sent either way.

Logins are `user00` … `user49`. Add `?p=<id>` to a page to see that persona, and `&v=dark|serif|large|shift` for layout variants.
Settings (side panel) holds the server URL, step limit, step timeout and extra allowed origins.

No GPU and no model? Use the scripted model for plumbing: run `python -m uvicorn fake_vlm:app --port 11435` in `eval/` and start the
server with `VLM_BASE_URL=http://localhost:11435/v1 VLM_MODEL=fake`. It can log in and change a phone number.
`training/oracle_vlm.py` (port 11436, `VLM_MODEL=oracle`) can do every task in `eval/tasks`.

## 4. Tests and checks

```
cd testsites/generator && python -m pytest -q && cd ../..
cd server && python -m pytest -q && cd ..
cd training && python -m pytest tests -q && cd ..
cd extension && npm run typecheck && npm test && cd ..

cd eval
python run_all.py --passes 2      # the full acceptance suite twice: builds, unit tests, Phase 1-5 and 9 browser checks
                                  # (about 10 min per pass, no GPU; starts the test sites, a scripted model and its own server)
```

CI (`.github/workflows/ci.yml`) runs the unit tests, the typecheck, the build and the clean-code check on every push. The browser
checks need a desktop Chromium and the model assets, so they run locally.

## 5. Evaluation

```
cd eval
node phase5_eval.mjs 3 ",dark,serif,large,shift" wasm     # redaction recall/precision/leakage/latency + layer ablation (needs serve.py)
python run_eval.py                                         # live task success: enabled conditions in conditions.yaml, 3 runs each
                                                           # (starts sites, Ollama and the server; hours on a laptop)
python run_eval.py --runs 1 --limit 8                      # quick pass
python run_eval.py --report-only                           # rebuild eval/reports/phase6 from eval/results
python final_report.py                                     # the final tables and charts -> docs/RESULTS.md, eval/reports/final/
```

`run_eval.py` builds both the shipped extension and the **evaluation-only** unsafe baseline `extension/dist-clean`
(`npm run build:clean`). That baseline sends clean screens. Never load it for real use.

## 6. Demo video

See [`docs/DEMO.md`](docs/DEMO.md). In short, with the sites, `training/oracle_vlm.py` (with `ORACLE_DELAY_S=2.5`) and the server
pointed at it running, run `cd eval && node record_demo.mjs`. This writes `eval/reports/demo/privasight_demo.mp4`.

## 7. Fine-tuning (GPU)

- **VLM LoRA**: see [`training/README.md`](training/README.md). `python training/make_kaggle_bundle.py` packs the code, datasets and adapter
  for a free Kaggle GPU. The notebooks train (`privasight_train.ipynb`), run the clean-screen control (`privasight_train_clean.ipynb`),
  and **serve base + adapter for the live task-success run** (`privasight_serve.ipynb`, which uses `training/serve_hf.py` and a tunnel).
  After the notebook prints the URL:
  `LORA_BASE_URL=<url>/v1 python eval/run_eval.py --conditions qwen3vl-2b-hf-clean,qwen3vl-2b-hf-redacted,qwen3vl-2b-lora-redacted`.
- **Indian-name NER** (CPU is enough, about 70 minutes):
  ```
  cd training/ner
  python gen_ner_data.py && python train_ner.py --out runs/ner-in --batch 16
  python export_onnx.py runs/ner-in ../../extension/public/models/PrivaSight/bert-ner-in
  cd ../../extension && npm run build
  ```

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Side panel: "Cannot reach the agent server" | Start `server` (section 3) or fix the URL in Settings |
| The model returns empty answers | Use an `-instruct` Ollama tag. The default `qwen3-vl` tags are thinking models |
| "Origin not allowed" | The agent acts only on `localhost:8080` and the origins you add in Settings |
| First step is slow (2–12 s) | The on-device models load once per browser start |
| Captures fail after a page load | Retried automatically. If a laptop sleeps during a long evaluation, Chrome stalls: `run_eval.py` keeps Windows awake |
| `npm run build` fails on `tsc` | Run `npm ci` in `extension/` (TypeScript comes from the lockfile) |
