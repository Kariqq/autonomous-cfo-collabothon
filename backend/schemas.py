from datetime import date
from typing import Any, Dict, List, Optional, Literal
from pydantic import BaseModel, Field


class Invoice(BaseModel):
    id: str
    contractor: str
    amount: float                  # Kwota netto
    vat_rate: float = 0.19         # NOWE: Stawka VAT (np. 0.23, 0.08, 0.0)
    currency: str = "EUR"
    due_in_days: int               # ujemne = po terminie, dodatnie = za ile dni
    type: str                      # "receivable" | "payable"
    category: Optional[str] = "operacyjne"  # np. "IT", "R&D", "marketing", "biuro", "wynagrodzenia"
    is_paid: bool = False          # NOWE: Czy faktura została już opłacona


class FinancialContext(BaseModel):
    company_name: str
    cash_balance_eur: float
    monthly_burn_rate_eur: float
    cit_rate: float = 0.09         # NOWE: 0.09 (Mały podatnik CIT) lub 0.19 (Standard CIT)
    day_of_month: int = 15         # NOWE: Aktualny dzień miesiąca (do liczenia dni do 20. i 25.)
    invoices: List[Invoice] = Field(default_factory=list)
    user_query: Optional[str] = None

class ScheduledTransaction(BaseModel):
    due_date: date
    amount: float  # dodatnia = wpływ, ujemna = wydatek
    category: str  # np. "RENT", "PAYROLL", "TAX", "CAPEX_TRANSFER", "CARD_REVENUE"
    counterparty: str
    is_discretionary: bool = False  # np. przelew inwestycyjny do Luigiego = True (można przesunąć)


class LiquidityAnalysisRequest(BaseModel):
    company_name: str
    as_of_date: date
    current_balance: float
    currency: str = "EUR"
    forecast_days: int = 45
    safety_buffer: float = 5000.0
    scheduled_transactions: List[ScheduledTransaction]


class ProposedCreditAction(BaseModel):
    action_id: str
    status: Literal["PENDING_APPROVAL", "APPROVED_EXECUTED_SIMULATED", "REJECTED"]
    execution_mode: Literal["SIMULATED", "PERMITTED"] = "SIMULATED"
    requires_user_approval: bool = True
    action_type: Literal["CREDIT_FACILITY", "DEFER_DISCRETIONARY_OUTFLOW"]
    facility_name: str
    amount: float
    currency: str
    estimated_monthly_cost: float
    explainable_reasoning: str


class AutonomyGovernance(BaseModel):
    independent_analysis: List[str]
    agent_recommendations: List[str]
    requires_user_approval: List[str]
    execution_status: str  # "SIMULATED_SANDBOX" vs "PERMITTED_LIVE"


class LiquidityAgentResponse(BaseModel):
    company_name: str
    as_of_date: date
    forecast_horizon_days: int
    starting_balance: float
    min_projected_balance: float
    min_balance_date: date
    first_buffer_breach_date: Optional[date]
    liquidity_shortfall: float
    key_risk_drivers: List[str]
    governance: AutonomyGovernance
    proposed_action: Optional[ProposedCreditAction] = None

class ToolOutput(BaseModel):
    agent_name: str
    status: str                    # "ACTION_REQUIRED" | "OPPORTUNITY_FOUND" | "OPTIMAL"
    metrics: Dict[str, Any]
    recommendations: List[Dict[str, Any]]
    prompt_context: str

class InvoiceFX(BaseModel):
    id: str
    contractor: str
    amount: float                       # Kwota netto
    vat_rate: float = 0.0               # Stawka VAT (np. 0.23, 0.19, 0.0)
    currency: str = "EUR"               # Waluta faktury/transakcji ("EUR", "PLN", "CHF", "USD", "GBP")
    due_in_days: int                    # Za ile dni płatność (ujemne = po terminie)
    type: str                           # "receivable" (wpływ) | "payable" (wydatek)
    category: Optional[str] = "operacyjne"
    is_paid: bool = False


class FinancialContextFX(BaseModel):
    company_name: str
    base_currency: str = "EUR"          # Waluta księgowa firmy (np. "EUR", "PLN", "USD")
    cash_balance: float                 # Aktualne saldo gotówki w walucie bazowej
    monthly_burn_rate: float            # Miesięczne koszty stałe w walucie bazowej
    tax_rate: float = 0.19
    day_of_month: int = 15
    invoices: List[InvoiceFX] = Field(default_factory=list)
    fx_rates: Dict[str, float] = Field(default_factory=dict)  # Opcjonalne kursy nadpisane przez użytkownika
    user_query: Optional[str] = None