"""Generate synthetic Indian personas (seeded, Faker en_IN). Output: testsites/personas.json"""
import json
import random
from pathlib import Path

from faker import Faker

from validators import make_aadhaar, make_card, make_pan

SEED = 20261027
COUNT = 50
BANKS = ["HDFC", "ICIC", "SBIN", "UTIB"]


def generate(count: int = COUNT, seed: int = SEED) -> list[dict]:
    fake = Faker("en_IN")
    Faker.seed(seed)
    rng = random.Random(seed)
    extra = Faker("en_IN")  # separate stream so adding fields does not shift existing persona data
    extra.seed_instance(seed + 1)
    out = []
    for i in range(count):
        name = fake.name()
        out.append({
            "id": i,
            "full_name": name,
            "username": f"user{i:02d}",
            "email": f"{name.lower().replace(' ', '.')}{i}@example.com",
            "phone": f"{rng.choice('6789')}{rng.randint(0, 999999999):09d}",
            "new_phone": f"{rng.choice('6789')}{rng.randint(0, 999999999):09d}",
            "aadhaar": make_aadhaar(rng),
            "pan": make_pan(rng),
            "dob": fake.date_of_birth(minimum_age=21, maximum_age=65).strftime("%d/%m/%Y"),
            "address": fake.address().replace("\n", ", "),
            "account_number": str(rng.randint(10**10, 10**12 - 1)),
            "ifsc": f"{rng.choice(BANKS)}0{rng.randint(0, 999999):06d}",
            "card_number": make_card(rng),
            "password": f"Pw!{rng.randint(100000, 999999)}x",
            "balance": f"{rng.randint(5000, 900000):,}",
            "new_address": extra.address().replace("\n", ", "),
            "photo": f"photos/face{i % 20:02d}.jpg",
        })
    return out


if __name__ == "__main__":
    path = Path(__file__).resolve().parent.parent / "personas.json"
    path.write_text(json.dumps(generate(), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {path}")
