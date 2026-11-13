# Demo: script and recording

The recorded demo is `eval/reports/demo/privasight_demo.mp4`, about 85 seconds long. Its captions are in `privasight_demo.srt`.
The left half shows the real page, which uses synthetic personas. The right half shows PrivaSight's side panel with the
**Privacy view**: the exact screenshot and JSON that left the device at that moment.

## Re-recording it

```
# terminal 1: test sites
python testsites/serve.py
# terminal 2: scripted expert as the model (2.5 s per answer so each step stays readable)
cd training && set ORACLE_DELAY_S=2.5 && python -m uvicorn oracle_vlm:app --port 11436        (Linux/macOS: ORACLE_DELAY_S=2.5 python -m ...)
# terminal 3: agent server pointed at it
cd server && set VLM_BASE_URL=http://localhost:11436/v1 && set VLM_MODEL=oracle && python -m uvicorn app.main:app --port 8000
# terminal 4
cd eval && node record_demo.mjs                     # needs ffmpeg on PATH for the final mp4 (otherwise: page.webm + panel.webm + .srt)
```

To record with the real model instead, start the agent server with `VLM_MODEL=qwen3-vl-2b-instruct-8k` and the default
Ollama URL. The 2B model fails the DemoBank login task (it skips the username, as in the Phase 6 baseline), so use
`--scenes capture,meeting` for that recording. The captions always name the model in use. The scripted expert reads only the
prompt text, never the image. It shows the privacy pipeline step by step, not the model's skill.

The script exits with an error if the audit at the end finds any personal value in the server's request log.

## Presenter script (viva, about 5 minutes)

**1. The problem (30 s).** Browser agents upload raw screenshots to a cloud model. HTTPS protects the screenshots on the way,
but the server is the receiver and sees everything: names, Aadhaar numbers, balances, faces. PrivaSight is built on data
minimisation (DPDP Act 2023). Perception and redaction run on the device, and reasoning runs on the server.

**2. One perception step (60 s). Video 0:00–0:27.** Open the HR Portal profile and press *Capture & mark*.
- Point at the left: a full name, Aadhaar, PAN, phone, email, date of birth, address and a photo.
- Point at the right: the same page with black boxes labelled by category, a blurred face, and numbered boxes for the agent.
- Scroll to *Regions painted over*. Each region names its detector: DOM rules, regex with Verhoeff/Luhn validators,
  the NER model, or the face detector.
- Scroll to the outgoing JSON. Personal values became `[PHONE_1]`, `[NAME_1]` and similar placeholders. This view is generated
  from the same object that is sent, so it is not a mock-up.

**3. A task with a secret (90 s). Video 0:27–1:03.** DemoBank: *"Log in as user04 with the stored password, then change the mobile
number to … and save."*
- The password goes into the vault (`chrome.storage.session`), and the server only sees the name `PASSWORD`.
- The model answers `type "{PASSWORD}"`, and the extension substitutes the real password locally.
- The new number in the task text is sent as `[PHONE_1]` (shown in the JSON at step 5). The model types `[PHONE_1]`, and the page
  receives the real number. The site's `/check` endpoint confirms the number was changed.

**4. Faces (30 s). Video 1:03–1:16.** VideoMeet: four participants. Their faces are blurred, their names are black, and the chat
line with a phone number and an email address is redacted. The agent still finds and clicks *Leave meeting*.

**5. Proof (60 s). Video ending, then `docs/RESULTS.md`.**
- The demo's last caption is an audit of the server's own request log: 0 personal values found.
- In the 96 live runs with redaction, 0 runs leaked. The unsafe baseline leaked in 66 of 96.
- Recall is 99.7% for text PII and 100% for faces, and precision is 94%. Show the ablation chart: each detector layer is needed.
- Local cost is a median of about 40 ms per step with cached text, and about 340 ms on a cache miss.

**6. Fine-tuning and honest limits (45 s).** Untrained, the 2B model completes 62.5% of tasks on clean screens and 46.9% on
redacted ones: it stops at fields hidden on purpose. With the LoRA adapter it completes 90.6% on redacted screens, 80% on sites it
never saw, still with 0 leaks. Offline, an adapter trained on clean screens did as well, so the gain may be task learning rather
than redaction-awareness. The larger models and the Firefox port are still open.

## Likely questions

- *Can the model ask for a value it needs?* It answers `ask_user`. The panel shows a reply box, and the reply is sanitised before it is sent.
- *What if a detector misses something?* The leak guard re-checks the final JSON for vault values, every value replaced so far
  and all regex patterns, and it blocks the send on a hit. The server also rejects typed text that looks like PII.
- *Why not run the VLM locally?* It is listed as future work. The 2B model needs a GPU that most laptops lack, and the design keeps the server
  replaceable (OpenAI-compatible API: Ollama, vLLM or `serve_hf.py`).
- *Does the screenshot still leak layout or context?* Yes. The page type, labels and button texts stay visible on purpose, because the
  model needs them. Only the values are hidden.
