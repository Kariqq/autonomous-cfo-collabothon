import json
import os
import re
from typing import Any, Dict, List

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from schemas import FinancialContext, Invoice, ToolOutput
from tools.tax_agent import run_tax_agent

# Gdy koledzy z zespołu dodadzą swoje pliki do folderu tools/, odkomentujcie poniższe linie:
# from tools.liquidity_tool import run_liquidity_agent
# from tools.fx_hedging_tool import run_fx_agent
# from tools.investment_tool import run_investment_agent

app = FastAPI(title="Autonomous CFO Agent", version="2.0")

# CORS umożliwia bezproblemowe połączenie z frontendem React / Vite
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Konfiguracja modelu LLM działającego w klastrze OpenShift AI
_default_url = "http://llama-32-3b-instruct-predictor.my-first-model.svc.cluster.local:8080/v1/chat/completions"

MODEL_URL = os.getenv("MODEL_URL", "").strip() or _default_url
MODEL_NAME = os.getenv("MODEL_NAME", "").strip() or "llama-32-3b-instruct"
MODEL_TOKEN = os.getenv("MODEL_TOKEN", "").strip()


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
    return {
        "tax": run_tax_agent,
        # Odkomentujcie w miarę postępu prac zespołu:
        # "liquidity": run_liquidity_agent,
        # "fx": run_fx_agent,
        # "investment": run_investment_agent,
    }


def route_agents_for_query(ctx: FinancialContext) -> List[str]:
    """Wybiera sub-agenty na podstawie pytania użytkownika lub odpala wszystkie w trybie audytu."""
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


@app.post("/cfo/analyze")
def endpoint_autonomous_cfo(ctx: FinancialContext):
    """Główny endpoint Multi-Agent CFO łączący wszystkie aktywne agenty z folderu tools/."""
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

class ChatRequest(BaseModel):
    prompt: str


@app.post("/api/cfo/chat")
def frontend_cfo_chat(req: ChatRequest):
    """Endpoint dopasowany 1:1 do funkcji sendMessage() w frontend/src/App.jsx."""
    demo_ctx = FinancialContext(
        company_name="SME Client",
        cash_balance_pln=342500.0,
        monthly_burn_rate_pln=45000.0,
        cit_rate=0.09,
        day_of_month=20,
        user_query=req.prompt,
        invoices=[
            Invoice(id="FV/01", contractor="Enterprise Client", amount=120000.0, vat_rate=0.23, due_in_days=10, type="receivable"),
            Invoice(id="FV/02", contractor="AI & Cloud R&D Lab", amount=40000.0, vat_rate=0.23, due_in_days=5, type="payable", category="R&D"),
        ]
    )
    tax_report = run_tax_agent(demo_ctx)

    system_prompt = (
        "You are an Autonomous CFO Copilot for SMEs running on Red Hat OpenShift AI. "
        "Explain financial and tax decisions in plain, concise business language. "
        "Reply in the exact same language as the user's question (English or Polish). "
        "Remind the user that no transaction executes without their approval."
    )
    user_prompt = (
        f"Dashboard State: Available liquidity €342,500, Day 22 cash dip -€82,000, "
        f"FX exposure $240,000 USD, Idle cash €180,000.\n"
        f"Live Tax Agent telemetry: {tax_report.prompt_context}\n"
        f"Tax recommendations: {json.dumps(tax_report.recommendations, ensure_ascii=False)}\n\n"
        f"Owner question: {req.prompt}"
    )

    reply_text = call_llm(system_prompt, user_prompt, max_tokens=400)
    return {
        "reply": reply_text,
        "tax_telemetry": tax_report.model_dump()
    }