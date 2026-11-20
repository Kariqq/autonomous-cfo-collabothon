import json
import os
import re
from typing import Any, Dict, List
import uuid
from datetime import datetime

import requests
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from schemas import FinancialContext, Invoice, ToolOutput
from tools.tax_agent import run_tax_agent
from tools.fx_hedging_agent import run_fx_hedging_agent
from schemas import FinancialContextFX, InvoiceFX

# Gdy koledzy z zespołu dodadzą swoje pliki do folderu tools/, odkomentujcie poniższe linie:
# from tools.liquidity_tool import run_liquidity_agent
# from tools.fx_hedging_tool import run_fx_agent
# from tools.investment_tool import run_investment_agent

app = FastAPI(title="Autonomous CFO Agent", version="2.0")

# CORS umożliwia bezproblemowe połączenie z frontendem (np. React / Next.js / Vue)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_default_url = "http://llama-32-3b-instruct-predictor.my-first-model.svc.cluster.local:8080/v1/chat/completions"

MODEL_URL = os.getenv("MODEL_URL", "").strip() or _default_url
MODEL_NAME = os.getenv("MODEL_NAME", "").strip() or "llama-32-3b-instruct"
MODEL_TOKEN = os.getenv("MODEL_TOKEN", "").strip()
PENDING_FX_CONTRACTS: Dict[str, Dict[str, Any]] = {}
CONFIRM_WORDS = {"tak", "yes", "ok", "okay", "zgadzam sie", "zgadzam się", "zatwierdzam", "potwierdzam", "confirm", "approve"}
REJECT_WORDS = {"nie", "no", "anuluj", "odrzucam", "rezygnuje", "rezygnuję", "cancel", "reject"}


# ==========================================
# 1. KOMUNIKACJA Z MODELEM LLM
# ==========================================

def call_llm(system_prompt: str, user_prompt: str, max_tokens: int = 650, temperature: float = 0.2) -> str:
    headers = {"Content-Type": "application/json"}
    if MODEL_TOKEN:
        headers["Authorization"] = f"Bearer {MODEL_TOKEN}"

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }

    try:
        resp = requests.post(MODEL_URL, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Błąd komunikacji z modelem LLM: {e}")


def extract_json_safe(text: str) -> Dict[str, Any]:
    """Bezpiecznie wyciąga obiekt JSON z odpowiedzi modelu Llama (odporne na markdown ```json)."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("Brak poprawnego JSON w odpowiedzi modelu.")
    return json.loads(match.group(0))


# ==========================================
# 2. REJESTR I ROUTER AGENTÓW (TOOLS)
# ==========================================

def get_active_agents():
    """Zwraca słownik aktywnych sub-agentów gotowych do użycia."""
    agents = {
        "tax": run_tax_agent,
        # Odkomentujcie w miarę postępu prac zespołu:
        # "liquidity": run_liquidity_agent,
        # "fx": run_fx_agent,
        # "investment": run_investment_agent,
    }
    return agents


def route_agents_for_query(ctx: FinancialContext) -> List[str]:
    """
    Decyduje, które narzędzia (sub-agenty) uruchomić na podstawie zapytania użytkownika.
    Jeśli brak konkretnego pytania -> uruchamia pełny audyt wszystkich dostępnych agentów.
    """
    active = get_active_agents()
    if not ctx.user_query:
        return list(active.keys())

    q = ctx.user_query.lower()
    selected = []

    if any(k in q for k in ["podat", "vat", "cit", "pit", "ulga", "b+r", "urząd", "skarbow", "tax", "optymalizac"]):
        selected.append("tax")
    if any(k in q for k in ["płynnoś", "gotówk", "cash", "kredyt", "faktury", "zaleg", "runway", "liquidity"]):
        selected.append("liquidity")
    if any(k in q for k in ["walut", "eur", "usd", "kurs", "fx", "hedg", "przewalut"]):
        selected.append("fx")
    if any(k in q for k in ["inwest", "lokat", "nadwyżk", "capex", "fundusz", "mmf", "deposit"]):
        selected.append("investment")

    valid_selected = [name for name in selected if name in active]
    return valid_selected if valid_selected else list(active.keys())


# ==========================================
# 3. ENDPOINTY REST API
# ==========================================

@app.get("/health")
def health():
    return {
        "status": "ok",
        "active_agents": list(get_active_agents().keys()),
        "model": MODEL_NAME,
        "model_url": MODEL_URL,
    }


@app.post("/cfo/tax")
def endpoint_tax_agent(ctx: FinancialContext):
    """Dedykowany endpoint wyłącznie dla Twojego Tax Agenta."""
    tax_result: ToolOutput = run_tax_agent(ctx)

    system_prompt = (
        "Jesteś autonomicznym dyrektorem finansowym (CFO) i doradcą podatkowym dla polskich MŚP. "
        "Odpowiadaj po polsku, konkretnie, na twardych liczbach z narzędzia. Nie zmyślaj kwot."
    )
    user_prompt = (
        f"Firma: {ctx.company_name}\n"
        f"Cel/pytanie: {ctx.user_query or 'Koordynacja zaliczek podatkowych i optymalizacja podatkowa.'}\n"
        f"Podsumowanie Tax Agenta: {tax_result.prompt_context}\n"
        f"Szczegółowe rekomendacje:\n{json.dumps(tax_result.recommendations, ensure_ascii=False, indent=2)}\n\n"
        "Przedstaw zarządowi zwięzły plan działania: ile i kiedy trzeba zapłacić do US oraz jak wdrożyć wykryte ulgi."
    )

    cfo_summary = call_llm(system_prompt, user_prompt)

    return {
        "company_name": ctx.company_name,
        "cfo_summary": cfo_summary,
        "agent_output": tax_result.model_dump(),
    }


@app.post("/cfo/analyze-fx")
def analyze_fx(ctx: FinancialContextFX):
    return run_fx_hedging_agent(ctx)


@app.post("/cfo/analyze")
def endpoint_autonomous_cfo(ctx: FinancialContext):
    """
    Główny endpoint Multi-Agent CFO:
    1. Wybiera odpowiednie narzędzia z folderu tools/
    2. Wykonuje deterministyczne obliczenia finansowe
    3. Syntetyzuje wyniki za pomocą LLM w spójny plan zarządczy CFO
    """
    active_agents = get_active_agents()
    agents_to_run = route_agents_for_query(ctx)

    tool_outputs: List[ToolOutput] = []
    combined_prompt_context = []

    for agent_key in agents_to_run:
        result: ToolOutput = active_agents[agent_key](ctx)
        tool_outputs.append(result)
        combined_prompt_context.append(result.prompt_context)

    system_prompt = (
        "Jesteś Autonomicznym Dyrektorem Finansowym (CFO) integrującym raporty od wyspecjalizowanych agentów "
        "(Liquidity, FX Hedging, Tax, Investment). "
        "Zwróć odpowiedź WYŁĄCZNIE jako poprawny obiekt JSON (bez tekstu przed ani po) o strukturze:\n"
        "{\n"
        '  "executive_summary": "3-4 zdania konkretnej diagnozy CFO po polsku z odwołaniem do dokładnych kwot.",\n'
        '  "top_priorities": [\n'
        "    {\n"
        '      "agent": "Nazwa agenta (np. TaxAgent)",\n'
        '      "priority": "HIGH | MEDIUM | LOW",\n'
        '      "action": "Konkretna decyzja lub akcja do zatwierdzenia przez zarząd",\n'
        '      "impact_pln": 1234.50\n'
        "    }\n"
        "  ]\n"
        "}"
    )


    all_recommendations = [
        {"agent": out.agent_name, "recs": out.recommendations} for out in tool_outputs
    ]

    user_prompt = (
        f"Firma: {ctx.company_name}\n"
        f"Stan gotówki: {ctx.cash_balance_pln} PLN | Miesięczny burn rate: {ctx.monthly_burn_rate_pln} PLN\n"
        f"Pytanie użytkownika: {ctx.user_query or 'Pełny przegląd CFO i plan optymalizacji.'}\n\n"
        f"Raporty agentów:\n" + "\n".join(combined_prompt_context) + "\n\n"
        f"Szczegóły techniczne:\n{json.dumps(all_recommendations, ensure_ascii=False, indent=2)}"
    )

    raw_response = call_llm(system_prompt, user_prompt, max_tokens=800)

    try:
        parsed = extract_json_safe(raw_response)
    except Exception:
        parsed = {
            "executive_summary": raw_response.strip(),
            "top_priorities": [],
        }

    return {
        "company_name": ctx.company_name,
        "agents_triggered": [out.agent_name for out in tool_outputs],
        "cfo_decision": parsed,
        "detailed_reports": [out.model_dump() for out in tool_outputs],
    }


# ==========================================
# 4. ENDPOINT DLA FRONTENDU (frontend/src/App.jsx)
# ==========================================

@app.post("/api/cfo/chat")
async def frontend_cfo_chat(
    prompt: str = Form(...),
    agent: str = Form("tax"),
    account: str = Form("SME Client"),
    file: UploadFile | None = File(None),
):
    """Endpoint dopasowany 1:1 do FormData z handleSend() w nowym frontend/src/App.jsx"""

    clean_prompt = prompt.strip().lower().rstrip(".!?")
    account_key = account.strip().lower()

    # Obsługa odpowiedzi "tak" lub "nie" na oczekującą ofertę Commerzbank FX Forward
    if account_key in PENDING_FX_CONTRACTS:
        pending_rec = PENDING_FX_CONTRACTS[account_key]

        if clean_prompt in CONFIRM_WORDS:
            del PENDING_FX_CONTRACTS[account_key]
            ticket_id = f"CB-FX-{uuid.uuid4().hex[:8].upper()}"
            q = pending_rec["quote_details"]
            deal_info = {
                "status": "EXECUTED_SIMULATED",
                "deal_ticket_id": ticket_id,
                "bank": "Commerzbank AG",
                "product_id": pending_rec["product_id"],
                "booked_at": datetime.utcnow().isoformat() + "Z",
                "quote_details": q,
            }
            return {
                "reply": (
                    f"**Umowa Commerzbank FX Forward została zawarta.**\n\n"
                    f"- **Numer transakcji:** `{ticket_id}`\n"
                    f"- **Para walutowa:** {q['pair']} ({q['direction']})\n"
                    f"- **Kwota zabezpieczenia:** {q['notional_amount_fc']:,.2f}\n"
                    f"- **Zablokowany kurs Forward:** {q['guaranteed_forward_rate']} "
                    f"(wartość: {q['locked_value_base']:,.2f} {q['base_currency']})\n\n"
                    f"Ryzyko walutowe dla tej ekspozycji zostało zneutralizowane."
                ),
                "deal_executed": deal_info,
            }

        if clean_prompt in REJECT_WORDS:
            del PENDING_FX_CONTRACTS[account_key]
            return {
                "reply": "Odrzucono propozycję zawarcia umowy Commerzbank FX Forward. Kurs pozostaje niezabezpieczony.",
                "deal_executed": None,
            }

    # Uruchomienie FX Hedging Agenta, gdy wybrano agent="fx" lub zapytanie dotyczy walut
    is_fx_query = (
        agent.lower() in {"fx", "fx_hedging", "hedging"}
        or any(w in clean_prompt for w in ["walut", "fx", "forward", "kurs", "chf", "usd", "hedg", "currency"])
    )

    if is_fx_query:
        fx_ctx = FinancialContextFX(
            company_name=account,
            base_currency="EUR",
            cash_balance=342500.0,
            monthly_burn_rate=45000.0,
            user_query=prompt,
            invoices=[
                InvoiceFX(
                    id="INV-FX-01",
                    contractor="Swiss Precision Supplier AG",
                    amount=12000.0,
                    vat_rate=0.0,
                    currency="CHF",
                    due_in_days=30,
                    type="payable",
                ),
                InvoiceFX(
                    id="INV-FX-02",
                    contractor="US Enterprise Client",
                    amount=4500.0,
                    vat_rate=0.0,
                    currency="USD",
                    due_in_days=45,
                    type="receivable",
                ),
            ],
        )
        fx_report = run_fx_hedging_agent(fx_ctx)

        if fx_report.recommendations:
            rec = fx_report.recommendations[0]
            PENDING_FX_CONTRACTS[account_key] = rec
            q = rec["quote_details"]

            system_prompt = (
                "You are the FX Hedging AI Agent inside FinancAI.lly powered by Commerzbank. "
                "Explain the detected currency exposure and the recommended Commerzbank FX Forward contract clearly and concisely. "
                "Do not use emojis. "
                "Reply in the exact same language as the user's question (Polish or English). "
                "Always end by asking the user explicitly if they want to conclude this contract (e.g. 'Czy chcesz zawrzeć tę umowę? Odpisz: tak / nie')."
            )
            user_prompt = (
                f"Account: {account}\n"
                f"FX Telemetry: {fx_report.prompt_context}\n"
                f"Recommended Contract: {json.dumps(rec, ensure_ascii=False)}\n"
                f"User message: {prompt}"
            )

            try:
                llm_reply = call_llm(system_prompt, user_prompt, max_tokens=450)
            except Exception:
                llm_reply = (
                    f"{rec['details']}\n\n"
                    f"**Proponowany produkt:** {rec['product_name']}\n"
                    f"**Gwarantowany kurs:** {q['guaranteed_forward_rate']} "
                    f"(kwota: {q['notional_amount_fc']:,.2f})\n\n"
                    f"**Czy chcesz zawrzeć tę umowę? (odpisz: tak / nie)**"
                )

            return {
                "reply": llm_reply,
                "fx_telemetry": fx_report.model_dump(),
                "pending_approval": True,
            }
    
    file_context = ""
    if file and file.filename:
        raw_bytes = await file.read()
        snippet = raw_bytes[:1500].decode("utf-8", errors="ignore")
        file_context = f"\nAttached document ({file.filename}):\n{snippet}\n"

    is_lukas = "lukas" in account.lower()
    cash_pln = 890000.0 if is_lukas else 342500.0

    demo_ctx = FinancialContext(
        company_name=account,
        cash_balance_pln=cash_pln,
        monthly_burn_rate_pln=45000.0,
        cit_rate=0.09,
        day_of_month=20,
        user_query=prompt,
        invoices=[
            Invoice(id="FV/01", contractor="Enterprise Client", amount=120000.0, vat_rate=0.23, due_in_days=10, type="receivable"),
            Invoice(id="FV/02", contractor="AI & Cloud R&D Lab", amount=40000.0, vat_rate=0.23, due_in_days=5, type="payable", category="R&D"),
        ],
    )
    tax_report = run_tax_agent(demo_ctx)

    system_prompt = (
        "You are the Tax Prep AI Agent inside FinancAI.lly running on Red Hat OpenShift AI. "
        "Provide clear, concise, plain-language tax and financial advice based on the account metrics and Tax Agent telemetry. "
        "Always reply in the exact same language as the user's question (English or Polish). "
        "Remind the user that actions remain in Sandbox mode until approved."
    )
    user_prompt = (
        f"Active Account: {account} | Liquidity: €{cash_pln:,.0f} | "
        f"Est. Q3 Tax Liability: {'-€94,200' if is_lukas else '-€38,400'} | "
        f"Identified Savings: {'+€26,800' if is_lukas else '+€14,500'}\n"
        f"Live Tax Agent telemetry: {tax_report.prompt_context}\n"
        f"Tax recommendations: {json.dumps(tax_report.recommendations, ensure_ascii=False)}"
        f"{file_context}\n"
        f"User question: {prompt}"
    )

    reply_text = call_llm(system_prompt, user_prompt, max_tokens=450)
    return {
        "reply": reply_text,
        "tax_telemetry": tax_report.model_dump(),
    }

