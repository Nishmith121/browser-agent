"""ShopMart: product search, cart, checkout (name, address, phone, card fields). No real payment."""
from html import escape

from sitekit import gt, login_page, page, post_js

NAME, TITLE, BRAND, FIRST = "shopmart", "ShopMart", "#c2570c", "search"
NAV = [("search", "Search"), ("cart", "Cart"), ("checkout", "Checkout")]
CATALOG = [
    ("Wireless mouse", 799), ("Mechanical keyboard", 3499), ("USB-C cable", 299), ("Laptop stand", 1299),
    ("Noise cancelling headphones", 5999), ("Webcam HD", 2199), ("Desk lamp", 899), ("Phone charger", 599),
]


def login(v="", q=None):
    return login_page(NAME, TITLE, BRAND, FIRST, v), []


def search(p, v="", q=None):
    term = (q or {}).get("q", [""])[0].lower()
    items = [(i, n, price) for i, (n, price) in enumerate(CATALOG) if term in n.lower()]
    rows = "".join(
        f'<tr><td class="pname">{escape(n)}</td><td>Rs {price}</td>'
        f'<td><button class="add" id="add-{i}" onclick="add({i},\'{escape(n)}\',{price})">Add to cart</button></td></tr>'
        for i, n, price in items) or '<tr><td colspan="3">No products found.</td></tr>'
    body = f"""<h1>Search products</h1>
<form method="get" action="/shopmart/search"><input type="hidden" name="p" value="{p['id']}">{f'<input type="hidden" name="v" value="{v}">' if v else ''}
<input id="q" name="q" placeholder="Search products" value="{escape(term)}" style="width:70%"><button id="search-btn" type="submit" style="margin-left:8px">Search</button></form>
<table style="margin-top:14px">{rows}</table><p id="msg"></p>"""
    script = post_js(NAME, p["id"]) + """
async function add(i,name,price){const j=await post('cart',{item:name,price:price});msg.textContent=j.ok?name+' added to cart':'Error'}"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), []


def cart(p, v="", q=None):
    body = f"""<h1>Your cart</h1><p>Shopping as <span id="name">{escape(p['full_name'])}</span></p>
<p>Items you add appear here after checkout opens. <a id="go-checkout" href="/shopmart/checkout?p={p['id']}{'&v=' + v if v else ''}">Proceed to checkout</a></p>"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v), gt(("#name", "NAME", p["full_name"]))


def checkout(p, v="", q=None):
    card = f"{p['card_number'][:4]} {p['card_number'][4:8]} {p['card_number'][8:12]} {p['card_number'][12:]}"
    body = f"""<h1>Checkout</h1>
<div class="card"><b>Ship to</b><div id="ship-name">{escape(p['full_name'])}</div>
<div id="ship-address">{escape(p['address'])}</div><div>Phone: <span id="ship-phone">{p['phone']}</span></div>
<div>Email: <span id="ship-email">{p['email']}</span></div></div>
<div class="card">Saved card: <span id="saved-card">{card}</span></div>
<form onsubmit="return order(event)">
<div class="row"><div><label for="phone">Delivery phone</label><input id="phone" name="phone" type="tel" value="{p['phone']}"></div>
<div><label for="address">Delivery address</label><input id="address" name="address" value="{escape(p['address'])}"></div></div>
<div class="row"><div><label for="card-number">Card number</label><input id="card-number" name="card_number" autocomplete="cc-number"></div>
<div><label for="cvv">CVV</label><input id="cvv" name="cvv" autocomplete="cc-csc"></div></div>
<button id="place-order" type="submit">Place order</button><p id="msg"></p></form>"""
    script = post_js(NAME, p["id"]) + """
async function order(e){e.preventDefault();
 const j=await post('order',{phone:phone.value,address:address.value,paid:document.getElementById('card-number').value.length>0});
 msg.textContent=j.ok?'Order placed':'Error';return false}"""
    return page(NAME, TITLE, BRAND, body, p, NAV, v, script), gt(
        ("#ship-name", "NAME", p["full_name"]), ("#ship-address", "ADDRESS", p["address"]),
        ("#ship-phone", "PHONE", p["phone"]), ("#ship-email", "EMAIL", p["email"]),
        ("#saved-card", "CARD", card), ("#phone", "PHONE", p["phone"]), ("#address", "ADDRESS", p["address"]),
        ("#card-number", "CARD", ""), ("#cvv", "CVV", ""))


PAGES = {"search": search, "cart": cart, "checkout": checkout}
