import csv
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

from fastapi.testclient import TestClient

# Dodaj katalog backend/ do ścieżki importów
sys.path.append(str(Path(__file__).resolve().parents[1]))
from app import app

API_URL = "http://localhost:8080"
CSV_FILE = Path(__file__).parent / "pizzeria-amalfi-bank-statement-2025-v6.csv"


def build_payload_from_csv(as_of_str: str = "2025-05-25", days: int = 45) -> dict:
    as_of = date.fromisoformat(as_of_str)
    shutdown_start = date(2025, 6, 2)
    shutdown_end = date(2025, 6, 22)

    txs = []
    with open(CSV_FILE, mode="r", encoding="UTF-8") as f:
        for row in csv.DictReader(f, delimiter=";"):
            txs.append({
                "date": datetime.strptime(row["Booking Date"], "%d.%m.%y").date(),
                "type": row["Transaction Type"],
                "counterparty": row["Beneficiary/Payer"],
                "amount": float(row["Amount"].replace(",", ".")),
            })

    # 1. Saldo na dzień analizy
    past = [t for t in txs if t["date"] <= as_of]
    current_balance = round(sum(t["amount"] for t in past), 2)

    # 2. Średni dzienny utarg i zakupy z ostatnich 30 dni (przed urlopem)
    w_start = as_of - timedelta(days=30)
    avg_rev = round(sum(
        t["amount"] for t in past
        if w_start < t["date"] <= as_of and "CARD" in t["type"]
    ) / 30.0, 2)
    avg_var = round(sum(
        t["amount"] for t in past
        if w_start < t["date"] <= as_of and t["type"] in ("GIRO CARD PAYMENT", "SUPPLIER PAYMENT")
    ) / 30.0, 2)

    # 3. Budowa harmonogramu transakcji na X dni do przodu dla agenta
    scheduled = []
    fixed_types = {"RENT PAYMENT", "SALARY PAYMENT", "TAX OFFICE TRANSFER", "DIRECT DEBIT", "INTERNATIONAL WIRE TRANSFER"}

    for i in range(1, days + 1):
        d = as_of + timedelta(days=i)
        is_closed = shutdown_start <= d <= shutdown_end

        if not is_closed:
            scheduled.append({
                "due_date": str(d),
                "amount": avg_rev,
                "category": "CARD_REVENUE",
                "counterparty": "Card Settlements Forecast",
                "is_discretionary": False,
            })
            scheduled.append({
                "due_date": str(d),
                "amount": avg_var,
                "category": "SUPPLIERS",
                "counterparty": "Daily Produce & Suppliers",
                "is_discretionary": False,
            })

        for t in txs:
            if t["date"] == d and t["type"] in fixed_types:
                scheduled.append({
                    "due_date": str(d),
                    "amount": t["amount"],
                    "category": t["type"],
                    "counterparty": t["counterparty"],
                    "is_discretionary": (t["type"] == "INTERNATIONAL WIRE TRANSFER"),
                })

    return {
        "company_name": "Pizzeria Amalfi",
        "as_of_date": as_of_str,
        "current_balance": current_balance,
        "currency": "EUR",
        "forecast_days": days,
        "safety_buffer": 5000.0,
        "scheduled_transactions": scheduled,
    }


if __name__ == "__main__":
    payload = build_payload_from_csv()
    res = requests.post(f"{API_URL}/tools/liquidity/analyze", json=payload).json()
    print("=== RAPORT AGENTA ===")
    print("Min saldo:", res["min_projected_balance"], "w dniu", res["min_balance_date"])
    print("Rekomendacja:", res["proposed_action"])

    if res.get("proposed_action"):
        aid = res["proposed_action"]["action_id"]
        approval = requests.post(
            f"{API_URL}/tools/liquidity/actions/{aid}/decide", params={"approve": True}
        ).json()
        print("\n=== PO ZATWIERDZENIU (HUMAN-IN-THE-LOOP) ===")
        print(approval)

client = TestClient(app)

if __name__ == "__main__":
    payload = build_payload_from_csv()
    res = client.post("/tools/liquidity/analyze", json=payload).json()
    print("=== RAPORT AGENTA ===")
    print("Min saldo:", res["min_projected_balance"], "w dniu", res["min_balance_date"])
    print("Rekomendacja:", res["proposed_action"])

    if res.get("proposed_action"):
        aid = res["proposed_action"]["action_id"]
        approval = client.post(
            f"/tools/liquidity/actions/{aid}/decide", params={"approve": True}
        ).json()
        print("\n=== PO ZATWIERDZENIU (HUMAN-IN-THE-LOOP) ===")
        print(approval)