"""Pack everything a Kaggle (or Colab) run needs into ONE zip, plus a ready notebook.

  python make_kaggle_bundle.py        # -> kaggle/privasight_kaggle.zip and kaggle/privasight_train.ipynb
                                      #    (+ privasight_train_clean.ipynb, privasight_serve.ipynb)

Upload the zip as a Kaggle Dataset (named e.g. "privasight"), create a notebook with a GPU and Internet on, add the dataset,
and open privasight_train.ipynb (File > Import Notebook) or paste its cells.
"""
import json
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "kaggle"
CODE = ["train_lora.py", "eval_hf.py", "eval_offline.py", "serve_hf.py", "requirements.txt"]
SERVER = ["__init__.py", "parser.py", "schemas.py", "prompt.py", "config.py"]  # eval_offline imports the server's parser


def add_tree(z: zipfile.ZipFile, src: Path, arc: str) -> int:
    n = 0
    for f in sorted(src.rglob("*")):
        if f.is_file():
            z.write(f, f"{arc}/{f.relative_to(src).as_posix()}")
            n += 1
    return n


def notebook() -> dict:
    code = lambda s: {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n").splitlines(True)}
    md = lambda s: {"cell_type": "markdown", "metadata": {}, "source": s.strip("\n").splitlines(True)}
    cells = [
        md("# PrivaSight: redaction-aware LoRA on Kaggle\nSettings: **Accelerator = GPU T4 x2 (or P100)**, **Internet = On**, add the `privasight` dataset. Everything below uses ONE GPU."),
        code("!nvidia-smi\n!pip install -q -U \"transformers>=4.57\" peft trl accelerate bitsandbytes"),
        code("import glob, shutil\nzipf = glob.glob('/kaggle/input/**/privasight_kaggle.zip', recursive=True)[0]\nshutil.unpack_archive(zipf, '/kaggle/working/')\n%cd /kaggle/working/privasight/training"),
        md("## 1. Check the data pipeline (no GPU memory used)"),
        code("!python train_lora.py --data data/final_redacted --model Qwen/Qwen3-VL-2B-Instruct --dry-run"),
        md("## 2. Train. Start with the 2B model; use `Qwen/Qwen3-VL-4B-Instruct` once you know the time per step.\nT4/P100 have no bf16, so the script uses fp16 automatically. A Kaggle session lasts at most about 9-12 hours: if you raise `--epochs`, keep an eye on the time."),
        code("!CUDA_VISIBLE_DEVICES=0 python train_lora.py --data data/final_redacted --model Qwen/Qwen3-VL-2B-Instruct --out /kaggle/working/runs/privasight-2b --epochs 3"),
        md("## 3. The three conditions on the held-out websites (offline step accuracy)"),
        code("!CUDA_VISIBLE_DEVICES=0 python eval_hf.py --data data/final_clean --model Qwen/Qwen3-VL-2B-Instruct --out /kaggle/working/res_base_clean.json\n"
             "!CUDA_VISIBLE_DEVICES=0 python eval_hf.py --data data/final_redacted --model Qwen/Qwen3-VL-2B-Instruct --out /kaggle/working/res_base_redacted.json\n"
             "!CUDA_VISIBLE_DEVICES=0 python eval_hf.py --data data/final_redacted --model Qwen/Qwen3-VL-2B-Instruct --adapter /kaggle/working/runs/privasight-2b --out /kaggle/working/res_lora_redacted.json"),
        md("## 4. Download `runs/privasight-2b` (the adapter, tens of MB) and the three `res_*.json` files from the Output tab, and bring them back."),
    ]
    return {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}}, "nbformat": 4, "nbformat_minor": 5}


def notebook_clean() -> dict:
    """Control run: LoRA trained and evaluated on CLEAN screens. Tells whether the gain came from learning the task or from redaction."""
    nb = notebook()
    code = lambda s: {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip(chr(10)).splitlines(True)}
    md = lambda s: {"cell_type": "markdown", "metadata": {}, "source": s.strip(chr(10)).splitlines(True)}
    nb["cells"] = nb["cells"][:3] + [
        md("# Control: LoRA trained on CLEAN screens, evaluated on clean screens\nSame settings as the redacted run. If this scores about the same as the redacted LoRA, the adapter learned the task, not redaction."),
        code("!CUDA_VISIBLE_DEVICES=0 PYTHONUNBUFFERED=1 python train_lora.py --data data/final_clean --model Qwen/Qwen3-VL-2B-Instruct --out /kaggle/working/runs/privasight-2b-clean --epochs 3"),
        code("!CUDA_VISIBLE_DEVICES=0 python eval_hf.py --data data/final_clean --model Qwen/Qwen3-VL-2B-Instruct --adapter /kaggle/working/runs/privasight-2b-clean --out /kaggle/working/res_lora_clean.json\n"
             "!CUDA_VISIBLE_DEVICES=0 python eval_hf.py --data data/final_redacted --model Qwen/Qwen3-VL-2B-Instruct --adapter /kaggle/working/runs/privasight-2b-clean --out /kaggle/working/res_loraclean_on_redacted.json"),
        md("Download `res_lora_clean.json` and `res_loraclean_on_redacted.json` from the Output tab (the adapter is not needed)."),
    ]
    return nb


def notebook_serve() -> dict:
    """Phase 10: serve the base model and the trained adapter LIVE so eval/run_eval.py on the laptop can measure task success."""
    nb = notebook()
    code = lambda s: {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip(chr(10)).splitlines(True)}
    md = lambda s: {"cell_type": "markdown", "metadata": {}, "source": s.strip(chr(10)).splitlines(True)}
    nb["cells"] = [
        md("# PrivaSight: serve base + LoRA for the live task-success run\nSettings: **GPU T4 (or P100)**, **Internet = On**, add the `privasight` dataset (rebuilt with `make_kaggle_bundle.py`, so it contains `serve_hf.py` and the adapter).\n"
           "Only redacted screenshots and placeholder text reach this notebook. The tunnel URL is public while it runs: do not share it, and stop the session when the evaluation ends."),
        code("!nvidia-smi\n!pip install -q -U \"transformers>=4.57\" peft accelerate bitsandbytes fastapi uvicorn"),
        # Kaggle may unzip an uploaded archive itself, so accept either the zip or the unpacked folder.
        code("import glob, os, shutil\n"
             "zips = glob.glob('/kaggle/input/**/privasight_kaggle.zip', recursive=True)\n"
             "if zips:\n"
             "    shutil.unpack_archive(zips[0], '/kaggle/working/')\n"
             "else:\n"
             "    src = os.path.dirname(glob.glob('/kaggle/input/**/privasight/training/serve_hf.py', recursive=True)[0])\n"
             "    shutil.copytree(os.path.dirname(src), '/kaggle/working/privasight', dirs_exist_ok=True)\n"
             "%cd /kaggle/working/privasight/training\n"
             "print(os.listdir('results'))"),
        code("import os, subprocess, time, re\n"
             "adapter = 'results/adapter-privasight-2b'  # packed by make_kaggle_bundle.py; or the path of a fresh training run\n"
             "srv = subprocess.Popen(f'CUDA_VISIBLE_DEVICES=0 python serve_hf.py --model Qwen/Qwen3-VL-2B-Instruct --adapter {adapter} --port 8001 > serve.log 2>&1', shell=True)\n"
             "for _ in range(180):\n"
             "    time.sleep(5)\n"
             "    if os.path.exists('serve.log') and 'Uvicorn running' in open('serve.log').read(): break\n"
             "print(open('serve.log').read()[-600:])"),
        code("!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O cloudflared && chmod +x cloudflared\n"
             "tun = subprocess.Popen('./cloudflared tunnel --url http://localhost:8001 > tunnel.log 2>&1', shell=True)\n"
             "url = None\n"
             "for _ in range(60):\n"
             "    time.sleep(2)\n"
             "    m = os.path.exists('tunnel.log') and re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', open('tunnel.log').read())\n"
             "    if m: url = m.group(0); break\n"
             "print('On the laptop:  set LORA_BASE_URL=' + str(url) + '/v1   (Windows; export on Linux/macOS)')\n"
             "print('Then:           cd eval && python run_eval.py --conditions qwen3vl-2b-hf-clean,qwen3vl-2b-hf-redacted,qwen3vl-2b-lora-redacted')"),
        md("Keep the next cell running while the laptop evaluates (it also keeps the session from going idle). Interrupt it to stop."),
        code("import urllib.request\n"
             "while True:\n"
             "    print(time.strftime('%H:%M:%S'), urllib.request.urlopen('http://localhost:8001/v1/models').read().decode(), open('serve.log').read().count('ms:'), 'requests', flush=True)\n"
             "    time.sleep(60)"),
    ]
    return nb


def main() -> None:
    OUT.mkdir(exist_ok=True)
    z_path = OUT / "privasight_kaggle.zip"
    with zipfile.ZipFile(z_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in CODE:
            z.write(HERE / f, f"privasight/training/{f}")
        for f in SERVER:
            z.write(ROOT / "server" / "app" / f, f"privasight/server/app/{f}")
        n = 0
        adapter = HERE / "results" / "adapter-privasight-2b"  # the trained 2B adapter, for privasight_serve.ipynb
        if adapter.exists():
            n += add_tree(z, adapter, "privasight/training/results/adapter-privasight-2b")
        for cond in ("redacted", "clean"):
            d = HERE / "data" / f"final_{cond}"
            if d.exists():
                n += add_tree(z, d, f"privasight/training/data/final_{cond}")
    (OUT / "privasight_train.ipynb").write_text(json.dumps(notebook(), indent=1), encoding="utf-8")
    (OUT / "privasight_train_clean.ipynb").write_text(json.dumps(notebook_clean(), indent=1), encoding="utf-8")
    (OUT / "privasight_serve.ipynb").write_text(json.dumps(notebook_serve(), indent=1), encoding="utf-8")
    print(f"wrote {z_path} ({z_path.stat().st_size / 1e6:.0f} MB, {n} dataset files) and {OUT / 'privasight_train.ipynb'}")


if __name__ == "__main__":
    main()
