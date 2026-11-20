import os
import sys
from unittest.mock import MagicMock, patch
import pytest

# Dodajemy katalog "backend" do ścieżki wyszukiwania modułów
BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from schemas import FinancialContextFX, InvoiceFX
from tools.fx_hedging_agent import run_fx_hedging_agent


def test_no_foreign_invoices_returns_optimal():
    """Gdy wszystkie faktury są w walucie bazowej (EUR), agent zwraca status OPTIMAL."""
    ctx = FinancialContextFX(
        company_name="EuroLocal GmbH",
        base_currency="EUR",
        cash_balance=25000.0,
        monthly_burn_rate=8000.0,
        invoices=[
            InvoiceFX(
                id="INV-001",
                contractor="Local Supplier",
                amount=5000.0,
                vat_rate=0.19,
                currency="EUR",
                due_in_days=15,
                type="payable",
            )
        ],
    )

    result = run_fx_hedging_agent(ctx)

    assert result.agent_name == "FXHedgingAgent"
    assert result.status == "OPTIMAL"
    assert result.metrics["total_net_exposure"] == 0.0
    assert result.recommendations == []


def test_payable_foreign_currency_triggers_cb_fx_forward():
    """Zobowiązanie w CHF uruchamia rekomendację Commerzbank FX Forward (zakup CHF)."""
    ctx = FinancialContextFX(
        company_name="Alpine Gastro GmbH",
        base_currency="EUR",
        cash_balance=30000.0,
        monthly_burn_rate=12000.0,
        fx_rates={"CHF": 1.0500},  # 1 CHF = 1.05 EUR
        invoices=[
            InvoiceFX(
                id="INV-CHF-1",
                contractor="Zurich Partner AG",
                amount=10000.0,
                vat_rate=0.0,
                currency="CHF",
                due_in_days=30,
                type="payable",
            )
        ],
    )

    result = run_fx_hedging_agent(ctx)

    assert result.status == "ACTION_REQUIRED"
    assert result.metrics["rate_source"] == "USER_CONTEXT_RATES"
    assert result.metrics["total_net_exposure"] == 10500.0
    assert len(result.recommendations) == 1

    rec = result.recommendations[0]
    assert rec["product_id"] == "CB_FX_FORWARD"
    assert rec["requires_approval"] is True
    assert rec["execution_mode"] == "SIMULATED"
    assert rec["priority"] == "HIGH"  # Ekspozycja >= 3000 EUR

    quote = rec["quote_details"]
    assert quote["pair"] == "CHF/EUR"
    assert quote["direction"] == "zakup"
    assert quote["notional_amount_fc"] == 10000.0
    # Kurs spot 1.0500 + 15 bps (0.15%) = 1.0516
    assert quote["guaranteed_forward_rate"] == round(1.0500 * 1.0015, 4)
    assert quote["locked_value_base"] == round(10000.0 * quote["guaranteed_forward_rate"], 2)
    assert quote["protected_risk_base"] > 0


def test_receivable_with_vat_triggers_sell_forward():
    """Należność eksportowa w USD z VAT (20%) uruchamia FX Forward na sprzedaż USD."""
    ctx = FinancialContextFX(
        company_name="TechExport Sp. z o.o.",
        base_currency="PLN",
        cash_balance=100000.0,
        monthly_burn_rate=40000.0,
        fx_rates={"USD": 4.0000},  # 1 USD = 4.00 PLN
        invoices=[
            InvoiceFX(
                id="EXP-2026-99",
                contractor="US Client Inc.",
                amount=10000.0,
                vat_rate=0.20,  # Brutto: 12 000 USD
                currency="USD",
                due_in_days=45,
                type="receivable",
            )
        ],
    )

    result = run_fx_hedging_agent(ctx)

    assert result.status == "ACTION_REQUIRED"
    assert result.metrics["base_currency"] == "PLN"
    # 12 000 USD * 4.00 PLN = 48 000 PLN
    assert result.metrics["total_net_exposure"] == 48000.0

    rec = result.recommendations[0]
    assert rec["product_id"] == "CB_FX_FORWARD"
    assert rec["quote_details"]["direction"] == "sprzedaż"
    assert rec["quote_details"]["notional_amount_fc"] == 12000.0
    # Przy sprzedaży waluty obcej kurs forward = spot * (1 - 0.0015) = 3.9940
    assert rec["quote_details"]["guaranteed_forward_rate"] == round(4.0000 * 0.9985, 4)


def test_natural_hedging_cancels_exposure():
    """Gdy wpływy i wydatki w tej samej walucie obcej się równoważą, ekspozycja netto wynosi 0."""
    ctx = FinancialContextFX(
        company_name="Balanced Trade GmbH",
        base_currency="EUR",
        cash_balance=50000.0,
        monthly_burn_rate=15000.0,
        fx_rates={"CHF": 1.05},
        invoices=[
            InvoiceFX(
                id="REC-1",
                contractor="Swiss Buyer",
                amount=5000.0,
                vat_rate=0.0,
                currency="CHF",
                due_in_days=20,
                type="receivable",
            ),
            InvoiceFX(
                id="PAY-1",
                contractor="Swiss Vendor",
                amount=5000.0,
                vat_rate=0.0,
                currency="CHF",
                due_in_days=20,
                type="payable",
            ),
        ],
    )

    result = run_fx_hedging_agent(ctx)

    assert result.status == "OPTIMAL"
    assert result.metrics["total_gross_exposure"] == 10500.0
    assert result.metrics["total_net_exposure"] == 0.0
    assert result.recommendations == []


def test_paid_invoices_are_ignored():
    """Faktury oznaczone jako opłacone (is_paid=True) są pomijane w analizie."""
    ctx = FinancialContextFX(
        company_name="CleanBooks GmbH",
        base_currency="EUR",
        cash_balance=20000.0,
        monthly_burn_rate=5000.0,
        fx_rates={"USD": 0.92},
        invoices=[
            InvoiceFX(
                id="PAID-1",
                contractor="Cloud Vendor US",
                amount=8000.0,
                vat_rate=0.0,
                currency="USD",
                due_in_days=10,
                type="payable",
                is_paid=True,
            )
        ],
    )

    result = run_fx_hedging_agent(ctx)

    assert result.status == "OPTIMAL"
    assert result.recommendations == []


def test_multiple_currencies_generate_separate_forwards():
    """Wiele walut obcych (CHF i GBP) generuje dwie niezależne oferty CB_FX_FORWARD."""
    ctx = FinancialContextFX(
        company_name="MultiImport GmbH",
        base_currency="EUR",
        cash_balance=80000.0,
        monthly_burn_rate=25000.0,
        fx_rates={"CHF": 1.05, "GBP": 1.18},
        invoices=[
            InvoiceFX(
                id="INV-CHF",
                contractor="Swiss Supplier",
                amount=4000.0,
                currency="CHF",
                due_in_days=25,
                type="payable",
            ),
            InvoiceFX(
                id="INV-GBP",
                contractor="UK Supplier",
                amount=6000.0,
                currency="GBP",
                due_in_days=40,
                type="payable",
            ),
        ],
    )

    result = run_fx_hedging_agent(ctx)

    assert result.status == "ACTION_REQUIRED"
    assert set(result.metrics["currencies_exposed"]) == {"CHF", "GBP"}
    assert len(result.recommendations) == 2
    assert all(r["product_id"] == "CB_FX_FORWARD" for r in result.recommendations)


@patch("tools.fx_hedging_agent.requests.get")
def test_live_ecb_api_rate_fetching(mock_get):
    """Sprawdza poprawne przeliczenie kursu pobranego z API Frankfurter (EBC)."""
    # Symulujemy odpowiedź API: 1 EUR = 0.95 CHF -> 1 CHF = 1 / 0.95 = 1.052632 EUR
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "amount": 1.0,
        "base": "EUR",
        "date": "2026-11-20",
        "rates": {"CHF": 0.95},
    }
    mock_response.raise_for_status.return_value = None
    mock_get.return_value = mock_response

    ctx = FinancialContextFX(
        company_name="API Test GmbH",
        base_currency="EUR",
        cash_balance=40000.0,
        monthly_burn_rate=10000.0,
        # Brak custom fx_rates -> agent powinien odpytać API
        invoices=[
            InvoiceFX(
                id="INV-API-1",
                contractor="Swiss Co",
                amount=9500.0,
                currency="CHF",
                due_in_days=30,
                type="payable",
            )
        ],
    )

    result = run_fx_hedging_agent(ctx)

    assert "ECB_LIVE" in result.metrics["rate_source"]
    # 9500 CHF * (1 / 0.95) = 10 000.00 EUR
    assert result.metrics["total_net_exposure"] == 10000.0
    assert result.recommendations[0]["product_id"] == "CB_FX_FORWARD"