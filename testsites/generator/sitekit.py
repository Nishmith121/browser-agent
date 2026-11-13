"""Shared helpers for the synthetic test sites: layout, layout variants, ground-truth and login pages."""
import json
from html import escape
from pathlib import Path

PERSONAS = json.loads((Path(__file__).resolve().parent.parent / "personas.json").read_text(encoding="utf-8"))

BASE_CSS = """
*{box-sizing:border-box}
body{font-family:Arial,sans-serif;margin:0;background:#f3f5f9;color:#1a2233;font-size:15px}
header{background:var(--brand,#12306b);color:#fff;padding:12px 28px;display:flex;justify-content:space-between;align-items:center}
header nav a{color:#fff;opacity:.85;margin-left:18px;text-decoration:none}
main{max-width:860px;margin:20px auto;background:#fff;padding:22px 26px;border-radius:8px}
h1{margin:0 0 12px;font-size:24px}
label{display:block;margin-top:10px;font-weight:bold}
input,select,textarea{width:100%;padding:7px;margin-top:3px;font-size:15px}
button{margin-top:14px;padding:9px 20px;background:var(--brand,#12306b);color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:15px}
.kv{display:flex;gap:12px;margin:6px 0}.kv b{width:170px;flex:none}
.row{display:flex;gap:20px}.row>*{flex:1}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e3e6ee;padding:6px 8px;text-align:left}
img.photo{width:150px;height:150px;border-radius:8px;object-fit:cover;display:block}
.card{border:1px solid #dde1ea;border-radius:6px;padding:10px;margin:8px 0}
"""

# Layout variations (?v=...) to test robustness: fonts, positions, dark theme (Section 8).
VARIANTS = {
    "": "",
    "dark": "body{background:#10151f;color:#e8ecf4}main{background:#1b2333}td,th{border-color:#2f3a52}.card{border-color:#2f3a52}input,select,textarea{background:#0f1522;color:#e8ecf4;border:1px solid #44506a}",
    "serif": "body{font-family:Georgia,'Times New Roman',serif;font-size:17px}",
    "large": "body{font-size:19px}h1{font-size:30px}.kv b{width:230px}",
    "shift": "main{margin:60px 0 0 120px;max-width:700px}.kv{flex-direction:column;gap:2px}",
}


def gt(*items) -> list[dict]:
    """items: (css selector, category, value[, [x, y, w, h] offset inside the element, for text drawn on a canvas])."""
    out = []
    for it in items:
        d = {"selector": it[0], "category": it[1], "value": it[2]}
        if len(it) > 3:
            d["offset"] = it[3]
        out.append(d)
    return out


def fmt_aadhaar(a: str) -> str:
    return f"{a[:4]} {a[4:8]} {a[8:]}"


def photo_url(p: dict) -> str:
    return f"/photos/{Path(p['photo']).name}"


def page(site: str, title: str, brand: str, body: str, persona=None, nav=(), v: str = "", script: str = "") -> str:
    q = ""
    if persona:
        q = f"?p={persona['id']}" + (f"&v={v}" if v else "")
    links = "".join(f'<a href="/{site}/{n}{q}">{escape(lbl)}</a>' for n, lbl in nav)
    links += f'<a href="/{site}/login{"?v=" + v if v else ""}">Log out</a>' if persona else ""
    css = BASE_CSS + VARIANTS.get(v, "")
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>{escape(title)}</title>"
            f"<style>:root{{--brand:{brand}}}{css}</style></head><body>"
            f"<header><strong>{escape(title)}</strong><nav>{links}</nav></header><main>{body}</main>"
            f"<script>{script}</script></body></html>")


def login_page(site: str, title: str, brand: str, first: str, v: str = "") -> str:
    body = f"""<h1>Sign in</h1>
<form id="login-form" onsubmit="return doLogin(event)">
<label for="username">Username</label><input id="username" name="username" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
<button type="submit" id="login-btn">Sign in</button><p id="err" style="color:#b00"></p></form>"""
    script = f"""
async function doLogin(e){{e.preventDefault();
 const r=await fetch('/{site}/api/login',{{method:'POST',headers:{{'Content-Type':'application/json'}},
 body:JSON.stringify({{username:username.value,password:password.value}})}});
 const j=await r.json();
 if(j.ok){{location.href='/{site}/{first}?p='+j.id+'{"&v=" + v if v else ""}'}}else{{err.textContent='Invalid credentials'}}
 return false}}"""
    return page(site, title, brand, body, v=v, script=script)


def post_js(site: str, pid: int) -> str:
    """JS helper: post(action, data) -> parsed JSON; persona id is attached for /check."""
    return f"""
async function post(action,data){{const r=await fetch('/{site}/api/'+action,{{method:'POST',
 headers:{{'Content-Type':'application/json'}},body:JSON.stringify(Object.assign({{id:{pid}}},data))}});return r.json()}}"""
