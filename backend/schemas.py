from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class Invoice(BaseModel):
    id: str
    contractor: str
    amount: float                  # Kwota netto
    vat_rate: float = 0.23         # NOWE: Stawka VAT (np. 0.23, 0.08, 0.0)
    currency: str = "PLN"
    due_in_days: int               # ujemne = po terminie, dodatnie = za ile dni
    type: str                      # "receivable" | "payable"
    category: Optional[str] = "operacyjne"  # np. "IT", "R&D", "marketing", "biuro", "wynagrodzenia"
    is_paid: bool = False          # NOWE: Czy faktura została już opłacona


class FinancialContext(BaseModel):
    company_name: str
    cash_balance_pln: float
    monthly_burn_rate_pln: float
    cit_rate: float = 0.09         # NOWE: 0.09 (Mały podatnik CIT) lub 0.19 (Standard CIT)
    day_of_month: int = 15         # NOWE: Aktualny dzień miesiąca (do liczenia dni do 20. i 25.)
    invoices: List[Invoice] = Field(default_factory=list)
    user_query: Optional[str] = None


class ToolOutput(BaseModel):
    agent_name: str
    status: str                    # "ACTION_REQUIRED" | "OPPORTUNITY_FOUND" | "OPTIMAL"
    metrics: Dict[str, Any]
    recommendations: List[Dict[str, Any]]
    prompt_context: str