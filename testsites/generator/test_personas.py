import re

from personas import generate
from validators import luhn_valid, verhoeff_valid


def test_deterministic():
    assert generate(5) == generate(5)


def test_identifiers_valid():
    for p in generate():
        assert verhoeff_valid(p["aadhaar"]) and p["aadhaar"][0] in "23456789"
        assert luhn_valid(p["card_number"]) and p["card_number"].startswith("411111")
        assert re.fullmatch(r"[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z]", p["pan"])
        assert re.fullmatch(r"[6-9]\d{9}", p["phone"])
        assert re.fullmatch(r"[A-Z]{4}0[A-Z0-9]{6}", p["ifsc"])


def test_unique_usernames():
    ps = generate()
    assert len({p["username"] for p in ps}) == len(ps) == 50
