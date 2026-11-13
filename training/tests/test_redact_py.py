"""The Python port must behave like extension/src/redaction (inputs mirror extension/tests/*.test.ts)."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from redact_py import RedactionMap, classify_field, detect_pii, luhn_valid, verhoeff_valid  # noqa: E402

AADHAAR, BAD_AADHAAR = "726018159082", "523194875749"
CARD, BAD_CARD = "4111112462819484", "1186252760189555"


def cats(text, **kw):
    return [f"{s.category}:{s.value}" for s in detect_pii(text, **kw)]


def test_checksums():
    assert verhoeff_valid(AADHAAR) and not verhoeff_valid(BAD_AADHAAR)
    assert luhn_valid(CARD) and not luhn_valid(BAD_CARD)


def test_structured_detectors():
    assert cats(AADHAAR) == [f"AADHAAR:{AADHAAR}"]
    g = f"{AADHAAR[:4]} {AADHAAR[4:8]} {AADHAAR[8:]}"
    assert cats(f"Aadhaar: {g}") == [f"AADHAAR:{g}"]
    assert cats(BAD_AADHAAR) == []
    assert cats("PAN ABCPE1234F") == ["PAN:ABCPE1234F"] and cats("ABCXE1234F") == []
    assert cats("call 9876543210 now") == ["PHONE:9876543210"]
    assert cats("+91 98765 43210") == ["PHONE:+91 98765 43210"]
    assert cats("5876543210") == [] and cats("98765432101") == []
    assert cats("mail a.b+c@example.co.in please") == ["EMAIL:a.b+c@example.co.in"]
    spaced = f"{CARD[:4]} {CARD[4:8]} {CARD[8:12]} {CARD[12:]}"
    assert cats(spaced) == [f"CARD:{spaced}"] and cats(BAD_CARD) == []
    assert cats("IFSC HDFC0123456") == ["IFSC:HDFC0123456"] and cats("HDFC1123456") == []


def test_context_detectors():
    assert cats("Account number: 123456789012") == ["ACCOUNT:123456789012"]
    assert cats("order id 123456789012") == []
    assert cats("Account number: 123456789012", contextual=False) == []
    assert cats("DOB: 05/03/1990") == ["DOB:05/03/1990"]
    assert cats("Appointment on 05/03/2026") == []
    assert cats("Balance Rs 1,25,000") == [] and cats("Balance Rs 1,25,000", currency=True) == ["AMOUNT:Rs 1,25,000"]


def test_every_persona_address_is_one_span():
    personas = json.loads((Path(__file__).resolve().parents[2] / "testsites" / "personas.json").read_text(encoding="utf-8"))
    for p in personas:
        for a in (p["address"], p["new_address"]):
            assert [s.value for s in detect_pii(a) if s.category == "ADDRESS"] == [a], a


def test_address_negatives_and_street_form():
    assert cats("Ship to 455, Apte Zila, Kakinada 498341 today") == ["ADDRESS:455, Apte Zila, Kakinada 498341"]
    assert cats("Visit 221 Baker Street, London") == ["ADDRESS:221 Baker Street, London"]
    for t in ["Order 3, Item, 123456 shipped", "Rs 5,000", "Sign in", "Balance: 12,345"]:
        assert [s for s in detect_pii(t) if s.category == "ADDRESS"] == [], t


@pytest.mark.parametrize("attrs,cat", [
    (dict(type_="password"), "PASSWORD"), (dict(autocomplete="cc-csc"), "CVV"), (dict(autocomplete="one-time-code"), "OTP"),
    (dict(name="aadhaar_no"), "AADHAAR"), (dict(label="Payee account number"), "ACCOUNT"), (dict(id_="ifscCode"), "IFSC"),
    (dict(label="Security Answer"), "SECURITY_ANSWER"),
])
def test_dom_rules_sensitive(attrs, cat):
    assert classify_field(**attrs) == cat


@pytest.mark.parametrize("attrs", [dict(label="Username"), dict(label="Mobile number"), dict(label="Shipping address"), dict(label="Panel width")])
def test_dom_rules_no_substring_false_positives(attrs):
    assert classify_field(**attrs) is None


def test_redaction_map_matches_the_extension():
    m = RedactionMap()
    assert m.sanitise("Call 98765 43210 or 9876543210, mail a@b.com; PAN ABCPE1234F") == "Call [PHONE_1] or [PHONE_1], mail [EMAIL_1]; PAN [PAN_1]"
    assert m.sanitise("9123456780") == "[PHONE_2]"
    assert m.restore("type [PHONE_2] then [PHONE_1]") == ("type 9123456780 then 98765 43210", [])
    assert m.restore("[PHONE_9]")[1] == ["[PHONE_9]"]
    assert detect_pii(RedactionMap().sanitise(f"{AADHAAR} {CARD} 9876543210 x@y.com ABCPE1234F HDFC0123456"), contextual=False) == []
