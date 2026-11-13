"""Generate varied tasks for the synthetic sites (same YAML format as eval/tasks/*.yaml).

  python gen_tasks.py [--train-per-template 8] [--test-per-template 4] [--out tasks_gen]

Variation: persona (ids 10-49; the evaluation tasks use 0-9), task wording, random dates/amounts/accounts/subjects,
and layout variants (?v=dark|serif|large|shift). Split by WEBSITE: DemoBank, HR Portal and Hospital are training sites;
ShopMart, MailBox and VideoMeet are held out (unseen) for testing.
Every task carries `expect` rules, so only runs whose final site state is correct become training data.
"""
import argparse
import random
from pathlib import Path

import yaml

TRAIN_SITES = {"demobank", "hr", "hospital"}
LAYOUTS = ["", "", "dark", "serif", "large", "shift"]  # most runs on the default layout
DEPTS = ["Cardiology", "Dermatology", "Neurology", "Orthopaedics", "Paediatrics"]
PRODUCTS = ["Wireless mouse", "Mechanical keyboard", "USB-C cable", "Laptop stand", "Noise cancelling headphones", "Webcam HD", "Desk lamp", "Phone charger"]
SUBJECTS = ["Project kickoff", "Invoice for October", "Lunch on Friday", "Travel plan", "Please confirm your details"]
REPLIES = ["Thanks, received", "Sounds good", "I will check and reply tomorrow", "Please send the details"]
LEAVE_TYPES = ["Casual leave", "Sick leave", "Earned leave"]
REASONS = ["family function", "fever", "medical check-up", "travel", "personal work"]
BANKS = ["HDFC", "ICIC", "SBIN", "UTIB"]


def rdate(r):
    return f"{r.randint(1, 28):02d}/{r.randint(1, 12):02d}/2027"


FAMILIES = [
    "login", "demobank_phone", "demobank_address", "demobank_payee", "demobank_login_profile", "demobank_dash_transfer",
    "hr_address", "hr_contact", "hr_leave", "hr_idcard", "hospital_book", "hospital_records",
    "shop_add", "shop_search_add", "shop_checkout_phone", "shop_checkout_address",
    "mail_reply", "mail_compose", "mail_compose_phone", "meet_leave", "meet_login_leave",
]
SITE_OF = {"demobank_": "demobank", "hr_": "hr", "hospital_": "hospital", "shop_": "shopmart", "mail_": "mailbox", "meet_": "videomeet"}


def build(family: str, site: str, r: random.Random) -> dict | None:
    P = "{persona.%s}"
    pw = {"PASSWORD": P % "password"}
    u = P % "username"
    names = {"demobank": "DemoBank", "hr": "the HR Portal", "hospital": "the hospital portal", "shopmart": "ShopMart", "mailbox": "MailBox", "videomeet": "VideoMeet"}
    d = None
    if family == "login":
        t = r.choice(["Log in to {n} as {u} using the stored password", "Please log in to {n} as {u} with the stored password"]).format(n=names[site], u=u)
        d = dict(site=site, start=f"/{site}/login", task=t, secrets=pw, expect=[{"path": "login.ok", "equals": True}], max_steps=10)
    elif family == "demobank_phone":
        t = r.choice(["Change my mobile number to {x} and save the changes", "Update my mobile number to {x} and save"]).format(x=P % "new_phone")
        d = dict(site="demobank", start="/demobank/profile", task=t, expect=[{"path": "profile.phone", "equals": P % "new_phone"}], max_steps=8)
    elif family == "demobank_address":
        t = r.choice(["Change my address to {x} and save the changes", "Update my address to {x} and save the changes"]).format(x=P % "new_address")
        d = dict(site="demobank", start="/demobank/profile", task=t, expect=[{"path": "profile.address", "equals": P % "new_address"}], max_steps=8)
    elif family in ("demobank_payee", "demobank_dash_transfer"):
        acct = str(r.randint(10**11, 10**12 - 1))
        ifsc = f"{r.choice(BANKS)}0{r.randint(0, 999999):06d}"
        amt = r.choice([100, 250, 500, 750, 1200])
        if family == "demobank_payee":
            t = f"Send {amt} rupees to a new payee: account number {acct}, IFSC {ifsc}"
            start = "/demobank/transfer"
        else:
            t = f"Open the transfer page and send {amt} rupees to account number {acct} with IFSC {ifsc}"
            start = "/demobank/dashboard"
        d = dict(site="demobank", start=start, task=t, max_steps=12,
                 expect=[{"path": "payee.account", "equals": acct}, {"path": "payee.ifsc", "equals": ifsc}, {"path": "payee.amount", "equals": str(amt)}])
    elif family == "demobank_login_profile":
        t = f"Log in as {u} with the stored password, then open Profile and change the mobile number to {P % 'new_phone'} and save"
        d = dict(site="demobank", start="/demobank/login", task=t, secrets=pw, max_steps=15,
                 expect=[{"path": "login.ok", "equals": True}, {"path": "profile.phone", "equals": P % "new_phone"}])
    elif family == "hr_address":
        d = dict(site="hr", start="/hr/profile", task=f"Update my address to {P % 'new_address'} using the Update address box and save",
                 expect=[{"path": "address.address", "equals": P % "new_address"}], max_steps=8)
    elif family == "hr_contact":
        d = dict(site="hr", start="/hr/profile", task=f"Change the contact number field to {P % 'new_phone'} and save",
                 expect=[{"path": "address.contact", "equals": P % "new_phone"}], max_steps=8)
    elif family == "hr_leave":
        lt, d1, d2, reason = r.choice(LEAVE_TYPES), rdate(r), rdate(r), r.choice(REASONS)
        kind = lt.split()[0].lower()
        d = dict(site="hr", start="/hr/leave", task=f"Apply for {kind} leave from {d1} to {d2} with the reason {reason}", max_steps=10,
                 expect=[{"path": "leave.type", "equals": lt}, {"path": "leave.from", "equals": d1}, {"path": "leave.to", "equals": d2}, {"path": "leave.reason", "contains": reason.split()[0]}])
    elif family == "hr_idcard":
        d = dict(site="hr", start="/hr/profile", task="Open the ID card page", expect=[{"url_contains": "/hr/idcard"}], max_steps=5)
    elif family == "hospital_book":
        dept, dt = r.choice(DEPTS), rdate(r)
        t = r.choice(["Book an appointment in the {d} department for {t}", "Book a {d} appointment for {t}"]).format(d=dept, t=dt)
        d = dict(site="hospital", start="/hospital/appointments", task=t, expect=[{"path": "book.department", "equals": dept}, {"path": "book.date", "equals": dt}], max_steps=8)
    elif family == "hospital_records":
        d = dict(site="hospital", start="/hospital/appointments", task="Open my medical records", expect=[{"url_contains": "/hospital/records"}], max_steps=5)
    elif family == "shop_add":
        prod = r.choice(PRODUCTS)
        d = dict(site="shopmart", start="/shopmart/search", task=f"Add the {prod} to the cart", expect=[{"path": "cart.item", "equals": prod}], max_steps=8)
    elif family == "shop_search_add":
        prod = r.choice(PRODUCTS)
        term = prod.split()[0].lower()
        d = dict(site="shopmart", start="/shopmart/search", task=f"Search for {term} and add the {prod} to the cart", expect=[{"path": "cart.item", "equals": prod}], max_steps=10)
    elif family == "shop_checkout_phone":
        d = dict(site="shopmart", start="/shopmart/checkout", secrets={"card": P % "card_number", "cvv": "123"}, max_steps=12,
                 task=f"Change the delivery phone number to {P % 'new_phone'}, fill the card number and CVV from the stored secrets, and place the order",
                 expect=[{"path": "order.phone", "equals": P % "new_phone"}, {"path": "order.paid", "equals": True}])
    elif family == "shop_checkout_address":
        d = dict(site="shopmart", start="/shopmart/checkout", secrets={"card": P % "card_number"}, max_steps=12,
                 task=f"Change the delivery address to {P % 'new_address'}, fill the card number from the stored secret, and place the order",
                 expect=[{"path": "order.address", "equals": P % "new_address"}, {"path": "order.paid", "equals": True}])
    elif family == "mail_reply":
        subj, text = r.choice(SUBJECTS), r.choice(REPLIES)
        d = dict(site="mailbox", start="/mailbox/inbox", task=f"Open the mail with the subject {subj} and reply saying: {text}", max_steps=12,
                 expect=[{"path": "send.subject", "startswith": "Re:"}, {"path": "send.subject", "contains": subj}, {"path": "send.message", "contains": text.split(",")[0]}])
    elif family == "mail_compose":
        to = f"{r.choice(['team', 'hr', 'finance', 'support'])}{r.randint(1, 99)}@example.com"
        subj, msg = r.choice(["Weekly update", "Meeting notes", "Quick question"]), r.choice(["All tasks are on track", "Please review the attached notes", "Can we talk tomorrow"])
        d = dict(site="mailbox", start="/mailbox/compose", task=f"Compose a mail to {to} with the subject {subj} and the message {msg}, then send it", max_steps=10,
                 expect=[{"path": "send.to", "equals": to}, {"path": "send.subject", "equals": subj}, {"path": "send.message", "contains": msg.split()[-1]}])
    elif family == "mail_compose_phone":
        to = f"hr{r.randint(1, 99)}@example.com"
        d = dict(site="mailbox", start="/mailbox/compose", task=f"Send a mail to {to} with the subject Contact change and the message: My new number is {P % 'new_phone'}", max_steps=10,
                 expect=[{"path": "send.to", "equals": to}, {"path": "send.message", "contains": P % "new_phone"}])
    elif family == "meet_leave":
        d = dict(site="videomeet", start="/videomeet/meeting", task=r.choice(["Leave the meeting", "Click the Leave meeting button"]), expect=[{"path": "leave.id", "exists": True}], max_steps=5)
    elif family == "meet_login_leave":
        d = dict(site="videomeet", start="/videomeet/login", task=f"Log in as {u} with the stored password, then leave the meeting", secrets=pw, max_steps=12,
                 expect=[{"path": "login.ok", "equals": True}, {"path": "leave.id", "exists": True}])
    return d


def site_of(family: str) -> str | None:
    return next((s for k, s in SITE_OF.items() if family.startswith(k)), None)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-per-template", type=int, default=8)
    ap.add_argument("--test-per-template", type=int, default=4)
    ap.add_argument("--out", default="tasks_gen")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    r = random.Random(a.seed)
    out = Path(__file__).resolve().parent / a.out
    out.mkdir(exist_ok=True)
    for f in out.glob("*.yaml"):
        f.unlink()
    by_site: dict[str, list[dict]] = {}
    personas = list(range(10, 50))
    counter = 0
    for family in FAMILIES:
        sites = [site_of(family)] if site_of(family) else ["demobank", "hr", "hospital", "shopmart", "mailbox", "videomeet"]
        for site in sites:
            n = a.train_per_template if site in TRAIN_SITES else a.test_per_template
            for k in range(n):
                d = build(family, site, r)
                counter += 1
                d.update(id=f"gen-{family}-{site}-{k:02d}", persona=r.choice(personas), secrets=d.get("secrets") or {})
                v = r.choice(LAYOUTS)
                if v:
                    d["v"] = v
                by_site.setdefault(site, []).append(d)
    for site, ts in by_site.items():
        (out / f"{site}.yaml").write_text(yaml.safe_dump(ts, sort_keys=False, allow_unicode=True), encoding="utf-8")
    print(f"wrote {counter} tasks to {out}: " + ", ".join(f"{s}={len(t)}" for s, t in by_site.items()))


if __name__ == "__main__":
    main()
