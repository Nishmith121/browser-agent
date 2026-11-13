"""VideoMeet: static meeting page with participant faces, chat and a Leave button."""
from html import escape

from sitekit import PERSONAS, gt, login_page, page, photo_url, post_js

NAME, TITLE, BRAND, FIRST = "videomeet", "VideoMeet", "#2b2f3a", "meeting"
NAV = [("meeting", "Meeting")]


def login(v="", q=None):
    return login_page(NAME, TITLE, BRAND, FIRST, v), []


def meeting(p, v="", q=None):
    others = [PERSONAS[(p["id"] + k) % len(PERSONAS)] for k in (1, 2, 3)]
    people = [p] + others
    tiles = "".join(
        f'<div class="card" style="text-align:center"><img class="photo" style="width:100%;height:auto;aspect-ratio:1" id="face-{i}" alt="Participant video" src="{photo_url(x)}">'
        f'<div id="tile-name-{i}">{escape(x["full_name"])}</div></div>' for i, x in enumerate(people))
    chat_phone = others[0]["phone"]
    body = f"""<h1>Weekly sync</h1>
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">{tiles}</div>
<h3>Chat</h3><div class="card"><span id="chat-name">{escape(others[0]['full_name'])}</span>:
call me on <span id="chat-phone">{chat_phone}</span> after the meeting, or mail <span id="chat-email">{others[0]['email']}</span></div>
<button id="leave-btn" onclick="leave()">Leave meeting</button><p id="msg"></p>"""
    script = post_js(NAME, p["id"]) + """
async function leave(){const j=await post('leave',{});msg.textContent=j.ok?'You left the meeting':'Error'}"""
    items = [(f"#tile-name-{i}", "NAME", x["full_name"]) for i, x in enumerate(people)]
    items += [("#chat-phone", "PHONE", chat_phone), ("#chat-email", "EMAIL", others[0]["email"]),
              ("#chat-name", "NAME", others[0]["full_name"])]
    items += [(f"#face-{i}", "FACE", "") for i in range(len(people))]
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(*items)


PAGES = {"meeting": meeting}
