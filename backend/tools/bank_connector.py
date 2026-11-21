import os
import time
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Tuple

import jwt
import requests

from schemas import Invoice, InvoiceFX, ScheduledTransaction

ENABLE_BANKING_API = "https://api.enablebanking.com"
EB_APP_ID = os.getenv("ENABLE_BANKING_APP_ID", "aba10ff0-32bf-4823-a905-364a55315690").strip()
EB_PRIVATE_KEY_PATH = os.getenv(
    "ENABLE_BANKING_KEY_PATH",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "private_key.pem"),
).strip()
EB_REDIRECT_URI = os.getenv("ENABLE_BANKING_REDIRECT_URI", "http://localhost:8000/api/bank/callback").strip()

# Pamięć aktywnych sesji Open Banking (account_key -> session_id)
BANK_SESSIONS: Dict[str, str] = {}


def _build_jwt() -> str:
    """Generuje token JWT podpisany kluczem prywatnym .pem."""
    with open(EB_PRIVATE_KEY_PATH, "r", encoding="utf-8") as f:
        private_key = f.read()

    now = int(time.time())
    payload = {
        "iss": "enablebanking.com",
        "aud": "api.enablebanking.com",
        "iat": now,
        "exp": now + 3600,
    }
    headers = {
        "typ": "JWT",
        "alg": "RS256",
        "kid": EB_APP_ID,
    }
    return jwt.encode(payload, private_key, algorithm="RS256", headers=headers)


def _eb_headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {_build_jwt()}",
        "Content-Type": "application/json",
    }


def get_german_sandbox_aspsp() -> str:
    """Znajduje dokładną nazwę banku testowego Mock ASPSP w Niemczech (DE)."""
    resp = requests.get(f"{ENABLE_BANKING_API}/aspsps", params={"country": "DE"}, headers=_eb_headers(), timeout=15)
    resp.raise_for_status()
    for bank in resp.json().get("aspsps", []):
        if "mock" in bank.get("name", "").lower():
            return bank["name"]
    return "Mock ASPSP"


def start_german_sandbox_auth(account_key: str) -> str:
    """Rozpoczyna sesję logowania w niemieckim Mock ASPSP (DE)."""
    aspsp_name = get_german_sandbox_aspsp()
    valid_until = (datetime.utcnow() + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    state = f"{account_key}:{uuid.uuid4().hex[:8]}"

    body = {
        "access": {"valid_until": valid_until},
        "aspsp": {"name": aspsp_name, "country": "DE"},
        "state": state,
        "redirect_url": EB_REDIRECT_URI,
        "psu_type": "business",
    }

    resp = requests.post(f"{ENABLE_BANKING_API}/auth", json=body, headers=_eb_headers(), timeout=15)
    resp.raise_for_status()
    return resp.json()["url"]


def complete_bank_auth(code: str, account_key: str) -> Dict[str, Any]:
    """Wymienia kod autoryzacyjny z callbacku na aktywną sesję."""
    resp = requests.post(
        f"{ENABLE_BANKING_API}/sessions",
        json={"code": code},
        headers=_eb_headers(),
        timeout=15,
    )
    resp.raise_for_status()
    session_data = resp.json()
    BANK_SESSIONS[account_key.lower()] = session_data["session_id"]
    return session_data


def fetch_bank_financials(account_key: str) -> Tuple[float, List[Invoice], List[InvoiceFX], List[ScheduledTransaction]]:
    """
    Pobiera saldo (EUR) i transakcje z niemieckiego Mock ASPSP i mapuje je na schematy CFO Agenta.
    """
    session_id = BANK_SESSIONS.get(account_key.lower())
    if not session_id:
        return 0.0, [], [], []

    headers = _eb_headers()
    sess_resp = requests.get(f"{ENABLE_BANKING_API}/sessions/{session_id}", headers=headers, timeout=15)
    sess_resp.raise_for_status()
    accounts = sess_resp.json().get("accounts", [])

    if not accounts:
        return 0.0, [], [], []

    account_uid = accounts[0]["uid"]

    # 1. Saldo rachunku w EUR
    bal_resp = requests.get(f"{ENABLE_BANKING_API}/accounts/{account_uid}/balances", headers=headers, timeout=15)
    bal_resp.raise_for_status()
    balances = bal_resp.json().get("balances", [])
    cash_balance_eur = float(balances[0]["balance_amount"]["amount"]) if balances else 0.0

    # 2. Transakcje z ostatnich 60 dni
    date_from = (date.today() - timedelta(days=60)).isoformat()
    tx_resp = requests.get(
        f"{ENABLE_BANKING_API}/accounts/{account_uid}/transactions",
        params={"date_from": date_from},
        headers=headers,
        timeout=15,
    )
    tx_resp.raise_for_status()
    transactions = tx_resp.json().get("transactions", [])

    tax_invoices: List[Invoice] = []
    fx_invoices: List[InvoiceFX] = []
    scheduled_txs: List[ScheduledTransaction] = []
    today = date.today()

    for idx, tx in enumerate(transactions):
        raw_amt = float(tx["transaction_amount"]["amount"])
        curr = tx["transaction_amount"]["currency"].upper()
        direction = tx.get("credit_debit_indicator", "DBIT")  # CRDT = wpływ, DBIT = wydatek
        inv_type = "receivable" if direction == "CRDT" else "payable"

        counterparty = (
            tx.get("creditor", {}).get("name")
            if direction == "DBIT"
            else tx.get("debtor", {}).get("name")
        ) or f"German Counterparty {idx+1}"

        title = " ".join(tx.get("remittance_information", []))
        booking_str = tx.get("booking_date") or today.isoformat()
        booking_date = datetime.strptime(booking_str, "%Y-%m-%d").date()
        due_in_days = (booking_date - today).days

        is_rd = any(k in title.lower() for k in ["software", "cloud", "aws", "r&d", "dev", "it"])
        category = "R&D" if is_rd else "operations"
        net_amt = round(abs(raw_amt) / 1.19, 2) if curr == "EUR" else abs(raw_amt)

        if curr == "EUR":
            tax_invoices.append(
                Invoice(
                    id=tx.get("entry_reference") or f"DE-BANK-{idx+1:03d}",
                    contractor=counterparty,
                    amount=net_amt,
                    vat_rate=0.19,
                    currency="EUR",
                    due_in_days=due_in_days,
                    type=inv_type,
                    category=category,
                    is_paid=True,
                )
            )
        else:
            fx_invoices.append(
                InvoiceFX(
                    id=tx.get("entry_reference") or f"DE-FX-{idx+1:03d}",
                    contractor=counterparty,
                    amount=abs(raw_amt),
                    vat_rate=0.0,
                    currency=curr,
                    due_in_days=14,
                    type=inv_type,
                    is_paid=False,
                )
            )

        signed_amt = abs(raw_amt) if inv_type == "receivable" else -abs(raw_amt)
        scheduled_txs.append(
            ScheduledTransaction(
                due_date=booking_date,
                amount=signed_amt,
                category=category.upper(),
                counterparty=counterparty,
            )
        )

    return cash_balance_eur, tax_invoices, fx_invoices, scheduled_txs