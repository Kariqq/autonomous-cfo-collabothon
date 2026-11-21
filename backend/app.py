import json
import os
import re
import uuid
from datetime import date, datetime, timedelta
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
    ScheduledTransaction,
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

# Memory for decisions Human-in-the-Loop (Liquidity & FX)
PENDING_LIQUIDITY_ACTIONS: Dict[str, ProposedCreditAction] = {}
PENDING_FX_CONTRACTS: Dict[str, Dict[str, Any]] = {}

CONFIRM_WORDS = {"yes", "yes please", "ok", "okay", "sure", "agree", "i agree", "i approve", "i confirm", "confirm", "approve", "tak", "zgadzam sie", "zgadzam się", "zatwierdzam"}
REJECT_WORDS = {"no", "no thanks", "resign", "i resign", "cancel", "reject", "decline", "nie", "anuluj", "odrzucam"}

# Strict guardrails tailored for Llama 3.2 3B + non-financial users
PLAIN_ENGLISH_CONSTRAINTS = (
    "MANDATORY RULES (FOLLOW STRICTLY):\n"
    "1. ENGLISH ONLY: Write your entire response in simple, natural English. Never use Polish words, even if input categories are in Polish.\n"
    "2. ZERO FINANCE JARGON: Talk to the user like a friendly helper explaining money to a shop owner with zero accounting or banking knowledge. "
    "NEVER use complex terms without replacing them:\n"
    "   - Instead of 'burn rate' -> say 'monthly fixed bills'\n"
    "   - Instead of 'liquidity shortfall' -> say 'temporary cash shortage'\n"
    "   - Instead of 'FX hedging / forward contract / notional / VaR' -> say 'locking in today's exchange rate so currency swings cannot cost you extra money'\n"
    "   - Instead of 'revolving overdraft facility' -> say 'backup credit line'\n"
    "   - Instead of 'receivables / payables' -> say 'money owed to you / bills you need to pay'\n"
    "3. STRICT FACTUALITY: Use ONLY the exact numbers, dates, and items given in the prompt or files. Never invent amounts, deadlines, or tax breaks.\n"
    "4. EASY TO SCAN: Keep sentences short. Use clean bullet points and bold key euro amounts and due dates.\n"
    "5. NO EMOJIS.\n"
)


# ==========================================
# 1. COMMUNICATION WITH THE LLM & PARSER
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
        raise HTTPException(status_code=502, detail=f"Trouble communicating with the LLM: {e}")


def extract_json_safe(text: str) -> Dict[str, Any]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("No valid JSON found in the model's response.")
    return json.loads(match.group(0))


def parse_prompt_to_financials(prompt: str, file_snippet: str = "") -> Dict[str, Any]:
    """Deterministically extracts amounts, currencies, balances, and invoices from user text."""
    text = f"{prompt}\n{file_snippet}"
    result: Dict[str, Any] = {
        "has_custom_numbers": False,
        "base_currency": None,
        "cash_balance": None,
        "safety_buffer": None,
        "forecast_days": None,
        "invoices": [],
    }

    base_match = re.search(r"(?:rozlicza\s+si[ęe]\s+w|base\s+currency\s+is|operate\s+in)\s+(PLN|EUR|USD|CHF|GBP)", text, re.IGNORECASE)
    if base_match:
        result["base_currency"] = base_match.group(1).upper()

    bal_match = re.search(r"(?:mam\s+na\s+koncie|saldo|got[óo]wk[ia]|balance\s+is|have)\s*[^\d]{0,20}([\d\s]+(?:[.,]\d+)?)\s*(PLN|EUR|USD|CHF|GBP)", text, re.IGNORECASE)
    if bal_match:
        result["cash_balance"] = float(bal_match.group(1).replace(" ", "").replace(",", "."))
        if not result["base_currency"]:
            result["base_currency"] = bal_match.group(2).upper()
        result["has_custom_numbers"] = True

    buf_match = re.search(r"(?:bufor|safety\s+buffer|buffer)[^\d]{0,20}([\d\s]+(?:[.,]\d+)?)\s*(PLN|EUR|USD|CHF|GBP)", text, re.IGNORECASE)
    if buf_match:
        result["safety_buffer"] = float(buf_match.group(1).replace(" ", "").replace(",", "."))
        result["has_custom_numbers"] = True

    clauses = re.split(r"[.;\n]|(?:\s+oraz\s+)|(?:\s+and\s+)|(?:\s+a\s+za\s+)", text)
    for clause in clauses:
        if any(skip in clause.lower() for skip in [
            "na koncie", "in my account", "in account", "balance is", "i have",
            "bufor", "safety buffer", "buffer",
            "w ciągu najbliższych", "next 30 days", "in the next",
        ]):
            continue

        amt_match = re.search(r"([\d][\d\s]*(?:[.,]\d+)?)\s*(PLN|EUR|USD|CHF|GBP)", clause, re.IGNORECASE)
        if not amt_match:
            continue

        amount = float(amt_match.group(1).replace(" ", "").replace(",", "."))
        currency = amt_match.group(2).upper()
        c_low = clause.lower()

        is_receivable = any(w in c_low for w in ["sprzedaż", "sprzedaz", "wystawiłem", "wystawilem", "klient", "wpływ", "należnoś", "sales", "client", "receivable", "owed to"])
        inv_type = "receivable" if is_receivable else "payable"

        due_days = 14
        overdue_match = re.search(r"(?:od|overdue\s+by|for)\s+(\d+)\s+(?:dni|days)", c_low)
        future_match = re.search(r"(?:za|in)\s+(\d+)\s+(?:dni|days)", c_low)
        if overdue_match:
            due_days = -int(overdue_match.group(1))
        elif future_match:
            due_days = int(future_match.group(1))

        vat_match = re.search(r"(\d+)\s*%\s*vat", c_low)
        vat_rate = (int(vat_match.group(1)) / 100.0) if vat_match else (0.23 if currency == "PLN" else 0.0)
        category = "R&D" if any(w in c_low for w in ["r&d", "b+r", "oprogramowani", "software", "badani", "research"]) else "operations"

        result["invoices"].append({
            "contractor": clause.strip()[:45],
            "amount": amount,
            "vat_rate": vat_rate,
            "currency": currency,
            "due_in_days": due_days,
            "type": inv_type,
            "category": category,
            "is_paid": due_days >= 0,
        })
        result["has_custom_numbers"] = True

    if not result["base_currency"] and result["invoices"]:
        result["base_currency"] = result["invoices"][0]["currency"]

    return result


# ==========================================
# 2. AGENT REGISTRY & ROUTER (TOOLS)
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

    if any(k in q for k in ["podat", "vat", "cit", "pit", "ulga", "b+r", "urząd", "skarbow", "tax", "optymalizac", "deduct", "saving"]):
        selected.append("tax")
    if any(k in q for k in ["płynnoś", "gotówk", "cash", "kredyt", "faktury", "zaleg", "runway", "liquidity", "loan", "shortage"]):
        selected.append("liquidity")
    if any(k in q for k in ["walut", "eur", "usd", "kurs", "fx", "hedg", "przewalut", "currency", "exchange"]):
        selected.append("fx")

    valid_selected = [name for name in selected if name in active]
    return valid_selected if valid_selected else list(active.keys())


# ==========================================
# 3. REST API ENDPOINTS (TAX, FX & CFO)
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
        "You are a friendly money assistant helping a business owner understand their taxes in plain, everyday English.\n"
        f"{PLAIN_ENGLISH_CONSTRAINTS}"
        "6. STRUCTURE: Divide your answer into two short parts:\n"
        "   - **What to pay & when**: exact tax amounts and due dates.\n"
        "   - **Ways to save money**: legal tax discounts found in their numbers and how to claim them."
    )
    user_prompt = (
        f"Company: {ctx.company_name}\n"
        f"Question: {ctx.user_query or 'Explain upcoming tax payments and possible tax savings simply.'}\n"
        f"Tax Summary: {tax_result.prompt_context}\n"
        f"Details:\n{json.dumps(tax_result.recommendations, ensure_ascii=False, indent=2)}\n\n"
        "Give a clear, beginner-friendly checklist."
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
    currency = "EUR"

    tool_outputs: List[ToolOutput] = []
    combined_prompt_context = []

    for agent_key in agents_to_run:
        result: ToolOutput = active_agents[agent_key](ctx)
        tool_outputs.append(result)
        combined_prompt_context.append(result.prompt_context)

    system_prompt = (
        "You are a friendly business money helper translating financial numbers into plain English for a non-expert owner.\n"
        f"{PLAIN_ENGLISH_CONSTRAINTS}"
        f"6. CURRENCY: Always express all monetary amounts strictly in {currency} (€). Never use any other currency.\n"
        "7. OUTPUT FORMAT: Return ONLY a valid JSON object (no markdown code blocks, no text before or after) with this exact structure:\n"
        "{\n"
        '  "executive_summary": "<3-4 simple, jargon-free sentences explaining the cash situation using ONLY exact numbers from the reports>",\n'
        '  "top_priorities": [\n'
        "    {\n"
        '      "agent": "<exact agent_name from the report>",\n'
        '      "priority": "<HIGH | MEDIUM | LOW>",\n'
        '      "action": "<plain-English explanation of what to do and why>",\n'
        '      "impact_eur": <exact numeric amount in EUR from the report, or 0.0 if none>\n'
        "    }\n"
        "  ]\n"
        "}\n"
        "8. NO PLACEHOLDER COPYING: Never invent numbers. Every number in executive_summary and impact_eur must come directly from the Agent Reports below."
    )

    all_recommendations = [
        {"agent": out.agent_name, "recs": out.recommendations} for out in tool_outputs
    ]

    user_prompt = (
        f"Company: {ctx.company_name}\n"
        f"Available Cash: {ctx.cash_balance_pln:,.2f} {currency} | "
        f"Monthly Fixed Bills: {ctx.monthly_burn_rate_pln:,.2f} {currency}\n"
        f"User Question: {ctx.user_query or 'Full money checkup and simple savings plan.'}\n\n"
        f"Agent Reports:\n" + "\n".join(combined_prompt_context) + "\n\n"
        f"Detailed Numbers:\n{json.dumps(all_recommendations, ensure_ascii=False, indent=2)}"
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
# 4. LIQUIDITY AGENT ENDPOINTS (tools/liquidity_agent.py)
# ==========================================

@app.post("/tools/liquidity/analyze")
def endpoint_liquidity_analyze(req: LiquidityAnalysisRequest):
    """Day-by-day cash flow forecast + plain-English explanation from Llama 3.2."""
    def liquidity_llm_callback(prompt: str) -> str:
        return call_llm(
            system_prompt=(
                "You are a helpful cash-flow assistant explaining a temporary money shortage to a non-financial business owner.\n"
                f"{PLAIN_ENGLISH_CONSTRAINTS}"
                "6. LENGTH: Write exactly 3 short, clear sentences explaining why the bank balance dips and how a backup credit line keeps bills paid."
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
    """Approve or reject the credit line recommendation (Human-in-the-Loop)."""
    action = PENDING_LIQUIDITY_ACTIONS.get(action_id)
    if not action:
        raise HTTPException(status_code=404, detail=f"Action ID not found: {action_id}")

    if approve:
        action.status = "APPROVED_EXECUTED_SIMULATED"
        msg = f"Approved in Sandbox mode: {action.facility_name} for {action.amount:.2f} {action.currency}."
    else:
        action.status = "REJECTED"
        msg = f"Declined proposal: {action.facility_name}."

    return {
        "action_id": action.action_id,
        "status": action.status,
        "message": msg,
        "action": action.model_dump(),
    }


# ==========================================
# 5. FRONTEND ENDPOINTS (frontend/src/App.jsx)
# ==========================================

@app.post("/api/cfo/chat")
async def frontend_cfo_chat(
    prompt: str = Form(...),
    agent: str = Form("tax"),
    account: str = Form("SME Client"),
    file: UploadFile | None = File(None),
):
    """Endpoint matched 1:1 to FormData in handleSend() in frontend/src/App.jsx (supports FX, Liquidity & Tax)."""
    clean_prompt = prompt.strip().lower().rstrip(".!?")
    account_key = account.strip().lower()

    # 1A. Handle user confirmation ("yes" / "no") for a pending Commerzbank FX rate lock
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
                    f"**Your exchange rate is now locked in with Commerzbank FX Forward.**\n\n"
                    f"- **Confirmation Number:** `{ticket_id}`\n"
                    f"- **Currencies:** {q['pair']} ({q['direction']})\n"
                    f"- **Protected Amount:** {q['notional_amount_fc']:,.2f}\n"
                    f"- **Guaranteed Rate:** {q['guaranteed_forward_rate']} "
                    f"(exact total: {q['locked_value_base']:,.2f} {q['base_currency']})\n\n"
                    f"You are now protected against sudden exchange rate changes for this invoice."
                ),
                "deal_executed": deal_info,
            }

        if clean_prompt in REJECT_WORDS:
            del PENDING_FX_CONTRACTS[account_key]
            return {
                "reply": "The rate lock offer was canceled. Your upcoming foreign invoice stays at the open market exchange rate.",
                "deal_executed": None,
            }

    # 1B. Handle user confirmation ("yes" / "no") for a pending Liquidity backup credit line
    if account_key in PENDING_LIQUIDITY_ACTIONS:
        action = PENDING_LIQUIDITY_ACTIONS[account_key]

        if clean_prompt in CONFIRM_WORDS:
            del PENDING_LIQUIDITY_ACTIONS[account_key]
            action.status = "APPROVED_EXECUTED_SIMULATED"
            return {
                "reply": (
                    f"**Your backup credit line has been approved (Sandbox).**\n\n"
                    f"- **Decision ID:** `{action.action_id}`\n"
                    f"- **Facility:** {action.facility_name}\n"
                    f"- **Approved Limit:** {action.amount:,.2f} {action.currency}\n"
                    f"- **Estimated Monthly Cost:** {action.estimated_monthly_cost:,.2f} {action.currency}\n\n"
                    f"Your temporary cash shortage is now covered."
                ),
                "action": action.model_dump(),
            }

        if clean_prompt in REJECT_WORDS:
            del PENDING_LIQUIDITY_ACTIONS[account_key]
            action.status = "REJECTED"
            return {
                "reply": "The backup credit line offer was declined.",
                "action": action.model_dump(),
            }

    # Read optional uploaded file
    file_context = ""
    has_file = bool(file and file.filename)

    if has_file:
        raw_bytes = await file.read()
        snippet = raw_bytes[:2000].decode("utf-8", errors="ignore")
        file_context = f"\nAttached document ({file.filename}):\n{snippet}\n"

    # Extract custom amounts/invoices from user prompt
    extracted = parse_prompt_to_financials(prompt, file_context)
    has_custom = bool(extracted.get("has_custom_numbers")) or bool(extracted.get("invoices"))

    # 2. Trigger FX Hedging Agent when agent="fx" or the question is about foreign currencies
    is_fx_query = (
        agent.lower() in {"fx", "fx_hedging", "hedging"}
        or any(w in clean_prompt for w in ["walut", "fx", "forward", "kurs", "chf", "usd", "gbp", "hedg", "currency", "exchange", "rate"])
    )

    is_liquidity_query = (
        agent.lower() in {"liquidity", "cashflow"}
        or any(w in clean_prompt for w in ["płynnoś", "plynnos", "bufor", "kredyt", "brak gotówki", "runway", "liquidity", "overdraft", "shortage", "buffer"])
    )

    if is_fx_query:
        base_curr = extracted.get("base_currency") or "EUR"
        raw_invs = extracted.get("invoices") or []
        fx_invoices = [
            InvoiceFX(
                id=f"INV-FX-{idx+1:02d}",
                contractor=inv.get("contractor") or f"Supplier {idx+1}",
                amount=float(inv.get("amount", 0)),
                vat_rate=float(inv.get("vat_rate") or 0.0),
                currency=(inv.get("currency") or "CHF").upper(),
                due_in_days=int(inv.get("due_in_days") or 30),
                type=inv.get("type") or "payable",
                is_paid=bool(inv.get("is_paid", False)),
            )
            for idx, inv in enumerate(raw_invs)
            if (inv.get("currency") or "").upper() not in {"", base_curr}
        ]

        if not fx_invoices and not has_custom:
            fx_invoices = [
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
            ]

        fx_ctx = FinancialContextFX(
            company_name=account,
            base_currency=base_curr,
            cash_balance=float(extracted.get("cash_balance") or 342500.0),
            monthly_burn_rate=45000.0,
            user_query=prompt,
            invoices=fx_invoices,
        )
        fx_report = run_fx_hedging_agent(fx_ctx)

        if fx_report.recommendations:
            rec = fx_report.recommendations[0]
            PENDING_FX_CONTRACTS[account_key] = rec
            q = rec["quote_details"]

            system_prompt = (
                "You are the FX Hedging AI Agent inside FinancAI.lly powered by Commerzbank.\n"
                f"{PLAIN_ENGLISH_CONSTRAINTS}"
                "Explain ALL detected currency exposures and recommended Commerzbank rate-lock options using ONLY the exact numbers from the JSON. "
                "Always end by asking the user explicitly if they want to lock in this exchange rate (e.g. 'Would you like to lock in this exchange rate now? Please reply: yes or no')."
            )
            user_prompt = (
                f"Account: {account}\n"
                f"FX Telemetry: {fx_report.prompt_context}\n"
                f"Recommended Contracts: {json.dumps(fx_report.recommendations, ensure_ascii=False)}\n"
                f"User message: {prompt}"
            )

            try:
                llm_reply = call_llm(system_prompt, user_prompt, max_tokens=650)
            except Exception:
                llm_reply = (
                    f"{rec['details']}\n\n"
                    f"**Recommended Option:** {rec['product_name']}\n"
                    f"**Guaranteed Rate:** {q['guaranteed_forward_rate']} "
                    f"(for {q['notional_amount_fc']:,.2f})\n\n"
                    f"**Would you like to lock in this exchange rate now? (reply: yes / no)**"
                )

            return {
                "reply": llm_reply,
                "fx_telemetry": fx_report.model_dump(),
                "pending_approval": True,
            }

    # 3. Trigger Liquidity Agent
    if is_liquidity_query:
        today = date.today()
        curr = extracted.get("base_currency") or "EUR"
        balance = float(extracted.get("cash_balance") if extracted.get("cash_balance") is not None else 25000.0)
        buffer = float(extracted.get("safety_buffer") if extracted.get("safety_buffer") is not None else 10000.0)
        horizon = int(extracted.get("forecast_days") or 30)

        scheduled_txs = []
        for idx, inv in enumerate(extracted.get("invoices") or []):
            amt = float(inv.get("amount", 0))
            signed_amt = -abs(amt) if inv.get("type", "payable") == "payable" else abs(amt)
            due_days = max(1, int(inv.get("due_in_days") or (idx + 1) * 5))
            scheduled_txs.append(
                ScheduledTransaction(
                    id=f"TX-{idx+1:02d}",
                    due_date=today + timedelta(days=due_days),
                    counterparty=inv.get("contractor") or f"Vendor {idx+1}",
                    amount=signed_amt,
                    category=inv.get("category") or "operations",
                )
            )

        if not scheduled_txs and not has_custom:
            scheduled_txs = [
                ScheduledTransaction(id="TX-01", due_date=today + timedelta(days=10), counterparty="Equipment Supplier", amount=-32000.0, category="equipment"),
                ScheduledTransaction(id="TX-02", due_date=today + timedelta(days=15), counterparty="Office Rent", amount=-4000.0, category="rent"),
            ]

        liq_req = LiquidityAnalysisRequest(
            company_name=account,
            as_of_date=today,
            currency=curr,
            current_balance=balance,
            safety_buffer=buffer,
            forecast_days=horizon,
            scheduled_transactions=scheduled_txs,
        )

        def liq_llm_cb(p: str) -> str:
            return call_llm(f"Explain the cash shortage simply.\n{PLAIN_ENGLISH_CONSTRAINTS}", p, max_tokens=250)

        liq_resp = run_liquidity_agent(liq_req, liq_llm_cb)
        if liq_resp.proposed_action:
            PENDING_LIQUIDITY_ACTIONS[account_key] = liq_resp.proposed_action

        system_prompt = (
            "You are the Liquidity Helper inside FinancAI.lly running on Red Hat OpenShift AI.\n"
            f"{PLAIN_ENGLISH_CONSTRAINTS}"
            "Report ONLY the exact numbers calculated by the Liquidity tool below. Do not invent numbers. "
            "If proposed_action is present, end by asking: 'Would you like to activate this backup credit line in preview mode? Please reply: yes or no'."
        )
        user_prompt = (
            f"Liquidity Tool Result: {json.dumps(liq_resp.model_dump(), default=str, ensure_ascii=False)}\n"
            f"User question: {prompt}"
        )
        reply_text = call_llm(system_prompt, user_prompt, max_tokens=650)
        return {
            "reply": reply_text,
            "liquidity_telemetry": liq_resp.model_dump(),
            "pending_approval": bool(liq_resp.proposed_action),
        }

    # 4. Default: Tax Prep AI Agent
    is_lukas = "lukas" in account.lower()
    cash_pln = float(extracted.get("cash_balance") or (890000.0 if is_lukas else 342500.0))

    parsed_tax_invoices = [
        Invoice(
            id=f"FV/{idx+1:02d}",
            contractor=inv.get("contractor") or f"Client {idx+1}",
            amount=float(inv.get("amount", 0)),
            vat_rate=float(inv.get("vat_rate") if inv.get("vat_rate") is not None else 0.23),
            currency="PLN",
            due_in_days=int(inv.get("due_in_days") if inv.get("due_in_days") is not None else 14),
            type=inv.get("type") or "payable",
            category=inv.get("category") or "operations",
            is_paid=bool(inv.get("is_paid", inv.get("due_in_days", 1) >= 0)),
        )
        for idx, inv in enumerate(extracted.get("invoices") or [])
    ]

    if not parsed_tax_invoices and not has_custom and not has_file:
        parsed_tax_invoices = [
            Invoice(id="FV/01", contractor="Enterprise Client", amount=120000.0, vat_rate=0.23, due_in_days=10, type="receivable"),
            Invoice(id="FV/02", contractor="AI & Cloud R&D Lab", amount=40000.0, vat_rate=0.23, due_in_days=5, type="payable", category="R&D"),
        ]

    burn_rate = 0.0 if has_custom else 45000.0
    demo_ctx = FinancialContext(
        company_name=account,
        cash_balance_pln=cash_pln,
        monthly_burn_rate_pln=burn_rate,
        cit_rate=0.09,
        day_of_month=20,
        user_query=prompt,
        invoices=parsed_tax_invoices,
    )
    tax_report = run_tax_agent(demo_ctx)

    system_prompt = (
        "You are the friendly Tax Helper inside FinancAI.lly running on Red Hat OpenShift AI.\n"
        f"{PLAIN_ENGLISH_CONSTRAINTS}"
        "6. STRICT DATA BOUNDARY: Look ONLY at the actual invoices/transactions provided in the context or attached file. "
        "Never label everyday purchases (like food, restaurants, groceries, or office supplies) as Research & Development (R&D) tax discounts.\n"
        "7. SANDBOX REMINDER: Always end with one short, reassuring sentence letting the user know that nothing has been filed or paid yet — everything stays in safe preview (Sandbox) mode until they approve."
    )
    user_prompt = (
        f"Active Account: {account}\n"
        f"Tax Tool Metrics: {json.dumps(tax_report.metrics, ensure_ascii=False)}\n"
        f"Tax Tool Recommendations: {json.dumps(tax_report.recommendations, ensure_ascii=False)}"
        f"{file_context}\n"
        f"User question: {prompt}"
    )

    reply_text = call_llm(system_prompt, user_prompt, max_tokens=750)
    return {
        "reply": reply_text,
        "tax_telemetry": tax_report.model_dump(),
    }


# ==========================================
# 6. SERVE BUILT FRONTEND (SPA)
# ==========================================

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