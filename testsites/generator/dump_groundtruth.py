"""Write ground-truth JSON files: groundtruth/<site>/<page>_p<persona>[_<variant>].json

  python dump_groundtruth.py [variant]     # default variant "" (also: dark, serif, large, shift)
The same data is served live at /groundtruth/<site>/<page>?p=<id>&v=<variant>.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import site_demobank, site_hospital, site_hr, site_mailbox, site_shopmart, site_videomeet  # noqa: E402
from sitekit import PERSONAS  # noqa: E402

SITES = [site_demobank, site_hr, site_hospital, site_shopmart, site_mailbox, site_videomeet]
QUERY = {"search": {"q": ["cable"]}, "read": {"m": ["1"]}, "compose": {"reply": ["sender@example.com"]}}

if __name__ == "__main__":
    variant = sys.argv[1] if len(sys.argv) > 1 else ""
    out = Path(__file__).resolve().parent.parent / "groundtruth"
    n = 0
    for site in SITES:
        d = out / site.NAME
        d.mkdir(parents=True, exist_ok=True)
        for name, fn in site.PAGES.items():
            for p in PERSONAS:
                _, truth = fn(p, variant, QUERY.get(name))
                (d / f"{name}_p{p['id']}{'_' + variant if variant else ''}.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
                n += 1
    print(f"wrote {n} ground-truth files to {out}")
