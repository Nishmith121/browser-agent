"""DemoBank: login, dashboard, profile, transfer."""
from html import escape

from sitekit import gt, login_page, page, post_js

NAME, TITLE, BRAND, FIRST = "demobank", "DemoBank", "#12306b", "dashboard"
NAV = [("dashboard", "Dashboard"), ("profile", "Profile"), ("transfer", "Transfer")]


def login(v="", q=None):
    return login_page(NAME, TITLE, BRAND, FIRST, v), []


def dashboard(p, v="", q=None):
    body = f"""<h1>Welcome, <span id="name">{escape(p['full_name'])}</span></h1>
<div class="kv"><b>Account number</b><span id="account">{p['account_number']}</span></div>
<div class="kv"><b>IFSC</b><span id="ifsc">{p['ifsc']}</span></div>
<div class="kv"><b>Balance</b><span id="balance">Rs {p['balance']}</span></div>
<div class="kv"><b>Registered mobile</b><span id="phone">{p['phone']}</span></div>
<button id="new-transfer" onclick="location.href='/demobank/transfer?p={p['id']}{'&v=' + v if v else ''}'">New transfer</button>"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v), gt(
        ("#name", "NAME", p["full_name"]), ("#account", "ACCOUNT", p["account_number"]),
        ("#ifsc", "IFSC", p["ifsc"]), ("#phone", "PHONE", p["phone"]))


def profile(p, v="", q=None):
    body = f"""<h1>Profile</h1>
<div class="kv"><b>Name</b><span id="name">{escape(p['full_name'])}</span></div>
<div class="kv"><b>Email</b><span id="email">{p['email']}</span></div>
<form onsubmit="return save(event)">
<label for="phone">Mobile number</label><input id="phone" name="phone" type="tel" value="{p['phone']}">
<label for="address">Address</label><input id="address" name="address" value="{escape(p['address'])}">
<button type="submit" id="save-btn">Save changes</button><p id="msg"></p></form>"""
    script = post_js(NAME, p["id"]) + """
async function save(e){e.preventDefault();
 const j=await post('profile',{phone:phone.value,address:address.value});msg.textContent=j.ok?'Saved':'Error';return false}"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(
        ("#name", "NAME", p["full_name"]), ("#email", "EMAIL", p["email"]),
        ("#phone", "PHONE", p["phone"]), ("#address", "ADDRESS", p["address"]))


def transfer(p, v="", q=None):
    body = """<h1>Transfer</h1><form onsubmit="return add(event)">
<label for="payee-account">Payee account number</label><input id="payee-account" name="account_number">
<label for="payee-ifsc">Payee IFSC</label><input id="payee-ifsc" name="ifsc">
<label for="amount">Amount (Rs)</label><input id="amount" name="amount" type="number">
<button id="send-btn">Send</button><p id="msg"></p></form>"""
    script = post_js(NAME, p["id"]) + """
async function add(e){e.preventDefault();
 const j=await post('payee',{account:document.getElementById('payee-account').value,ifsc:document.getElementById('payee-ifsc').value,
 amount:document.getElementById('amount').value});msg.textContent=j.ok?'Transfer sent':'Error';return false}"""
    # Empty but sensitive fields: they must be painted (value hidden even once typed), so they are ground truth.
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(
        ("#payee-account", "ACCOUNT", ""), ("#payee-ifsc", "IFSC", ""))


PAGES = {"dashboard": dashboard, "profile": profile, "transfer": transfer}
