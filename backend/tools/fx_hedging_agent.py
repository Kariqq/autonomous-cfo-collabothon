import os
import sys
import time
from typing import Any, Dict, List, Tuple
import requests

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from schemas import FinancialContextFX, ToolOutput

# Produkt zabezpieczający Commerzbanku
COMMERZBANK_FX_FORWARD: Dict[str, Any] = {
    "product_id": "CB_FX_FORWARD",
    "name": "Commerzbank FX Forward (Devisentermingeschäft)",
    "channel": "Commerzbank Corporate Banking / FX Live",
    "spread_bps": 15,  # 0.15% marży wbudowanej w kurs terminowy
}

# Kursy zapasowe względem 1 EUR (gdy klaster nie ma dostępu do internetu)
FALLBACK_RATES_VS_EUR: Dict[str, float] = {
    "EUR": 1.0,
    "PLN": 4.30,
    "CHF": 0.94,
    "USD": 1.08,
    "GBP": 0.85,
    "CZK": 25.20,
}

# Roczna zmienność par walutowych (do szacowania ryzyka VaR)
FX_VOLATILITY: Dict[str, float] = {
    "CHF": 0.055,
    "USD": 0.075,
    "GBP": 0.060,
    "PLN": 0.065,
    "EUR": 0.050,
}

_RATE_CACHE: Dict[str, Tuple[float, Dict[str, float]]] = {}


def get_exchange_rates_to_base(base_currency: str, custom_rates: Dict[str, float]) -> Tuple[Dict[str, float], str]:
    """
    Zwraca słownik kursów: ile jednostek waluty bazowej (base_currency) kosztuje 1 jednostka waluty obcej.
    Pobiera żywe kursy z API Frankfurter (Europejski Bank Centralny) lub używa bezpiecznego fallbacku.
    """
    base = base_currency.upper()
    rates_to_base: Dict[str, float] = {base: 1.0}

    if custom_rates:
        for curr, val in custom_rates.items():
            rates_to_base[curr.upper()] = float(val)
        return rates_to_base, "USER_CONTEXT_RATES"

    now = time.time()
    if base in _RATE_CACHE and (now - _RATE_CACHE[base][0] < 3600):
        return _RATE_CACHE[base][1], "ECB_API_CACHED"

    try:
        resp = requests.get(f"https://api.frankfurter.app/latest?from={base}", timeout=3)
        resp.raise_for_status()
        data = resp.json()
        for foreign_curr, rate_from_base in data.get("rates", {}).items():
            if rate_from_base > 0:
                rates_to_base[foreign_curr.upper()] = round(1.0 / float(rate_from_base), 6)
        _RATE_CACHE[base] = (now, rates_to_base)
        return rates_to_base, f"ECB_LIVE ({data.get('date')})"
    except Exception:
        pass

    base_per_eur = FALLBACK_RATES_VS_EUR.get(base, 1.0)
    for curr, curr_per_eur in FALLBACK_RATES_VS_EUR.items():
        if curr != base and curr_per_eur > 0:
            rates_to_base[curr] = round(base_per_eur / curr_per_eur, 6)

    return rates_to_base, "OFFLINE_FALLBACK"


def run_fx_hedging_agent(ctx: FinancialContextFX) -> ToolOutput:
    """
    Identyfikuje ekspozycję netto w walutach innych niż ctx.base_currency
    i proponuje zabezpieczenie kontraktem terminowym Commerzbank FX Forward (CB_FX_FORWARD).
    """
    base = ctx.base_currency.upper()
    foreign_invoices = [
        inv for inv in ctx.invoices
        if not inv.is_paid and inv.currency.upper() != base
    ]

    if not foreign_invoices:
        return ToolOutput(
            agent_name="FXHedgingAgent",
            status="OPTIMAL",
            metrics={
                "base_currency": base,
                "total_gross_exposure": 0.0,
                "total_net_exposure": 0.0,
                "estimated_fx_risk": 0.0,
                "currencies_exposed": [],
            },
            recommendations=[],
            prompt_context=f"[FX HEDGING AGENT] Status: OPTIMAL. Wszystkie otwarte faktury są w walucie bazowej ({base}).",
        )

    rates_to_base, rate_source = get_exchange_rates_to_base(base, ctx.fx_rates)

    exposure_by_curr: Dict[str, Dict[str, Any]] = {}
    for inv in foreign_invoices:
        curr = inv.currency.upper()
        rate = rates_to_base.get(curr, 1.0)
        gross_fc = inv.amount * (1.0 + inv.vat_rate)

        if curr not in exposure_by_curr:
            exposure_by_curr[curr] = {
                "rate_to_base": rate,
                "receivables_fc": 0.0,
                "payables_fc": 0.0,
                "max_due_days": 0,
                "invoice_ids": [],
                "contractors": set(),
            }

        if inv.type == "receivable":
            exposure_by_curr[curr]["receivables_fc"] += gross_fc
        elif inv.type == "payable":
            exposure_by_curr[curr]["payables_fc"] += gross_fc

        due_days = max(0, inv.due_in_days)
        exposure_by_curr[curr]["max_due_days"] = max(exposure_by_curr[curr]["max_due_days"], due_days)
        exposure_by_curr[curr]["invoice_ids"].append(inv.id)
        exposure_by_curr[curr]["contractors"].add(inv.contractor)

    recommendations: List[Dict[str, Any]] = []
    status = "OPTIMAL"
    total_gross_base = 0.0
    total_net_base = 0.0
    total_risk_base = 0.0

    product = COMMERZBANK_FX_FORWARD
    spread = product["spread_bps"] / 10000.0

    for curr, data in exposure_by_curr.items():
        rate = data["rate_to_base"]
        rec_fc = data["receivables_fc"]
        pay_fc = data["payables_fc"]

        net_fc = rec_fc - pay_fc
        abs_net_fc = abs(net_fc)

        gross_base = (rec_fc + pay_fc) * rate
        net_base = abs_net_fc * rate
        total_gross_base += gross_base
        total_net_base += net_base

        if abs_net_fc <= 0:
            continue

        status = "ACTION_REQUIRED"
        horizon_days = max(1, data["max_due_days"])
        vol = FX_VOLATILITY.get(curr, 0.06)
        var_loss_base = round(net_base * vol * ((horizon_days / 365.0) ** 0.5) * 1.65, 2)
        total_risk_base += var_loss_base

        direction = "sprzedaż" if net_fc > 0 else "zakup"
        risk_desc = f"spadku kursu {curr}/{base}" if net_fc > 0 else f"wzrostu kursu {curr}/{base}"
        contractors_str = ", ".join(sorted(data["contractors"]))

        forward_rate = round(rate * (1.0 - spread if net_fc > 0 else 1.0 + spread), 4)
        locked_base = round(abs_net_fc * forward_rate, 2)

        recommendations.append({
            "action_id": f"CB-FWD-{curr}-{horizon_days}D",
            "product_id": product["product_id"],
            "product_name": product["name"],
            "channel": product["channel"],
            "priority": "HIGH" if net_base >= 3000 else "MEDIUM",
            "requires_approval": True,
            "execution_mode": "SIMULATED",
            "quote_details": {
                "pair": f"{curr}/{base}",
                "direction": direction,
                "notional_amount_fc": round(abs_net_fc, 2),
                "spot_rate": round(rate, 4),
                "guaranteed_forward_rate": forward_rate,
                "locked_value_base": locked_base,
                "base_currency": base,
                "settlement_in_days": horizon_days,
                "protected_risk_base": var_loss_base,
            },
            "title": f"{product['name']}: zablokuj kurs dla {abs_net_fc:,.2f} {curr} ({horizon_days} dni)",
            "details": (
                f"Ekspozycja netto {abs_net_fc:,.2f} {curr} ({net_base:,.2f} {base}) z terminem za {horizon_days} dni "
                f"(kontrahenci: {contractors_str}). Kontrakt {product['name']} gwarantuje kurs {forward_rate} "
                f"(wartość: {locked_base:,.2f} {base}) i eliminuje ryzyko {risk_desc} (VaR: {var_loss_base:,.2f} {base})."
            ),
        })

    metrics = {
        "base_currency": base,
        "rate_source": rate_source,
        "applied_rates_to_base": {k: round(rates_to_base[k], 4) for k in exposure_by_curr if k in rates_to_base},
        "total_gross_exposure": round(total_gross_base, 2),
        "total_net_exposure": round(total_net_base, 2),
        "estimated_fx_risk": round(total_risk_base, 2),
        "currencies_exposed": list(exposure_by_curr.keys()),
    }

    prompt_context = (
        f"[FX HEDGING AGENT] Status: {status}. Waluta bazowa: {base}. "
        f"Wykryte waluty obce: {', '.join(exposure_by_curr.keys())} (źródło kursów: {rate_source}). "
        f"Ekspozycja netto: {round(total_net_base, 2)} {base}, szacowane ryzyko kursowe: {round(total_risk_base, 2)} {base}. "
        f"Rekomendowany produkt: {product['name']}."
    )

    return ToolOutput(
        agent_name="FXHedgingAgent",
        status=status,
        metrics=metrics,
        recommendations=recommendations,
        prompt_context=prompt_context,
    )