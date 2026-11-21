import os
import sys
import uuid
from datetime import date, timedelta
from typing import Callable, Dict, List, Optional, Tuple

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from schemas import (
    AutonomyGovernance,
    FinancialContext,
    LiquidityAgentResponse,
    LiquidityAnalysisRequest,
    ProposedCreditAction,
    ScheduledTransaction,
    ToolOutput,
)

# Configurable parameters (no magic numbers buried in logic)
DEFAULT_FORECAST_DAYS = 45
MIN_SAFETY_BUFFER_EUR = 5000.0
BUFFER_MONTHS_COVERAGE = 0.50
CREDIT_STEP_EUR = 5000.0
ESTIMATED_ANNUAL_CREDIT_RATE = 0.085
SIGNIFICANT_OUTFLOW_THRESHOLD_EUR = -1000.0
DISCRETIONARY_CATEGORIES = {
    "marketing",
    "capex",
    "investment",
    "equipment",
    "inwestycje",
    "discretionary",
}


def simulate_cashflow_ladder(req: LiquidityAnalysisRequest) -> dict:
    """Day-by-day bank balance simulation for the next X days."""
    balance = req.current_balance
    min_balance = balance
    min_balance_date = req.as_of_date
    first_breach_date = None
    risk_drivers: List[str] = []

    for day_offset in range(1, req.forecast_days + 1):
        sim_date = req.as_of_date + timedelta(days=day_offset)
        todays_txs = [t for t in req.scheduled_transactions if t.due_date == sim_date]

        daily_net = sum(t.amount for t in todays_txs)
        balance = round(balance + daily_net, 2)

        for t in todays_txs:
            if t.amount <= SIGNIFICANT_OUTFLOW_THRESHOLD_EUR:
                risk_drivers.append(
                    f"{sim_date}: {t.counterparty} ({t.amount:,.2f} {req.currency})"
                )

        if balance < min_balance:
            min_balance = balance
            min_balance_date = sim_date

        if balance < req.safety_buffer and first_breach_date is None:
            first_breach_date = sim_date

    shortfall = round(max(0.0, req.safety_buffer - min_balance), 2)

    return {
        "ending_balance": balance,
        "min_balance": min_balance,
        "min_balance_date": min_balance_date,
        "first_breach_date": first_breach_date,
        "shortfall": shortfall,
        "risk_drivers": risk_drivers[:6],
    }


def evaluate_liquidity_action(
    req: LiquidityAnalysisRequest, sim_result: dict
) -> Tuple[Optional[ProposedCreditAction], str]:
    """
    Step 1: Check if delaying optional (discretionary) spending solves the cash gap at €0 cost.
    Step 2: Only if a gap still remains, propose a right-sized backup credit line.
    Never executes any bank transfer without explicit user approval.
    """
    shortfall = sim_result["shortfall"]
    if shortfall <= 0:
        return None, ""

    horizon_end = req.as_of_date + timedelta(days=req.forecast_days)
    discretionary = [
        t for t in req.scheduled_transactions
        if req.as_of_date < t.due_date <= horizon_end
        and t.is_discretionary
        and t.amount < 0
    ]
    total_disc = round(abs(sum(t.amount for t in discretionary)), 2)
    disc_names = ", ".join(dict.fromkeys(t.counterparty for t in discretionary))

    # CASE 1: Delaying optional spending completely eliminates the cash shortage (€0 interest)
    if total_disc >= shortfall and discretionary:
        llm_prompt = (
            f"Company: {req.company_name}. Today's date: {req.as_of_date}. "
            f"Current bank balance: {req.current_balance:,.2f} {req.currency}. "
            f"Lowest projected balance: {sim_result['min_balance']:,.2f} {req.currency} on {sim_result['min_balance_date']} "
            f"(which is {shortfall:,.2f} {req.currency} below the {req.safety_buffer:,.2f} {req.currency} safety cushion). "
            f"Optional/flexible bills found: {disc_names} totaling {total_disc:,.2f} {req.currency}. "
            f"In 3 short, jargon-free sentences, explain why simply delaying those optional payments by a few weeks "
            f"keeps the business safe without needing any bank loan."
        )
        action = ProposedCreditAction(
            action_id=str(uuid.uuid4())[:8],
            status="PENDING_APPROVAL",
            execution_mode="SIMULATED",
            requires_user_approval=True,
            action_type="DEFER_DISCRETIONARY_OUTFLOW",
            facility_name=f"Delay Optional Spending ({disc_names})",
            amount=shortfall,
            currency=req.currency,
            estimated_monthly_cost=0.0,
            explainable_reasoning="",
        )
        return action, llm_prompt

    # CASE 2: Delaying optional spending shrinks the gap, and a smaller backup credit line covers the rest
    remaining_shortfall = round(max(0.0, shortfall - total_disc), 2)
    recommended_limit = float(((int(remaining_shortfall) // int(CREDIT_STEP_EUR)) + 1) * int(CREDIT_STEP_EUR))
    est_monthly_interest = round(recommended_limit * ESTIMATED_ANNUAL_CREDIT_RATE / 12, 2)

    if total_disc > 0:
        facility_label = f"Delay {disc_names} ({total_disc:,.2f} {req.currency}) + Backup Credit Line"
        disc_note = (
            f" First, delaying optional spending ({disc_names}) saves {total_disc:,.2f} {req.currency}. "
            f"To cover the remaining {remaining_shortfall:,.2f} {req.currency} gap, recommend a backup credit line "
            f"of {recommended_limit:,.2f} {req.currency} (estimated cost ~{est_monthly_interest:,.2f} {req.currency}/month if used)."
        )
    else:
        facility_label = "Backup Overdraft Credit Line"
        disc_note = (
            f" Recommend opening a backup credit line of {recommended_limit:,.2f} {req.currency} "
            f"(estimated cost ~{est_monthly_interest:,.2f} {req.currency}/month if used) so all bills get paid on time."
        )

    llm_prompt = (
        f"Company: {req.company_name}. Today's date: {req.as_of_date}. "
        f"Starting bank balance: {req.current_balance:,.2f} {req.currency}. "
        f"Lowest projected balance: {sim_result['min_balance']:,.2f} {req.currency} on {sim_result['min_balance_date']}. "
        f"Biggest upcoming bills: {', '.join(sim_result['risk_drivers'])}.{disc_note} "
        f"Explain this plan in 3 short, plain-English sentences for a business owner with zero finance background."
    )

    action = ProposedCreditAction(
        action_id=str(uuid.uuid4())[:8],
        status="PENDING_APPROVAL",
        execution_mode="SIMULATED",
        requires_user_approval=True,
        action_type="CREDIT_FACILITY",
        facility_name=facility_label,
        amount=recommended_limit,
        currency=req.currency,
        estimated_monthly_cost=est_monthly_interest,
        explainable_reasoning="",
    )
    return action, llm_prompt


def run_liquidity_agent(
    req: LiquidityAnalysisRequest, llm_callback: Optional[Callable[[str], str]] = None
) -> LiquidityAgentResponse:
    """Core day-by-day liquidity simulation and action planner."""
    sim = simulate_cashflow_ladder(req)
    action, prompt = evaluate_liquidity_action(req, sim)

    if action and prompt:
        if llm_callback:
            action.explainable_reasoning = llm_callback(prompt)
        else:
            action.explainable_reasoning = (
                f"Your cash cushion dips below {req.safety_buffer:,.2f} {req.currency} on {sim['min_balance_date']}. "
                f"Taking this action ({action.facility_name}) covers the {sim['shortfall']:,.2f} {req.currency} gap safely."
            )

    if action and action.action_type == "DEFER_DISCRETIONARY_OUTFLOW":
        rec_text = f"Delay optional spending of {action.amount:,.2f} {req.currency} (saves bank interest)"
        approval_steps = ["Confirm delaying optional payments until after customer invoices arrive"]
    elif action:
        rec_text = f"Set up a backup credit line of {action.amount:,.2f} {req.currency}"
        approval_steps = [
            "Approve activating the backup credit line with your bank",
            "Confirm delaying any optional transfers if included",
        ]
    else:
        rec_text = "No extra borrowing or payment delays needed — your cash cushion looks healthy"
        approval_steps = []

    governance = AutonomyGovernance(
        independent_analysis=[
            f"Day-by-day bank balance forecast for the next {req.forecast_days} days",
            "Checked when your safety cushion dips and identified the biggest upcoming bills",
        ],
        agent_recommendations=[rec_text],
        requires_user_approval=approval_steps,
        execution_status="SIMULATED_SANDBOX (Preview only — no real money moved or borrowed)",
    )

    return LiquidityAgentResponse(
        company_name=req.company_name,
        as_of_date=req.as_of_date,
        forecast_horizon_days=req.forecast_days,
        starting_balance=req.current_balance,
        min_projected_balance=sim["min_balance"],
        min_balance_date=sim["min_balance_date"],
        first_buffer_breach_date=sim["first_breach_date"],
        liquidity_shortfall=sim["shortfall"],
        key_risk_drivers=sim["risk_drivers"],
        governance=governance,
        proposed_action=action,
    )


def build_liquidity_request_from_context(
    ctx: FinancialContext,
    tax_output: Optional[ToolOutput] = None,
    as_of: Optional[date] = None,
) -> LiquidityAnalysisRequest:
    """
    Adapter converting FinancialContext + TaxAgent output into a day-by-day LiquidityAnalysisRequest.
    Automatically injects upcoming CIT and VAT tax bills so cash forecasts include tax deadlines.
    """
    today = as_of or date.today()
    curr = ctx.currency.upper()
    safety_buffer = round(max(MIN_SAFETY_BUFFER_EUR, ctx.monthly_burn_rate_eur * BUFFER_MONTHS_COVERAGE), 2)
    scheduled: List[ScheduledTransaction] = []

    # 1. Open invoices (receivables = money in, payables = money out)
    for inv in ctx.invoices:
        if inv.is_paid or inv.currency.upper() != curr:
            continue
        gross_amount = round(inv.amount * (1.0 + inv.vat_rate), 2)
        signed_amount = gross_amount if inv.type == "receivable" else -gross_amount
        due_offset = max(1, inv.due_in_days)
        cat = (inv.category or "operations").upper()
        is_disc = inv.type == "payable" and (inv.category or "").lower() in DISCRETIONARY_CATEGORIES

        scheduled.append(
            ScheduledTransaction(
                due_date=today + timedelta(days=due_offset),
                amount=signed_amount,
                category=cat,
                counterparty=inv.contractor,
                is_discretionary=is_disc,
            )
        )

    # 2. Recurring monthly fixed bills (split into mid-month and month-end obligations over 45 days)
    if ctx.monthly_burn_rate_eur > 0:
        half_burn = round(ctx.monthly_burn_rate_eur * 0.5, 2)
        for day_offset in (12, 27, 42):
            scheduled.append(
                ScheduledTransaction(
                    due_date=today + timedelta(days=day_offset),
                    amount=-half_burn,
                    category="FIXED_BILLS",
                    counterparty="Monthly Payroll & Fixed Operating Bills",
                    is_discretionary=False,
                )
            )

    # 3. Synergy with TaxAgent: inject upcoming Income Tax (CIT) and Sales Tax (VAT) bills
    if tax_output and tax_output.metrics:
        m = tax_output.metrics
        cit_due = float(m.get("cit_advance_to_pay_eur", 0.0))
        cit_days = int(m.get("days_to_cit_deadline", 15))
        if cit_due > 0:
            scheduled.append(
                ScheduledTransaction(
                    due_date=today + timedelta(days=max(1, cit_days)),
                    amount=-round(cit_due, 2),
                    category="TAX",
                    counterparty="Tax Office — Corporate Income Tax",
                    is_discretionary=False,
                )
            )

        vat_due = float(m.get("vat_to_pay_eur", 0.0))
        vat_days = int(m.get("days_to_vat_deadline", 20))
        if vat_due > 0:
            scheduled.append(
                ScheduledTransaction(
                    due_date=today + timedelta(days=max(1, vat_days)),
                    amount=-round(vat_due, 2),
                    category="TAX",
                    counterparty="Tax Office — Sales Tax (VAT)",
                    is_discretionary=False,
                )
            )

    return LiquidityAnalysisRequest(
        company_name=ctx.company_name,
        as_of_date=today,
        current_balance=ctx.cash_balance_eur,
        currency=curr,
        forecast_days=DEFAULT_FORECAST_DAYS,
        safety_buffer=safety_buffer,
        scheduled_transactions=scheduled,
    )


def run_liquidity_tool(
    ctx: FinancialContext,
    llm_callback: Optional[Callable[[str], str]] = None,
    tax_output: Optional[ToolOutput] = None,
) -> ToolOutput:
    """
    Wrapper returning a unified ToolOutput for /cfo/analyze and /api/cfo/chat.
    """
    req = build_liquidity_request_from_context(ctx, tax_output=tax_output)
    res = run_liquidity_agent(req, llm_callback=llm_callback)
    curr = req.currency

    monthly_burn = ctx.monthly_burn_rate_eur
    runway_months = round(ctx.cash_balance_eur / monthly_burn, 1) if monthly_burn > 0 else 99.0

    recommendations: List[Dict] = []
    if res.proposed_action:
        act = res.proposed_action
        status = "ACTION_REQUIRED"
        recommendations.append({
            "action_id": act.action_id,
            "type": act.action_type,
            "priority": "HIGH",
            "title": act.facility_name,
            "amount_eur": act.amount,
            "estimated_monthly_cost_eur": act.estimated_monthly_cost,
            "requires_approval": True,
            "details": act.explainable_reasoning,
        })
    else:
        status = "OPTIMAL"

    metrics = {
        "currency": curr,
        "starting_balance_eur": res.starting_balance,
        "safety_buffer_eur": req.safety_buffer,
        "min_projected_balance_eur": res.min_projected_balance,
        "min_balance_date": str(res.min_balance_date),
        "first_buffer_breach_date": str(res.first_buffer_breach_date) if res.first_buffer_breach_date else None,
        "cash_shortfall_eur": res.liquidity_shortfall,
        "estimated_runway_months": runway_months,
        "biggest_upcoming_bills": res.key_risk_drivers,
    }

    if res.liquidity_shortfall > 0 and res.proposed_action:
        prompt_context = (
            f"[LIQUIDITY AGENT] Status: ACTION_REQUIRED. Currency: {curr}. "
            f"Current cash: {res.starting_balance:,.2f} {curr} (~{runway_months} months of fixed bills). "
            f"Lowest projected balance: {res.min_projected_balance:,.2f} {curr} on {res.min_balance_date} "
            f"(short by {res.liquidity_shortfall:,.2f} {curr} below the {req.safety_buffer:,.2f} {curr} safety cushion). "
            f"Recommended step: {res.proposed_action.facility_name} ({res.proposed_action.amount:,.2f} {curr})."
        )
    else:
        prompt_context = (
            f"[LIQUIDITY AGENT] Status: OPTIMAL. Currency: {curr}. "
            f"Current cash: {res.starting_balance:,.2f} {curr} (~{runway_months} months of fixed bills). "
            f"Lowest projected balance over the next {req.forecast_days} days is {res.min_projected_balance:,.2f} {curr} "
            f"on {res.min_balance_date}, staying safely above your {req.safety_buffer:,.2f} {curr} safety cushion."
        )

    output = ToolOutput(
        agent_name="LiquidityAgent",
        status=status,
        metrics=metrics,
        recommendations=recommendations,
        prompt_context=prompt_context,
    )
    # Attach raw response object in metrics metadata if needed by callers
    return output