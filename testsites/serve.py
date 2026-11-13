"""Serve the synthetic test sites on localhost:8080.

  python serve.py

Pages:            /<site>/<page>?p=<persona id>[&v=<variant>]     variants: dark, serif, large, shift
Ground truth:     /groundtruth/<site>/<page>?p=<id>[&v=...]       PII values + CSS selectors on that page
State for evals:  /<site>/check?p=<id>                            what the persona's actions changed
Reset state:      POST /reset
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "generator"))
import site_demobank, site_hospital, site_hr, site_mailbox, site_shopmart, site_videomeet  # noqa: E402
from sitekit import PERSONAS, VARIANTS  # noqa: E402

SITES = {m.NAME: m for m in (site_demobank, site_hr, site_hospital, site_shopmart, site_mailbox, site_videomeet)}
STATE: dict = {}  # site -> persona id -> action -> last posted body


PHOTOS = HERE / "static" / "photos"  # SFHQ synthetic faces (CC0), see docs/DECISIONS.md


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    @staticmethod
    def _pid(qs) -> int:
        try:
            pid = int(qs.get("p", ["0"])[0])
        except ValueError:
            return 0
        return pid if 0 <= pid < len(PERSONAS) else 0

    @staticmethod
    def _variant(qs) -> str:
        v = qs.get("v", [""])[0]
        return v if v in VARIANTS else ""

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        parts = [x for x in u.path.split("/") if x]
        if not parts:
            return self._send(200, "<h1>Test sites</h1>" + "".join(f'<p><a href="/{n}/login">{n}</a></p>' for n in SITES))
        if len(parts) == 2 and parts[0] == "photos" and parts[1].isascii() and parts[1].endswith(".jpg") and "/" not in parts[1]:
            f = PHOTOS / parts[1]
            if f.is_file():
                data = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            return self._send(404, "not found")
        gt_mode = parts[:1] == ["groundtruth"]
        if gt_mode:
            parts = parts[1:]
        if len(parts) != 2 or parts[0] not in SITES:
            return self._send(404, "not found")
        site, name = SITES[parts[0]], parts[1]
        v = self._variant(qs)
        if name == "login":
            return self._send(200, json.dumps([]) if gt_mode else site.login(v)[0], "application/json" if gt_mode else "text/html; charset=utf-8")
        if name == "check":
            pid = self._pid(qs)
            return self._send(200, json.dumps({"persona": PERSONAS[pid], "state": STATE.get(site.NAME, {}).get(pid, {})}), "application/json")
        if name not in site.PAGES:
            return self._send(404, "not found")
        html, truth = site.PAGES[name](PERSONAS[self._pid(qs)], v, qs)
        if gt_mode:
            return self._send(200, json.dumps(truth, indent=2), "application/json")
        return self._send(200, html)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        parts = [x for x in urlparse(self.path).path.split("/") if x]
        if parts == ["reset"]:
            STATE.clear()
            return self._send(200, json.dumps({"ok": True}), "application/json")
        if len(parts) == 3 and parts[1] == "api" and parts[0] in SITES:
            site, action = parts[0], parts[2]
            if action == "login":
                for p in PERSONAS:
                    if p["username"] == body.get("username") and p["password"] == body.get("password"):
                        STATE.setdefault(site, {}).setdefault(p["id"], {})["login"] = {"ok": True}  # read by /check
                        return self._send(200, json.dumps({"ok": True, "id": p["id"]}), "application/json")
                return self._send(200, json.dumps({"ok": False}), "application/json")
            pid = int(body.get("id", 0))
            STATE.setdefault(site, {}).setdefault(pid, {})[action] = body
            return self._send(200, json.dumps({"ok": True}), "application/json")
        self._send(404, "not found")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print("Test sites on http://localhost:8080/ :", ", ".join(SITES))
    ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
