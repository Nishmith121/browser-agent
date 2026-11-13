"""Hospital: patient login, appointments (book by department), records."""
from html import escape

from sitekit import gt, login_page, page, photo_url, post_js

NAME, TITLE, BRAND, FIRST = "hospital", "City Hospital", "#8a2342", "appointments"
NAV = [("appointments", "Appointments"), ("records", "Records")]
DEPARTMENTS = ["Cardiology", "Dermatology", "Neurology", "Orthopaedics", "Paediatrics"]


def login(v="", q=None):
    return login_page(NAME, TITLE, BRAND, FIRST, v), []


def appointments(p, v="", q=None):
    opts = "".join(f"<option>{d}</option>" for d in DEPARTMENTS)
    body = f"""<h1>Hello, <span id="name">{escape(p['full_name'])}</span></h1>
<div class="kv"><b>Registered phone</b><span id="phone">{p['phone']}</span></div>
<div class="kv"><b>Date of birth</b><span id="dob">{p['dob']}</span></div>
<h3>Upcoming appointments</h3><table><tr><th>Department</th><th>Date</th></tr><tr><td>General physician</td><td>12/12/2026</td></tr></table>
<h3>Book an appointment</h3><form onsubmit="return book(event)">
<label for="department">Department</label><select id="department">{opts}</select>
<label for="date">Preferred date (DD/MM/YYYY)</label><input id="date">
<button id="book-btn" type="submit">Book appointment</button><p id="msg"></p></form>"""
    script = post_js(NAME, p["id"]) + """
async function book(e){e.preventDefault();
 const j=await post('book',{department:document.getElementById('department').value,date:document.getElementById('date').value});
 msg.textContent=j.ok?'Appointment booked':'Error';return false}"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(
        ("#name", "NAME", p["full_name"]), ("#phone", "PHONE", p["phone"]), ("#dob", "DOB", p["dob"]))


def records(p, v="", q=None):
    body = f"""<div class="row"><div style="flex:0 0 170px"><img class="photo" id="photo" alt="Patient photo" src="{photo_url(p)}"></div>
<div style="flex:1"><h1>Medical record</h1>
<div class="kv"><b>Patient</b><span id="name">{escape(p['full_name'])}</span></div>
<div class="kv"><b>Date of birth</b><span id="dob">{p['dob']}</span></div>
<div class="kv"><b>Phone</b><span id="phone">{p['phone']}</span></div>
<div class="kv"><b>Patient ID</b><span id="pid">PT-{p['id']:05d}</span></div></div></div>
<h3>Notes</h3><table><tr><th>Date</th><th>Note</th></tr>
<tr><td>03/02/2026</td><td>Routine check-up, blood pressure normal.</td></tr>
<tr><td>19/05/2026</td><td>Follow-up. Emergency contact <span id="emergency">{p['new_phone']}</span>.</td></tr></table>"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v), gt(
        ("#name", "NAME", p["full_name"]), ("#dob", "DOB", p["dob"]), ("#phone", "PHONE", p["phone"]),
        ("#emergency", "PHONE", p["new_phone"]), ("#photo", "FACE", ""))


PAGES = {"appointments": appointments, "records": records}
