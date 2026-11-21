import json
import os
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List

import requests
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from schemas import (
    FinancialContext,
    FinancialContextFX,
    Invoice,
    InvoiceFX,
    LiquidityAnalysisRequest,
    ProposedCreditAction,
    ToolOutput,
)
from tools.fx_hedging_agent import run_fx_hedging_agent
from tools.liquidity_agent import run_liquidity_agent
from tools.tax_agent import run_tax_agent

app = FastAPI(title="Autonomous CFO Agent", version="2.0")

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

# Pamięć oczekujących decyzji Human-in-the-Loop (Liquidity & FX)
PENDING_LIQUIDITY_ACTIONS: Dict[str, ProposedCreditAction] = {}
PENDING_FX_CONTRACTS: Dict[str, Dict[str, Any]] = {}

CONFIRM_WORDS = {"tak", "yes", "ok", "okay", "zgadzam sie", "zgadzam się", "zatwierdzam", "potwierdzam", "confirm", "approve"}
REJECT_WORDS = {"nie", "no", "anuluj", "odrzucam", "rezygnuje", "rezygnuję", "cancel", "reject"}


# ==========================================
# 1. KOMUNIKACJA Z MODELEM LLM
# ==========================================

def call_llm(system_prompt: str, user_prompt: str, max_tokens: int = 750, temperature: float = 0.2) -> str:
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
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("Brak poprawnego JSON w odpowiedzi modelu.")
    return json.loads(match.group(0))


# ==========================================
# 2. REJESTR I ROUTER AGENTÓW (TOOLS)
# ==========================================

def get_active_agents():
    return {
        "tax": run_tax_agent,
    }


def route_agents_for_query(ctx: FinancialContext) -> List[str]:
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

    valid_selected = [name for name in selected if name in active]
    return valid_selected if valid_selected else list(active.keys())


# ==========================================
# 3. ENDPOINTY REST API (TAX, FX & CFO)
# ==========================================

@app.get("/health")
def health():
    return {
        "status": "ok",
        "active_agents": ["tax", "liquidity", "fx_hedging"],
        "model": MODEL_NAME,
        "model_url": MODEL_URL,
    }


@app.post("/cfo/tax")
def endpoint_tax_agent(ctx: FinancialContext):
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
# 4. ENDPOINTY LIQUIDITY AGENT (tools/liquidity_agent.py)
# ==========================================

@app.post("/tools/liquidity/analyze")
def endpoint_liquidity_analyze(req: LiquidityAnalysisRequest):
    """Analiza płynności dzień po dniu + Explainable AI z modelu Llama 3.2."""
    def liquidity_llm_callback(prompt: str) -> str:
        return call_llm(
            system_prompt=(
                "Jesteś doradcą płynności finansowej CFO. Uzasadnij zwięźle i konkretnie "
                "rekomendację finansowania na podstawie podanych liczb."
            ),
            user_prompt=prompt,
            max_tokens=300,
        )

    response = run_liquidity_agent(req, liquidity_llm_callback)

    if response.proposed_action:
        PENDING_LIQUIDITY_ACTIONS[response.proposed_action.action_id] = response.proposed_action

    return response


@app.post("/tools/liquidity/actions/{action_id}/decide")
def endpoint_liquidity_decide(action_id: str, approve: bool = True):
    """Zatwierdzenie lub odrzucenie rekomendacji kredytowej (Human-in-the-Loop)."""
    action = PENDING_LIQUIDITY_ACTIONS.get(action_id)
    if not action:
        raise HTTPException(status_code=404, detail=f"Nie znaleziono akcji o ID: {action_id}")

    if approve:
        action.status = "APPROVED_EXECUTED_SIMULATED"
        msg = f"Zatwierdzono w trybie Sandbox: {action.facility_name} na kwotę {action.amount:.2f} {action.currency}."
    else:
        action.status = "REJECTED"
        msg = f"Odrzucono propozycję: {action.facility_name}."

    return {
        "action_id": action.action_id,
        "status": action.status,
        "message": msg,
        "action": action.model_dump(),
    }


# ==========================================
# 5. ENDPOINT DLA FRONTENDU (frontend/src/App.jsx)
# ==========================================

@app.post("/api/cfo/chat")
async def frontend_cfo_chat(
    prompt: str = Form(...),
    agent: str = Form("tax"),
    account: str = Form("SME Client"),
    file: UploadFile | None = File(None),
):
    """Endpoint dopasowany 1:1 do FormData z handleSend() w frontend/src/App.jsx (obsługuje FX oraz Tax)."""
    clean_prompt = prompt.strip().lower().rstrip(".!?")
    account_key = account.strip().lower()

    # 1. Obsługa odpowiedzi "tak" lub "nie" na oczekującą ofertę Commerzbank FX Forward
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

    # 2. Uruchomienie FX Hedging Agenta, gdy wybrano agent="fx" lub zapytanie dotyczy walut
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
                llm_reply = call_llm(system_prompt, user_prompt, max_tokens=550)
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

    # 3. Domyślnie: Tax Prep AI Agent (z bezpieczną obsługą plików CSV/PDF bez halucynacji R&D)
    file_context = ""
    has_file = bool(file and file.filename)

    if has_file:
        raw_bytes = await file.read()
        snippet = raw_bytes[:2000].decode("utf-8", errors="ignore")
        file_context = f"\nAttached document ({file.filename}):\n{snippet}\n"

    is_lukas = "lukas" in account.lower()
    cash_pln = 890000.0 if is_lukas else 342500.0

    demo_invoices = [] if has_file else [
        Invoice(id="FV/01", contractor="Enterprise Client", amount=120000.0, vat_rate=0.23, due_in_days=10, type="receivable"),
        Invoice(id="FV/02", contractor="AI & Cloud R&D Lab", amount=40000.0, vat_rate=0.23, due_in_days=5, type="payable", category="R&D"),
    ]

    demo_ctx = FinancialContext(
        company_name=account,
        cash_balance_pln=cash_pln,
        monthly_burn_rate_pln=45000.0,
        cit_rate=0.09,
        day_of_month=20,
        user_query=prompt,
        invoices=demo_invoices,
    )
    tax_report = run_tax_agent(demo_ctx)

    system_prompt = (
        "You are the Tax Prep AI Agent inside FinancAI.lly running on Red Hat OpenShift AI. "
        "Analyze ONLY the actual transactions provided in the context. Never classify standard food/restaurant supplies as R&D (B+R). "
        "Reply strictly in ONE language — the exact language used in the user's question (English OR Polish, never mix both). "
        "Keep the response concise, complete, and remind the user that actions remain in Sandbox mode until approved."
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

    reply_text = call_llm(system_prompt, user_prompt, max_tokens=750)
    return {
        "reply": reply_text,
        "tax_telemetry": tax_report.model_dump(),
    }

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

if os.path.isdir(STATIC_DIR):
    assets_dir = os.path.join(STATIC_DIR, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = os.path.join(STATIC_DIR, full_path)
        if full_path and os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))