import uuid
from datetime import timedelta
from typing import Dict, List, Optional, Tuple

from schemas import (
    AutonomyGovernance,
    LiquidityAnalysisRequest,
    LiquidityAgentResponse,
    ProposedCreditAction,
)


def simulate_cashflow_ladder(req: LiquidityAnalysisRequest) -> dict:
    """Day-by-day cash simulation for the next X days."""
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
            if t.amount <= -1000.0:
                risk_drivers.append(
                    f"{sim_date}: {t.counterparty} ({t.amount:.2f} {req.currency})"
                )

        if balance < min_balance:
            min_balance = balance
            min_balance_date = sim_date

        if balance < req.safety_buffer and first_breach_date is None:
            first_breach_date = sim_date

    shortfall = round(max(0.0, req.safety_buffer - min_balance), 2)

    return {
        "min_balance": min_balance,
        "min_balance_date": min_balance_date,
        "first_breach_date": first_breach_date,
        "shortfall": shortfall,
        "risk_drivers": risk_drivers[:6],
    }


def evaluate_credit_facility(
    req: LiquidityAnalysisRequest, sim_result: dict
) -> Tuple[Optional[ProposedCreditAction], str]:
    """
    Prepares a backup credit line proposal and a plain-English prompt for the LLM.
    Never executes any bank transfer without explicit user approval.
    """
    shortfall = sim_result["shortfall"]
    if shortfall <= 0:
        return None, ""

    recommended_limit = float(((int(shortfall) // 5000) + 1) * 5000)
    est_monthly_interest = round(recommended_limit * 0.085 / 12, 2)

    discretionary = [
        t for t in req.scheduled_transactions
        if req.as_of_date < t.due_date <= req.as_of_date + timedelta(days=req.forecast_days)
        and t.is_discretionary
    ]
    disc_note = ""
    if discretionary:
        total_disc = abs(sum(t.amount for t in discretionary))
        disc_note = (
            f" We also spotted optional expenses ({discretionary[0].counterparty}) "
            f"totaling {total_disc:.2f} {req.currency} that could be delayed to shrink the cash gap."
        )

    llm_prompt = (
        f"Company: {req.company_name}. Today's date: {req.as_of_date}. "
        f"Starting bank balance: {req.current_balance:.2f} {req.currency}. "
        f"Lowest projected balance: {sim_result['min_balance']:.2f} {req.currency} "
        f"on {sim_result['min_balance_date']}. "
        f"Biggest upcoming bills: {', '.join(sim_result['risk_drivers'])}.{disc_note} "
        f"In 3 short, jargon-free sentences, explain why opening a backup credit line "
        f"of {recommended_limit:.2f} {req.currency} (estimated cost ~{est_monthly_interest:.2f} {req.currency}/month if used) "
        f"keeps the business safe."
    )

    action = ProposedCreditAction(
        action_id=str(uuid.uuid4())[:8],
        status="PENDING_APPROVAL",
        execution_mode="SIMULATED",
        requires_user_approval=True,
        action_type="CREDIT_FACILITY",
        facility_name="Revolving Overdraft Facility",
        amount=recommended_limit,
        currency=req.currency,
        estimated_monthly_cost=est_monthly_interest,
        explainable_reasoning="",
    )
    return action, llm_prompt


def run_liquidity_agent(
    req: LiquidityAnalysisRequest, llm_callback
) -> LiquidityAgentResponse:
    """Main Liquidity Agent tool function."""
    sim = simulate_cashflow_ladder(req)
    action, prompt = evaluate_credit_facility(req, sim)

    if action and prompt:
        action.explainable_reasoning = llm_callback(prompt)

    governance = AutonomyGovernance(
        independent_analysis=[
            f"Day-by-day bank balance check for the next {req.forecast_days} days",
            "Found the exact date your safety cushion dips and identified the biggest bills",
        ],
        agent_recommendations=[
            f"Set up a backup credit line of {action.amount:.2f} {req.currency}"
            if action else "No extra borrowing needed — your cash cushion looks healthy"
        ],
        requires_user_approval=[
            "Applying for and activating the backup credit line with your bank",
            "Optionally delaying non-urgent investment transfers",
        ] if action else [],
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