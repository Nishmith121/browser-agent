"""HR Portal: login, profile (name, PAN, Aadhaar, DOB, address, photo), apply-leave."""
from html import escape

from sitekit import fmt_aadhaar, gt, login_page, page, photo_url, post_js

NAME, TITLE, BRAND, FIRST = "hr", "HR Portal", "#1f6f50", "profile"
NAV = [("profile", "My profile"), ("leave", "Apply leave"), ("idcard", "ID card")]


def login(v="", q=None):
    return login_page(NAME, TITLE, BRAND, FIRST, v), []


def profile(p, v="", q=None):
    aadhaar = fmt_aadhaar(p["aadhaar"])
    body = f"""<div class="row"><div style="flex:0 0 170px"><img class="photo" id="photo" alt="Employee photo" src="{photo_url(p)}"></div>
<div style="flex:1"><h1 id="name">{escape(p['full_name'])}</h1>
<div class="kv"><b>Employee email</b><span id="email">{p['email']}</span></div>
<div class="kv"><b>Mobile</b><span id="phone">{p['phone']}</span></div>
<div class="kv"><b>PAN</b><span id="pan">{p['pan']}</span></div>
<div class="kv"><b>Aadhaar</b><span id="aadhaar">{aadhaar}</span></div>
<div class="kv"><b>Date of birth</b><span id="dob">{p['dob']}</span></div>
<div class="kv"><b>Address</b><span id="address-text">{escape(p['address'])}</span></div></div></div>
<form onsubmit="return save(event)">
<label for="address">Update address</label><input id="address" name="address" value="">
<label for="contact">Contact number</label><input id="contact" name="contact" type="tel" value="{p['phone']}">
<button id="save-address" type="submit">Save</button><p id="msg"></p></form>"""
    script = post_js(NAME, p["id"]) + """
async function save(e){e.preventDefault();
 const j=await post('address',{address:address.value,contact:contact.value});msg.textContent=j.ok?'Address updated':'Error';return false}"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(
        ("#name", "NAME", p["full_name"]), ("#email", "EMAIL", p["email"]), ("#phone", "PHONE", p["phone"]),
        ("#pan", "PAN", p["pan"]), ("#aadhaar", "AADHAAR", aadhaar), ("#dob", "DOB", p["dob"]),
        ("#address-text", "ADDRESS", p["address"]), ("#contact", "PHONE", p["phone"]), ("#photo", "FACE", ""))


def leave(p, v="", q=None):
    body = f"""<h1>Apply for leave</h1><p>Employee: <span id="name">{escape(p['full_name'])}</span></p>
<form onsubmit="return apply(event)">
<label for="leave-type">Leave type</label><select id="leave-type"><option>Casual leave</option><option>Sick leave</option><option>Earned leave</option></select>
<div class="row"><div><label for="from">From (DD/MM/YYYY)</label><input id="from"></div><div><label for="to">To (DD/MM/YYYY)</label><input id="to"></div></div>
<label for="reason">Reason</label><textarea id="reason" rows="3"></textarea>
<button id="submit-leave" type="submit">Submit leave request</button><p id="msg"></p></form>"""
    script = post_js(NAME, p["id"]) + """
async function apply(e){e.preventDefault();
 const j=await post('leave',{type:document.getElementById('leave-type').value,from:document.getElementById('from').value,
 to:document.getElementById('to').value,reason:document.getElementById('reason').value});msg.textContent=j.ok?'Leave request submitted':'Error';return false}"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(("#name", "NAME", p["full_name"]))


PITCH = 14  # px per character on the ID card canvas (fixed so ground-truth boxes are exact)
VALUE_X = 150
ROWS = [("Name", "NAME"), ("PAN", "PAN"), ("Mobile", "PHONE"), ("Aadhaar", "AADHAAR")]


def idcard(p, v="", q=None):
    """The card is a <canvas>: its text is not in the DOM, so only OCR can find it."""
    values = {"Name": p["full_name"], "PAN": p["pan"], "Mobile": p["phone"], "Aadhaar": fmt_aadhaar(p["aadhaar"])}
    body = f"""<h1>Employee ID card</h1><canvas id="idcard" width="520" height="200" style="border:1px solid #888;background:#fff"></canvas>
<p>Scan or print this card for office access.</p>"""
    draw = "".join(
        f"""t('{label}',20,{20 + 40 * i});for(const [k,ch] of [...{values[label]!r}].entries())g.fillText(ch,{VALUE_X}+k*{PITCH},{20 + 40 * i});"""
        for i, (label, _) in enumerate(ROWS))
    script = f"""const c=document.getElementById('idcard'),g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,520,200);
g.fillStyle='#000';g.font='22px monospace';g.textBaseline='top';const t=(s,x,y)=>g.fillText(s+':',x,y);{draw}"""
    items = [("#idcard", cat, values[label], [VALUE_X, 20 + 40 * i, PITCH * len(values[label]), 24]) for i, (label, cat) in enumerate(ROWS)]
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(*items)


PAGES = {"profile": profile, "leave": leave, "idcard": idcard}
