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
from tools.liquidity_agent import (
    DISCRETIONARY_CATEGORIES,
    run_liquidity_agent,
    run_liquidity_tool,
)
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

# Memory for Human-in-the-Loop decisions (Liquidity & FX)
PENDING_LIQUIDITY_ACTIONS: Dict[str, ProposedCreditAction] = {}
PENDING_FX_CONTRACTS: Dict[str, Dict[str, Any]] = {}

CONFIRM_WORDS = {
    "yes", "yes please", "ok", "okay", "sure", "agree", "i agree",
    "i approve", "i confirm", "confirm", "approve", "tak",
    "zgadzam sie", "zgadzam się", "zatwierdzam",
}
REJECT_WORDS = {
    "no", "no thanks", "resign", "i resign", "cancel", "reject",
    "decline", "nie", "anuluj", "odrzucam",
}

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


def _parse_amount(raw: str) -> float:
    """Handles both English (12,000.50) and European (12 000,50) number formats."""
    cleaned = raw.strip().replace(" ", "")
    if "," in cleaned and "." in cleaned:
        cleaned = cleaned.replace(",", "")
    elif "," in cleaned:
        parts = cleaned.split(",")
        if len(parts[-1]) == 3 and len(parts) >= 2:
            cleaned = "".join(parts)
        else:
            cleaned = cleaned.replace(",", ".")
    return float(cleaned)


def parse_prompt_to_financials(prompt: str, file_snippet: str = "") -> Dict[str, Any]:
    """Deterministically extracts amounts, currencies, balances, and invoices from user text."""
    text = f"{prompt}\n{file_snippet}"
    result: Dict[str, Any] = {
        "has_custom_numbers": False,
        "base_currency": None,
        "cash_balance": None,
        "safety_buffer": None,
        "monthly_burn_rate": None,
        "forecast_days": None,
        "invoices": [],
    }

    base_match = re.search(
        r"(?:rozlicza\s+si[ęe]\s+w|base\s+currency\s+is|operate\s+in)\s+(PLN|EUR|USD|CHF|GBP)",
        text,
        re.IGNORECASE,
    )
    if base_match:
        result["base_currency"] = base_match.group(1).upper()

    bal_match = re.search(
        r"(?:mam\s+na\s+koncie|saldo|got[óo]wk[ia]|balance\s+is|have)\s*[^\d]{0,20}([\d][\d\s,.]*)\s*(PLN|EUR|USD|CHF|GBP)",
        text,
        re.IGNORECASE,
    )
    if bal_match:
        result["cash_balance"] = _parse_amount(bal_match.group(1))
        if not result["base_currency"]:
            result["base_currency"] = bal_match.group(2).upper()
        result["has_custom_numbers"] = True

    buf_match = re.search(
        r"(?:bufor|safety\s+buffer|buffer|cushion)[^\d]{0,20}([\d][\d\s,.]*)\s*(PLN|EUR|USD|CHF|GBP)",
        text,
        re.IGNORECASE,
    )
    if buf_match:
        result["safety_buffer"] = _parse_amount(buf_match.group(1))
        result["has_custom_numbers"] = True

    burn_match = re.search(
        r"(?:burn\s+rate|fixed\s+bills|monthly\s+expenses|koszty\s+sta[łl]e)[^\d]{0,20}([\d][\d\s,.]*)\s*(PLN|EUR|USD|CHF|GBP)",
        text,
        re.IGNORECASE,
    )
    if burn_match:
        result["monthly_burn_rate"] = _parse_amount(burn_match.group(1))
        result["has_custom_numbers"] = True

    days_match = re.search(
        r"(?:next|przez|w\s+ci[ąa]gu(?:\s+najbli[żz]szych)?)\s+(\d+)\s+(?:days|dni)",
        text,
        re.IGNORECASE,
    )
    if days_match:
        result["forecast_days"] = int(days_match.group(1))

    clauses = re.split(r"[.;\n]|(?:\s+oraz\s+)|(?:\s+and\s+)|(?:\s+a\s+za\s+)", text)
    for clause in clauses:
        if any(skip in clause.lower() for skip in [
            "na koncie", "in my account", "in account", "balance is", "i have",
            "bufor", "safety buffer", "buffer", "cushion",
            "burn rate", "fixed bills", "monthly expenses",
            "w ciągu najbliższych", "next 30 days", "in the next",
        ]):
            continue

        amt_match = re.search(r"([\d][\d\s,.]*)\s*(PLN|EUR|USD|CHF|GBP)", clause, re.IGNORECASE)
        if not amt_match:
            continue

        amount = _parse_amount(amt_match.group(1))
        currency = amt_match.group(2).upper()
        c_low = clause.lower()

        is_receivable = any(w in c_low for w in [
            "sprzedaż", "sprzedaz", "wystawiłem", "wystawilem", "klient",
            "wpływ", "należnoś", "sales", "client", "receivable", "owed to", "income",
        ])
        inv_type = "receivable" if is_receivable else "payable"

        due_days = 14
        overdue_match = re.search(r"(?:od|overdue\s+by|for)\s+(\d+)\s+(?:dni|days)", c_low)
        future_match = re.search(r"(?:za|in)\s+(\d+)\s+(?:dni|days)", c_low)
        if overdue_match:
            due_days = -int(overdue_match.group(1))
        elif future_match:
            due_days = int(future_match.group(1))

        vat_match = re.search(r"(\d+)\s*%\s*vat", c_low)
        vat_rate = (int(vat_match.group(1)) / 100.0) if vat_match else (0.19 if currency == "EUR" else 0.0)

        if any(w in c_low for w in ["r&d", "b+r", "oprogramowani", "software", "badani", "research"]):
            category = "R&D"
        elif any(w in c_low for w in ["marketing", "equipment", "sprzęt", "sprzet", "capex", "investment", "inwestycj", "optional"]):
            category = "marketing"
        else:
            category = "operations"

        result["invoices"].append({
            "contractor": clause.strip()[:45],
            "amount": amount,
            "vat_rate": vat_rate,
            "currency": currency,
            "due_in_days": due_days,
            "type": inv_type,
            "category": category,
            "is_paid": False,
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
        "liquidity": run_liquidity_tool,
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
    agents_to_run = route_agents_for_query(ctx)

    tool_outputs: List[ToolOutput] = []
    combined_prompt_context = []
    tax_result: ToolOutput | None = None

    if "tax" in agents_to_run or "liquidity" in agents_to_run:
        tax_result = run_tax_agent(ctx)
        if "tax" in agents_to_run:
            tool_outputs.append(tax_result)
            combined_prompt_context.append(tax_result.prompt_context)

    if "liquidity" in agents_to_run:
        def liquidity_llm_callback(prompt: str) -> str:
            return call_llm(
                system_prompt=(
                    "You are a helpful cash-flow assistant explaining a temporary money shortage to a non-financial business owner.\n"
                    f"{PLAIN_ENGLISH_CONSTRAINTS}"
                    "6. LENGTH: Write exactly 3 short, clear sentences explaining why the bank balance dips and how the recommended step keeps bills paid."
                ),
                user_prompt=prompt,
                max_tokens=300,
            )

        liq_result = run_liquidity_tool(
            ctx,
            llm_callback=liquidity_llm_callback,
            tax_output=tax_result,
        )
        tool_outputs.append(liq_result)
        combined_prompt_context.append(liq_result.prompt_context)

    currency = (getattr(ctx, "currency", None) or "EUR").upper()

    system_prompt = (
        "You are a friendly business money helper translating financial numbers into plain English for a non-expert owner.\n"
        f"{PLAIN_ENGLISH_CONSTRAINTS}"
        f"6. CURRENCY: Always express all monetary amounts strictly in {currency} (€). Never use PLN or any other currency.\n"
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
        f"Available Cash: {ctx.cash_balance_eur:,.2f} {currency} | "
        f"Monthly Fixed Bills: {ctx.monthly_burn_rate_eur:,.2f} {currency}\n"
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
        "currency": currency,
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
                    f"**Your exchange rate is now locked in with Commerzbank.**\n\n"
                    f"- **Confirmation Number:** `{ticket_id}`\n"
                    f"- **Currencies:** {q['pair']} ({q['direction']})\n"
                    f"- **Protected Amount:** {q['notional_amount_fc']:,.2f}\n"
                    f"- **Guaranteed Rate:** {q['guaranteed_forward_rate']} "
                    f"(exact total: {q['locked_value_base']:,.2f} {q['base_currency']})\n\n"
                    f"You are now protected against sudden exchange rate changes for this invoice."
                ),
                "deal_executed": deal_info,
                "chart": None,
            }

        if clean_prompt in REJECT_WORDS:
            del PENDING_FX_CONTRACTS[account_key]
            return {
                "reply": "The rate lock offer was canceled. Your upcoming foreign invoice stays at the open market exchange rate.",
                "deal_executed": None,
                "chart": None,
            }

    # 1B. Handle user confirmation ("yes" / "no") for a pending Liquidity action (Deferral or Credit Line)
    if account_key in PENDING_LIQUIDITY_ACTIONS:
        action = PENDING_LIQUIDITY_ACTIONS[account_key]

        if clean_prompt in CONFIRM_WORDS:
            del PENDING_LIQUIDITY_ACTIONS[account_key]
            action.status = "APPROVED_EXECUTED_SIMULATED"
            is_deferral = action.action_type == "DEFER_DISCRETIONARY_OUTFLOW"
            headline = (
                "**Your optional spending delay has been scheduled (Sandbox).**"
                if is_deferral
                else "**Your backup credit line has been approved (Sandbox).**"
            )
            return {
                "reply": (
                    f"{headline}\n\n"
                    f"- **Decision ID:** `{action.action_id}`\n"
                    f"- **Action:** {action.facility_name}\n"
                    f"- **Protected Amount:** {action.amount:,.2f} {action.currency}\n"
                    f"- **Estimated Monthly Cost:** {action.estimated_monthly_cost:,.2f} {action.currency}\n\n"
                    f"Your temporary cash shortage is now covered."
                ),
                "action": action.model_dump(),
                "chart": None,
            }

        if clean_prompt in REJECT_WORDS:
            del PENDING_LIQUIDITY_ACTIONS[account_key]
            action.status = "REJECTED"
            return {
                "reply": "The cash protection proposal was declined. Your payment schedule remains unchanged.",
                "action": action.model_dump(),
                "chart": None,
            }

    if clean_prompt in CONFIRM_WORDS or clean_prompt in REJECT_WORDS:
        return {
            "reply": "There is no active proposal waiting for confirmation right now. Ask a question about your cash flow, taxes, or foreign currency payments to get started.",
            "chart": None,
        }

    if clean_prompt not in CONFIRM_WORDS and clean_prompt not in REJECT_WORDS:
        PENDING_FX_CONTRACTS.pop(account_key, None)
        PENDING_LIQUIDITY_ACTIONS.pop(account_key, None)

    file_context = ""
    has_file = bool(file and file.filename)

    if has_file:
        raw_bytes = await file.read()
        snippet = raw_bytes[:2000].decode("utf-8", errors="ignore")
        file_context = f"\nAttached document ({file.filename}):\n{snippet}\n"

    extracted = parse_prompt_to_financials(prompt, file_context)
    has_custom = bool(extracted.get("has_custom_numbers")) or bool(extracted.get("invoices"))

    agent_low = agent.strip().lower()
    is_fx_query = (
        agent_low in {"fx", "fx_hedging", "hedging"}
        or (
            agent_low not in {"liquidity", "cashflow", "cash"}
            and any(w in clean_prompt for w in [
                "walut", "fx", "forward", "kurs", "chf", "usd", "gbp",
                "hedg", "currency", "exchange rate",
            ])
        )
    )

    is_liquidity_query = (
        agent_low in {"liquidity", "cashflow", "cash"}
        or any(w in clean_prompt for w in [
            "płynnoś", "plynnos", "gotówk", "cash", "bufor", "kredyt",
            "brak gotówki", "runway", "liquidity", "overdraft", "shortage", "buffer",
        ])
    )

    # 2. Trigger FX Hedging Agent
    if is_fx_query:
        base_curr = (extracted.get("base_currency") or "EUR").upper()
        raw_invs = extracted.get("invoices") or []
        fx_invoices = [
            InvoiceFX(
                id=f"INV-FX-{idx+1:02d}",
                contractor=inv.get("contractor") or f"Partner {idx+1}",
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

        if not fx_invoices and not has_custom and not has_file:
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
            cash_balance=float(extracted.get("cash_balance") if extracted.get("cash_balance") is not None else 342500.0),
            monthly_burn_rate=float(extracted.get("monthly_burn_rate") if extracted.get("monthly_burn_rate") is not None else 45000.0),
            user_query=prompt,
            invoices=fx_invoices,
        )
        fx_report = run_fx_hedging_agent(fx_ctx)

        if fx_report.recommendations:
            rec = fx_report.recommendations[0]
            PENDING_FX_CONTRACTS[account_key] = rec
            q = rec["quote_details"]

            system_prompt = (
                "You are the Currency Protection Helper inside FinancAI.lly powered by Commerzbank.\n"
                f"{PLAIN_ENGLISH_CONSTRAINTS}"
                "Explain all detected foreign currency invoices simply, and highlight the primary Commerzbank rate-lock offer using ONLY exact numbers from the JSON. "
                "Always end by asking the user clearly if they want to lock in the primary exchange rate right now (e.g. 'Would you like to lock in this exchange rate now? Please reply: yes or no')."
            )
            user_prompt = (
                f"Account: {account}\n"
                f"Currency Summary: {fx_report.prompt_context}\n"
                f"Recommended Rate-Lock Offers: {json.dumps(fx_report.recommendations, ensure_ascii=False)}\n"
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
                "chart": None,
            }
        return {
            "reply": (
                f"Currency Exposure Analysis ({base_curr})\n\n"
                f"{fx_report.prompt_context}\n\n"
                f"Would you like me to lock in a Commerzbank FX Forward rate for these foreign invoices? Please reply: yes or no."
            ),
            "fx_telemetry": fx_report.model_dump(),
            "chart": None,
        }

    # 3. Trigger Liquidity Agent (with discretionary spending priority + TaxAgent synergy + chart)
    if is_liquidity_query:
        today = date.today()
        curr = (extracted.get("base_currency") or "EUR").upper()
        balance = float(extracted.get("cash_balance") if extracted.get("cash_balance") is not None else 25000.0)
        buffer = float(extracted.get("safety_buffer") if extracted.get("safety_buffer") is not None else 10000.0)
        horizon = int(extracted.get("forecast_days") or 30)

        scheduled_txs: List[ScheduledTransaction] = []
        tax_invoices: List[Invoice] = []

        for idx, inv in enumerate(extracted.get("invoices") or []):
            if inv.get("is_paid", False):
                continue
            amt = float(inv.get("amount", 0))
            vat_rate = float(inv.get("vat_rate") if inv.get("vat_rate") is not None else 0.0)
            gross_amt = round(amt * (1.0 + vat_rate), 2)
            inv_type = inv.get("type") or "payable"
            signed_amt = -abs(gross_amt) if inv_type == "payable" else abs(gross_amt)
            due_days = max(1, int(inv.get("due_in_days") if inv.get("due_in_days") is not None else (idx + 1) * 5))
            raw_cat = (inv.get("category") or "operations").strip()
            is_disc = bool(
                inv.get("is_discretionary")
                or (inv_type == "payable" and raw_cat.lower() in DISCRETIONARY_CATEGORIES)
            )

            scheduled_txs.append(
                ScheduledTransaction(
                    due_date=today + timedelta(days=due_days),
                    counterparty=inv.get("contractor") or f"Partner {idx+1}",
                    category=raw_cat.upper(),
                    amount=signed_amt,
                    is_discretionary=is_disc,
                )
            )
            tax_invoices.append(
                Invoice(
                    id=f"FV/{idx+1:02d}",
                    contractor=inv.get("contractor") or f"Partner {idx+1}",
                    amount=amt,
                    vat_rate=vat_rate,
                    currency=curr,
                    due_in_days=due_days,
                    type=inv_type,
                    category=raw_cat,
                    is_paid=False,
                )
            )

        if not scheduled_txs and not has_custom and not has_file:
            scheduled_txs = [
                ScheduledTransaction(
                    due_date=today + timedelta(days=10),
                    counterparty="Equipment Supplier",
                    category="EQUIPMENT",
                    amount=-32000.0,
                    is_discretionary=True,
                ),
                ScheduledTransaction(
                    due_date=today + timedelta(days=15),
                    counterparty="Office Rent",
                    category="RENT",
                    amount=-4000.0,
                    is_discretionary=False,
                ),
            ]

        if tax_invoices:
            burn_for_tax = float(extracted.get("monthly_burn_rate") if extracted.get("monthly_burn_rate") is not None else 0.0)
            tax_preview = run_tax_agent(
                FinancialContext(
                    company_name=account,
                    currency=curr,
                    cash_balance_eur=balance,
                    monthly_burn_rate_eur=burn_for_tax,
                    invoices=tax_invoices,
                )
            )
            cit_due = float(tax_preview.metrics.get("cit_advance_to_pay_eur", 0.0))
            cit_days = max(1, int(tax_preview.metrics.get("days_to_cit_deadline", 15)))
            if cit_due > 0:
                scheduled_txs.append(
                    ScheduledTransaction(
                        due_date=today + timedelta(days=cit_days),
                        counterparty="Tax Office — Corporate Income Tax",
                        category="TAX",
                        amount=-round(cit_due, 2),
                        is_discretionary=False,
                    )
                )

            vat_due = float(tax_preview.metrics.get("vat_to_pay_eur", 0.0))
            vat_days = max(1, int(tax_preview.metrics.get("days_to_vat_deadline", 20)))
            if vat_due > 0:
                scheduled_txs.append(
                    ScheduledTransaction(
                        due_date=today + timedelta(days=vat_days),
                        counterparty="Tax Office — Sales Tax (VAT)",
                        category="TAX",
                        amount=-round(vat_due, 2),
                        is_discretionary=False,
                    )
                )

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
            return call_llm(
                f"You are a cash-flow helper explaining a temporary money dip simply.\n{PLAIN_ENGLISH_CONSTRAINTS}",
                p,
                max_tokens=250,
            )

        liq_resp = run_liquidity_agent(liq_req, liq_llm_cb)
        if liq_resp.proposed_action:
            PENDING_LIQUIDITY_ACTIONS[account_key] = liq_resp.proposed_action

        liq_dump = liq_resp.model_dump()
        raw_points = (
            liq_dump.get("daily_forecast")
            or liq_dump.get("forecast")
            or liq_dump.get("timeline")
            or []
        )

        chart_points = []
        if isinstance(raw_points, list) and raw_points:
            for i, p in enumerate(raw_points):
                if isinstance(p, dict):
                    label = str(p.get("date") or p.get("day") or f"Day {i}")
                    bal_val = p.get("projected_balance", p.get("balance", p.get("closing_balance", balance)))
                    try:
                        chart_points.append({"label": label, "balance": round(float(bal_val), 2)})
                    except (TypeError, ValueError):
                        pass

        if not chart_points:
            running = balance
            chart_points.append({"label": "Today", "balance": round(running, 2)})
            for tx in sorted(scheduled_txs, key=lambda t: t.due_date):
                running += float(tx.amount)
                chart_points.append({"label": tx.due_date.strftime("%m-%d"), "balance": round(running, 2)})

        liquidity_chart = {
            "type": "liquidity_line",
            "title": f"Cash Balance Forecast ({curr})",
            "currency": curr,
            "safety_buffer": round(buffer, 2),
            "points": chart_points,
        }

        system_prompt = (
            "You are the Cash-Flow Guardian inside FinancAI.lly running on Red Hat OpenShift AI.\n"
            f"{PLAIN_ENGLISH_CONSTRAINTS}"
            "Report ONLY the exact numbers calculated by the Liquidity tool below. Do not invent numbers. "
            "Explain clearly if delaying optional spending solves the cash gap for free, or if a backup credit line is needed. "
            "If proposed_action is present, end by asking: 'Would you like to approve this cash-protection plan in preview mode? Please reply: yes or no'."
        )
        user_prompt = (
            f"Liquidity Tool Result: {json.dumps(liq_dump, default=str, ensure_ascii=False)}\n"
            f"User question: {prompt}"
        )
        reply_text = call_llm(system_prompt, user_prompt, max_tokens=650)
        return {
            "reply": reply_text,
            "liquidity_telemetry": liq_dump,
            "pending_approval": bool(liq_resp.proposed_action),
            "chart": liquidity_chart,
        }

    # 4. Default: Tax Prep AI Agent
    is_lukas = "lukas" in account.lower()
    default_cash = 890000.0 if is_lukas else 342500.0
    cash_eur = float(extracted.get("cash_balance") if extracted.get("cash_balance") is not None else default_cash)

    parsed_tax_invoices = [
        Invoice(
            id=f"FV/{idx+1:02d}",
            contractor=inv.get("contractor") or f"Client {idx+1}",
            amount=float(inv.get("amount", 0)),
            vat_rate=float(inv.get("vat_rate") if inv.get("vat_rate") is not None else 0.19),
            currency="EUR",
            due_in_days=int(inv.get("due_in_days") if inv.get("due_in_days") is not None else 14),
            type=inv.get("type") or "payable",
            category=inv.get("category") or "operations",
            is_paid=bool(inv.get("is_paid", False)),
        )
        for idx, inv in enumerate(extracted.get("invoices") or [])
    ]

    if not parsed_tax_invoices and not has_custom and not has_file:
        parsed_tax_invoices = [
            Invoice(id="FV/01", contractor="Enterprise Client", amount=120000.0, vat_rate=0.19, due_in_days=10, type="receivable"),
            Invoice(id="FV/02", contractor="AI & Cloud R&D Lab", amount=40000.0, vat_rate=0.19, due_in_days=5, type="payable", category="R&D"),
        ]

    default_burn = 0.0 if (has_custom or has_file) else 45000.0
    burn_rate = float(extracted.get("monthly_burn_rate") if extracted.get("monthly_burn_rate") is not None else default_burn)

    demo_ctx = FinancialContext(
        company_name=account,
        currency="EUR",
        cash_balance_eur=cash_eur,
        monthly_burn_rate_eur=burn_rate,
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
        "chart": None,
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