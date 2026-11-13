# Phase 7 — redaction-aware LoRA fine-tuning

Goal (plan, Section 9.1): the VLM should finish tasks as well on **redacted** screens as on clean ones. The model sees black boxes,
placeholders like `[PHONE_1]` and `{PASSWORD}`, and numbered marks, so we train it on exactly that.

```
 synthetic sites ──► oracle (scripted expert) ──► REAL extension ──► server audit log ─┐
                         training/oracle_vlm.py     (redaction on)     request + PNG +   │
                                                                       gold action       ├─► build_dataset.py ─► train.jsonl / test.jsonl
 Multimodal-Mind2Web ─► mind2web_builder.py (Python port of the redaction) ──────────────┘          │
                                                                                                    ▼
                                                        train_lora.py (GPU) ─► adapter ─► vLLM --enable-lora ─► eval/run_eval.py
```

Nothing in training needs the model to see real personal data: the redacted dataset is scanned for the real values of all 50
synthetic personas and `build_dataset.py` refuses to write it if any is found.

## What runs where

| Step | Where | Command |
|---|---|---|
| Unit tests (redaction port, builders, oracle, scorer) | laptop | `python -m pytest tests -q` |
| Generate tasks | laptop | `python gen_tasks.py` |
| Record expert trajectories (real extension, redacted and clean) | laptop | `python generate_data.py` |
| Mind2Web samples | laptop or lab | `python mind2web_builder.py --parquet "data/mind2web/*.parquet" --out data/m2w_redacted --condition redacted --ner` |
| Assemble the dataset | laptop | `python build_dataset.py --condition redacted --m2w data/m2w_redacted` |
| Check the training pipeline without a GPU | laptop | `python train_lora.py --data data/final_redacted --dry-run` |
| **Train** | **GPU machine** | `python train_lora.py --data data/final_redacted --model Qwen/Qwen3-VL-4B-Instruct --out runs/privasight-4b` |
| Serve base + adapter | GPU machine | see below |
| Offline step accuracy, three conditions | anywhere | `python eval_offline.py ...` |
| Task success on the live harness | laptop + GPU server | `python run_eval.py --conditions qwen3vl-4b-vllm-clean,qwen3vl-4b-vllm-redacted,qwen3vl-4b-lora-redacted` |

## Data

* **Synthetic (on-distribution)**: `gen_tasks.py` writes ~160 tasks (personas 10-49, rephrased wording, random dates/amounts/accounts,
  layout variants) in `tasks_gen/`. `generate_data.py` runs them through Chromium with the real extension while a scripted expert answers
  instead of a VLM; only runs whose final site state is correct are kept. Because the observation comes from the real pipeline, the data
  has the true redaction (faces, OCR, NER, placeholders) with no re-implementation. The same tasks run on the `dist-clean` build give the clean-screens twin.
* **Mind2Web (real sites)**: `mind2web_builder.py` crops the full-page screenshot to 1280x720 around the target, lists up to 40 interactive
  candidates as numbered elements, applies the Python port of the browser's redaction (`redact_py.py`: DOM rules, structured-PII regex with
  validators, placeholder map), paints redacted elements black, draws the marks, and turns typed values into placeholders
  (`{PASSWORD}`, `{SECRET:card}`, `[EMAIL_1]`). It has no per-character boxes, so an element holding PII is painted whole. Use `--ner` for the name detector
  (the same weights as the browser model, via `transformers`); without it names stay visible. License: OpenRAIL.
  Download shards from `osunlp/Multimodal-Mind2Web` (13.6 GB in total; one shard is about 220 MB) into `data/mind2web/`.
* **Split by website**: ShopMart, MailBox and VideoMeet are held out (unseen), DemoBank, HR Portal and Hospital train; Mind2Web websites are split by hash (20% test).
* Sample format: chat with the server's own system prompt and `user_text()` (`chat_format.py`), image + task + elements + history -> action JSON.

## Training recipe (as in the plan)

LoRA rank 16, alpha 32, dropout 0.05 on the language model's attention and MLP projections (`q,k,v,o,gate,up,down`), vision encoder frozen,
bf16, learning rate 1e-4 (cosine), 3 epochs, effective batch 16 (per-device 1 x accumulation 16), gradient checkpointing, TRL `SFTTrainer`.
Under 24 GB of GPU memory it switches to QLoRA (4-bit NF4) automatically. Only the assistant answer is trained on (verified by `--dry-run`).
Qwen3-VL-4B first; `--model Qwen/Qwen3-VL-8B-Instruct` if the GPU allows. Pin versions from `requirements.txt` on the GPU machine.
This laptop (RTX 3050, 4 GB) cannot train these models; the pipeline was validated up to the model forward pass.

## Serving and evaluating

```
vllm serve Qwen/Qwen3-VL-4B-Instruct --max-model-len 16384 --limit-mm-per-prompt image=1 \
     --enable-lora --max-lora-rank 16 --lora-modules privasight=runs/privasight-4b --port 8001
```

The agent server then needs `VLM_BASE_URL=http://<gpu-host>:8001/v1 VLM_MODEL=privasight` (or the base model name for the baselines);
`eval/conditions.yaml` already has the three conditions (`qwen3vl-4b-vllm-clean`, `-redacted`, `qwen3vl-4b-lora-redacted`) with their `base_url`.
`merge_adapter.py` makes a merged checkpoint if you prefer not to use `--enable-lora`.

The three conditions of the plan, on the same test steps: **base on clean screens**, **base on redacted screens**, **LoRA on redacted screens**
(`eval_offline.py` for step accuracy on the held-out websites; `run_eval.py` for live task success, leakage and latency).
Report the result honestly whether or not the LoRA model improves.

## Training on Kaggle (free GPU)

`python make_kaggle_bundle.py` writes `kaggle/privasight_kaggle.zip` (code + both datasets, about 100 MB) and `kaggle/privasight_train.ipynb`.

1. Kaggle > Datasets > New dataset: upload the zip, name it `privasight`.
2. New notebook: Accelerator **GPU T4 x2** (or P100), **Internet On** (needs a phone-verified account), Add data: `privasight`. Import `privasight_train.ipynb`.
3. Run the cells: install, unpack, dry run, train (`Qwen/Qwen3-VL-2B-Instruct` first), then `eval_hf.py` for base-clean, base-redacted and LoRA-redacted on the held-out websites.
4. Download `runs/privasight-2b` (the adapter) and the three `res_*.json` files from the notebook Output tab.

Notes: T4 and P100 have no bf16, so `train_lora.py` uses fp16 there (`--precision auto`); it uses one GPU in 4-bit (QLoRA), which fits the 2B and 4B models at about 1,600 tokens per sample.
Free quota is about 30 GPU hours per week and one session lasts at most about 9-12 hours, so start with the 2B model and 1-3 epochs and check the time per step before moving to 4B.
For the LIVE task-success harness, serve the model where you have a GPU. vLLM (`--enable-lora`, above) is fastest. Where vLLM is not available, use `serve_hf.py`:

```
python serve_hf.py --model Qwen/Qwen3-VL-2B-Instruct --adapter results/adapter-privasight-2b --port 8001
```

It loads the model once (4-bit, as in training) and serves two names: `base` (adapter disabled) and `privasight-2b` (adapter on).
The comparison therefore differs only in the adapter. On Kaggle, `privasight_serve.ipynb` (written by `make_kaggle_bundle.py`, which now also packs
`serve_hf.py` and the adapter) starts it behind a Cloudflare quick tunnel and prints the URL. Then, on the laptop:

```
set LORA_BASE_URL=https://<printed>.trycloudflare.com/v1        (export on Linux/macOS)
cd eval && python run_eval.py --conditions qwen3vl-2b-hf-clean,qwen3vl-2b-hf-redacted,qwen3vl-2b-lora-redacted
python final_report.py
```

Only redacted screenshots and placeholder text cross the tunnel. The tunnel URL is still public while it runs, so stop the session afterwards.
Not yet run: no GPU was available when this was written.
