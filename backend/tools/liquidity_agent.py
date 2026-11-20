import uuid
from datetime import timedelta
from typing import Dict, Optional, List, Tuple

from schemas import (
    AutonomyGovernance,
    LiquidityAnalysisRequest,
    LiquidityAgentResponse,
    ProposedCreditAction,
)


def simulate_cashflow_ladder(req: LiquidityAnalysisRequest) -> dict:
    """Niezależna symulacja przepływów dzień po dniu na X dni do przodu."""
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
    Dobiera propozycję finansowania i przygotowuje prompt dla LLM (Explainable AI).
    Nie wykonuje żadnej operacji bankowej — zwraca obiekt wymagający zgody użytkownika.
    """
    shortfall = sim_result["shortfall"]
    if shortfall <= 0:
        return None, ""

    # Zaokrąglenie potrzebnego limitu w górę do pełnych 5 000 jednostek waluty
    recommended_limit = float(((int(shortfall) // 5000) + 1) * 5000)
    est_monthly_interest = round(recommended_limit * 0.085 / 12, 2)

    # Sprawdzenie czy w oknie prognozy są wydatki nieobowiązkowe (np. przelew inwestycyjny CHF)
    discretionary = [
        t for t in req.scheduled_transactions
        if req.as_of_date < t.due_date <= req.as_of_date + timedelta(days=req.forecast_days)
        and t.is_discretionary
    ]
    disc_note = ""
    if discretionary:
        total_disc = abs(sum(t.amount for t in discretionary))
        disc_note = (
            f" Dodatkowo zidentyfikowano wydatki uznaniowe ({discretionary[0].counterparty}) "
            f"na kwotę {total_disc:.2f} {req.currency}, których przesunięcie zmniejszyłoby lukę."
        )

    llm_prompt = (
        f"Firma: {req.company_name}. Data analizy: {req.as_of_date}. "
        f"Saldo początkowe: {req.current_balance:.2f} {req.currency}. "
        f"Prognozowane minimum: {sim_result['min_balance']:.2f} {req.currency} "
        f"w dniu {sim_result['min_balance_date']}. "
        f"Główne obciążenia: {', '.join(sim_result['risk_drivers'])}.{disc_note} "
        f"Uzasadnij w 3 zwięzłych zdaniach rekomendację uruchomienia linii kredytowej "
        f"w rachunku bieżącym na kwotę {recommended_limit:.2f} {req.currency}."
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
        explainable_reasoning="",  # Wypełniane przez LLM w warstwie app.py
    )
    return action, llm_prompt


def run_liquidity_agent(
    req: LiquidityAnalysisRequest, llm_callback
) -> LiquidityAgentResponse:
    """Główna funkcja narzędzia Liquidity Agent."""
    sim = simulate_cashflow_ladder(req)
    action, prompt = evaluate_credit_facility(req, sim)

    if action and prompt:
        action.explainable_reasoning = llm_callback(prompt)

    governance = AutonomyGovernance(
        independent_analysis=[
            f"Symulacja salda dzień po dniu na {req.forecast_days} dni naprzód",
            "Identyfikacja daty naruszenia bufora bezpieczeństwa oraz głównych obciążeń",
        ],
        agent_recommendations=[
            f"Uruchomienie linii kredytowej na {action.amount:.2f} {req.currency}"
            if action else "Brak potrzeby uruchamiania finansowania zewnętrznego"
        ],
        requires_user_approval=[
            "Złożenie wniosku i aktywacja linii kredytowej w banku",
            "Ewentualne wstrzymanie przelewów inwestycyjnych/uznaniowych",
        ] if action else [],
        execution_status="SIMULATED_SANDBOX (Brak realnego przelewu/zaciągnięcia długu)",
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