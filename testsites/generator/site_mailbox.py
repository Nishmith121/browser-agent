"""MailBox: inbox, read mail, compose/reply. Mail bodies carry names, emails and phone numbers."""
from html import escape

from sitekit import PERSONAS, gt, login_page, page, post_js

NAME, TITLE, BRAND, FIRST = "mailbox", "MailBox", "#3a4fb0", "inbox"
NAV = [("inbox", "Inbox"), ("compose", "Compose")]
SUBJECTS = ["Project kickoff", "Invoice for October", "Lunch on Friday", "Travel plan", "Please confirm your details"]


def login(v="", q=None):
    return login_page(NAME, TITLE, BRAND, FIRST, v), []


def mails(p):
    """Five deterministic mails for a persona, sent by other personas."""
    out = []
    for i, subj in enumerate(SUBJECTS):
        s = PERSONAS[(p["id"] + 1 + i) % len(PERSONAS)]
        out.append({
            "n": i, "from_name": s["full_name"], "from_email": s["email"], "phone": s["phone"], "subject": subj,
            "body": f"Hi {p['full_name']}, regarding \"{subj}\". You can reach me on {s['phone']} or reply to {s['email']}.",
        })
    return out


def inbox(p, v="", q=None):
    ms = mails(p)
    rows = "".join(
        f'<tr><td><span id="from-{m["n"]}">{escape(m["from_name"])}</span></td>'
        f'<td><a id="mail-{m["n"]}" href="/mailbox/read?p={p["id"]}&m={m["n"]}{"&v=" + v if v else ""}">{escape(m["subject"])}</a></td>'
        f'<td><span id="snippet-{m["n"]}">{m["from_email"]}</span></td></tr>' for m in ms)
    body = f"""<h1>Inbox</h1><p>Signed in as <span id="me">{p['email']}</span></p>
<table><tr><th>From</th><th>Subject</th><th>Sender address</th></tr>{rows}</table>"""
    items = [("#me", "EMAIL", p["email"])] + [(f"#snippet-{m['n']}", "EMAIL", m["from_email"]) for m in ms]
    items += [(f"#from-{m['n']}", "NAME", m["from_name"]) for m in ms]
    return page(NAME, TITLE, BRAND, body, p, NAV, v), gt(*items)


def read(p, v="", q=None):
    ms = mails(p)
    try:
        m = ms[int((q or {}).get("m", ["0"])[0])]
    except (ValueError, IndexError):
        m = ms[0]
    body = f"""<h1 id="subject">{escape(m['subject'])}</h1>
<div class="kv"><b>From</b><span id="from">{escape(m['from_name'])} &lt;<span id="from-email">{m['from_email']}</span>&gt;</span></div>
<div class="card" id="body">Hi {escape(p['full_name'])}, regarding "{escape(m['subject'])}". You can reach me on <span id="body-phone">{m['phone']}</span> or reply to <span id="body-email">{m['from_email']}</span>.</div>
<button id="reply-btn" onclick="location.href='/mailbox/compose?p={p['id']}&reply={escape(m['from_email'])}&subject=Re: {escape(m['subject'])}{'&v=' + v if v else ''}'">Reply</button>"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v), gt(
        ("#from-email", "EMAIL", m["from_email"]), ("#body-phone", "PHONE", m["phone"]),
        ("#body-email", "EMAIL", m["from_email"]))


def compose(p, v="", q=None):
    q = q or {}
    to = escape(q.get("reply", [""])[0])
    subj = escape(q.get("subject", [""])[0])
    body = f"""<h1>Compose</h1><form onsubmit="return send(event)">
<label for="to">To</label><input id="to" name="to" value="{to}">
<label for="subject">Subject</label><input id="subject" name="subject" value="{subj}">
<label for="message">Message</label><textarea id="message" rows="6"></textarea>
<button id="send-btn" type="submit">Send</button><p id="msg"></p></form>"""
    script = post_js(NAME, p["id"]) + """
async function send(e){e.preventDefault();
 const j=await post('send',{to:to.value,subject:subject.value,message:document.getElementById('message').value});msg.textContent=j.ok?'Message sent':'Error';return false}"""
    items = [("#to", "EMAIL", q["reply"][0])] if q.get("reply") else []
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(*items)


PAGES = {"inbox": inbox, "read": read, "compose": compose}
