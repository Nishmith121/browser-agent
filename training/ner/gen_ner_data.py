"""Synthetic NER data for Indian names/places in web-page text (Phase 8).

  python gen_ner_data.py            # -> data/ner/{train,val}.jsonl and test_*.jsonl

Word-level BIO tags with the label set of dslim/bert-base-NER (O, PER, ORG, LOC, MISC), so the fine-tuned model is a drop-in.
Nothing is shared between training and test:
  * first names, surnames and cities from Faker en_IN are split by hash into train / held-out pools;
  * templates (the text around the entity) are split into train / held-out sets;
  * `test_hard` uses a hand-written list of Indian names that Faker cannot produce (initials, Sikh, Muslim, Christian,
    Bengali, South-Indian styles) in held-out templates.
The testsites' personas come from the same Faker pools, so the held-out pool is also what keeps the site evaluation honest:
persona names that fall in the train pool are reported separately by eval_ner.py.
"""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

from faker.providers.person.en_IN import Provider as P

OUT = Path(__file__).resolve().parent.parent / "data" / "ner"


def in_test_pool(s: str) -> bool:
    return int(hashlib.md5(s.encode()).hexdigest(), 16) % 10 < 3  # 30% held out


FIRST = sorted(set(P.first_names_male + P.first_names_female))
LAST = sorted(set(P.last_names))
F_TRAIN, F_TEST = [x for x in FIRST if not in_test_pool(x)], [x for x in FIRST if in_test_pool(x)]
L_TRAIN, L_TEST = [x for x in LAST if not in_test_pool(x)], [x for x in LAST if in_test_pool(x)]

CITIES = ["Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Ahmedabad", "Chennai", "Kolkata", "Pune", "Jaipur", "Surat", "Lucknow", "Kanpur", "Nagpur",
          "Indore", "Thane", "Bhopal", "Visakhapatnam", "Patna", "Vadodara", "Ghaziabad", "Ludhiana", "Agra", "Nashik", "Faridabad", "Meerut", "Rajkot",
          "Varanasi", "Srinagar", "Aurangabad", "Dhanbad", "Amritsar", "Ranchi", "Coimbatore", "Jabalpur", "Gwalior", "Vijayawada", "Jodhpur", "Madurai",
          "Raipur", "Kota", "Guwahati", "Chandigarh", "Mysuru", "Kochi", "Dehradun", "Shimla", "Panaji", "Bhubaneswar", "Thiruvananthapuram", "Mangaluru"]
C_TRAIN, C_TEST = [c for c in CITIES if not in_test_pool(c)], [c for c in CITIES if in_test_pool(c)]
STATES = ["Maharashtra", "Karnataka", "Tamil Nadu", "Kerala", "Gujarat", "Rajasthan", "Punjab", "West Bengal", "Uttar Pradesh", "Telangana", "Bihar", "Odisha", "Assam"]
ORGS = ["Tata Consultancy Services", "Infosys Limited", "Reliance Industries", "HDFC Bank", "State Bank of India", "ICICI Bank", "Apollo Hospitals", "Fortis Healthcare",
        "Wipro Technologies", "Bharti Airtel", "Mahindra & Mahindra", "Axis Bank", "Zomato", "Flipkart", "Paytm", "Max Super Speciality Hospital", "DemoBank", "ShopMart",
        "MailBox", "VideoMeet", "Indian Oil Corporation", "Larsen & Toubro", "Kotak Mahindra Bank", "Bajaj Finserv", "Narayana Health", "Lupin Pharmaceuticals"]
# words the model must NOT tag: UI vocabulary and product names that are title-case in page text
UI = ["Dashboard", "Aadhaar", "Account Summary", "Transfer Funds", "Add Payee", "Sign In", "Log Out", "Profile", "Settings", "Leave Balance", "Apply Leave",
      "Cardiology", "Neurology", "Dermatology", "Book Appointment", "Medical Records", "Order History", "Add to Cart", "Checkout", "Inbox", "Compose", "Sent Items",
      "Join Meeting", "Leave Meeting", "Mute", "Camera", "PAN Card", "IFSC Code", "Net Banking", "Contact Details", "Payroll", "Privacy Policy", "Help Centre",
      "Savings Account", "Current Account", "Fixed Deposit", "Wireless Headphones", "USB Cable", "Mechanical Keyboard", "Invoice", "Kickoff Meeting"]

# templates: {} marks the entity slot; the tag names the slot's entity type. Held-out ones never appear in training.
T_PER_TRAIN = ["Welcome back, {}", "Account holder: {}", "Name: {}", "Dear {},", "Logged in as {}", "Patient: {}", "Employee: {}", "Hello {}!", "Payee: {}",
               "Beneficiary name: {}", "From: {}", "To: {}", "Prepared for {}", "Customer name {}", "{}", "{}", "{}", "Booking for {}", "Signed by {}",
               "Reply from {} received", "Cardholder {}", "Contact person - {}", "{} (primary)", "Organiser: {}", "Added by {}", "Hi {}, your order is confirmed"]
T_PER_TEST = ["Greetings {}", "Holder name - {}", "Manager: {}", "Your profile, {}", "{} joined the meeting", "Recipient: {}", "Shipping to {}", "Welcome {}!",
              "Approved by {}", "Applicant {}", "Meeting host {}", "Nominee: {}"]
T_LOC_TRAIN = ["City: {}", "Branch: {}", "{}", "Located in {}", "Ship to {} today", "Hospital in {}", "Born in {}", "Office - {}"]
T_LOC_TEST = ["Town: {}", "Delivery city {}", "Posted from {}", "Based in {}"]
T_ORG_TRAIN = ["Employer: {}", "{}", "Bank: {}", "Insurer {}", "Issued by {}", "Thank you for choosing {}", "Powered by {}"]
T_ORG_TEST = ["Company - {}", "Partner: {}", "Customer care of {}", "A product of {}"]
T_UI_TRAIN = ["{}", "{}", "Go to {}", "Open {}", "Click {} to continue", "{} page", "My {}", "View {}"]
T_UI_TEST = ["Select {}", "Back to {}", "{} section", "Choose {}"]

HARD_NAMES = [  # not producible by Faker en_IN pools; mixed regional / religious / initial styles
    "K. Ramesh", "S. Lakshmi Narayanan", "A. P. J. Abdul Kalam", "M. S. Dhoni", "R. Ashwin", "Harpreet Kaur Gill", "Gurpreet Singh Sandhu", "Mohd. Arif Khan",
    "Fatima Begum", "Abdul Rahman Shaikh", "Mary Joseph", "Thomas Mathew", "Anjali Menon", "Suresh Raina", "Sourav Chowdhury", "Debashish Bhattacharya", "Mamata Sen",
    "Venkata Subramanian Iyer", "Padmavathi Reddy", "Chandrasekhar Rao", "Naveen Gowda", "Siddharth Malhotra", "Nandini Deshpande", "Prakash Jha", "Kavya Nair",
    "Tenzin Dorjee", "Lalduhawma Hmar", "Biju Thomas", "Ishaan Kapoor", "Pooja Hegde", "Rizwan Ansari", "Zainab Qureshi", "Imran Siddiqui", "Jasleen Dhillon",
    "Manpreet Brar", "Ananya Pillai", "Gopal Krishna Naidu", "Rukmini Devi", "Sreenivasan Kutty", "Shankar Mahadevan", "Vaishali Kulkarni", "Tarun Bajaj",
    "Meenakshi Sundaram", "Alok Nath Tripathi", "Divya Bharti", "Pranav Mohanty", "Smita Patil", "Rohan Joshi", "Lata Mangeshkar", "Ravi Shankar Prasad",
]


def fill(rng, tmpl, parts, tag):
    """Template + entity words -> (words, tags)."""
    pre, post = tmpl.split("{}")
    words, tags = pre.split(), ["O"] * len(pre.split())
    for i, w in enumerate(parts):
        words.append(w)
        tags.append(("B-" if i == 0 else "I-") + tag)
    tail = post.split()
    return words + tail, tags + ["O"] * len(tail)


def person(rng, first, last, style=None):
    style = style or rng.choices(["fl", "fml", "f", "l", "init", "caps", "title"], [40, 12, 8, 6, 8, 6, 8])[0]
    f, l = rng.choice(first), rng.choice(last)
    if style == "fl":
        return [f, l]
    if style == "fml":
        return [f, rng.choice(first), l]
    if style == "f":
        return [f]
    if style == "l":
        return [l]
    if style == "init":
        return [f[0] + ".", l]
    if style == "caps":
        return [f.upper(), l.upper()]
    return [rng.choice(["Mr.", "Mrs.", "Ms.", "Dr.", "Shri", "Smt."]), f, l]


def example(rng, kind, templates_per, first, last, cities, hard=False):
    if kind == "per":
        parts = rng.choice(HARD_NAMES).split() if hard else person(rng, first, last)
        tmpl = rng.choice(templates_per["per"])
        if parts[0] in {"Mr.", "Mrs.", "Ms.", "Dr.", "Shri", "Smt."}:  # a title is not part of the name span
            tmpl, parts = tmpl.replace("{}", parts[0] + " {}"), parts[1:]
        return fill(rng, tmpl, parts, "PER")
    if kind == "loc":
        parts = rng.choice(cities).split() if rng.random() < 0.8 else rng.choice(STATES).split()
        return fill(rng, rng.choice(templates_per["loc"]), parts, "LOC")
    if kind == "org":
        return fill(rng, rng.choice(templates_per["org"]), rng.choice(ORGS).split(), "ORG")
    return fill(rng, rng.choice(templates_per["ui"]), rng.choice(UI).split(), "X")  # X -> all O


def finish(w, t):
    return {"words": w, "tags": [("O" if x.endswith("-X") else x) for x in t]}


def build(rng, n, templates, first, last, cities, mix, hard=False):
    kinds = list(mix)
    weights = [mix[k] for k in kinds]
    out = []
    for _ in range(n):
        k = rng.choices(kinds, weights)[0]
        w, t = example(rng, k, templates, first, last, cities, hard=hard and k == "per")
        # sometimes two entities in one node (an address line / a table row)
        if rng.random() < 0.15 and k == "per":
            w2, t2 = example(rng, "loc", templates, first, last, cities)
            sep = rng.choice([",", "-", "|"])
            w, t = w + [sep] + w2, t + ["O"] + t2
        out.append(finish(w, t))
    return out


def write(name, rows):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.jsonl").write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    ents = sum(1 for r in rows for t in r["tags"] if t.startswith("B-PER"))
    print(f"{name}: {len(rows)} rows, {ents} person names")


def main() -> None:
    rng = random.Random(8)
    tr = {"per": T_PER_TRAIN, "loc": T_LOC_TRAIN, "org": T_ORG_TRAIN, "ui": T_UI_TRAIN}
    te = {"per": T_PER_TEST, "loc": T_LOC_TEST, "org": T_ORG_TEST, "ui": T_UI_TEST}
    mix = {"per": 0.55, "loc": 0.15, "org": 0.12, "ui": 0.18}
    write("train", build(rng, 24000, tr, F_TRAIN, L_TRAIN, C_TRAIN, mix))
    write("val", build(rng, 1500, tr, F_TRAIN, L_TRAIN, C_TRAIN, mix))
    write("test_heldout", build(rng, 1500, te, F_TEST, L_TEST, C_TEST, mix))
    write("test_hard", build(rng, 1200, te, F_TEST, L_TEST, C_TEST, {"per": 1.0}, hard=True))
    write("test_negatives", build(rng, 1200, te, F_TEST, L_TEST, C_TEST, {"loc": 0.3, "org": 0.3, "ui": 0.4}))
    print("name pools: first", len(F_TRAIN), "/", len(F_TEST), " last", len(L_TRAIN), "/", len(L_TEST), " cities", len(C_TRAIN), "/", len(C_TEST))


if __name__ == "__main__":
    main()
