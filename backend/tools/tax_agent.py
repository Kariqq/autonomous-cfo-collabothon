import os
import sys

# Wskazujemy dokładnie folder "backend" (piętro wyżej od "tools")
BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from schemas import FinancialContext, ToolOutput


def run_tax_agent(ctx: FinancialContext) -> ToolOutput:
    """
    Koordynuje zaliczki na podatek dochodowy (CIT) oraz VAT, pilnuje terminów
    płatności (20. i 25. dzień miesiąca) oraz wykrywa ulgi podatkowe (B+R, złe długi, Estoński CIT).
    """
    # 1. Obliczenie VAT należnego (sprzedaż) i VAT naliczonego (zakupy) w PLN
    vat_output = sum(
        inv.amount * inv.vat_rate for inv in ctx.invoices
        if inv.type == "receivable" and inv.currency == "PLN"
    )
    vat_input = sum(
        inv.amount * inv.vat_rate for inv in ctx.invoices
        if inv.type == "payable" and inv.currency == "PLN"
    )
    vat_to_pay = max(0.0, round(vat_output - vat_input, 2))
    vat_surplus_to_carry = max(0.0, round(vat_input - vat_output, 2))

    # 2. Obliczenie podstawy opodatkowania CIT i miesięcznej zaliczki
    total_revenues_net = sum(
        inv.amount for inv in ctx.invoices
        if inv.type == "receivable" and inv.currency == "PLN"
    )
    deductible_costs_net = sum(
        inv.amount for inv in ctx.invoices
        if inv.type == "payable" and inv.currency == "PLN" and inv.category != "reprezentacja"
    )
    # Uwzględniamy również stałe koszty operacyjne (np. wynagrodzenia z burn rate)
    taxable_income = max(0.0, total_revenues_net - deductible_costs_net - (ctx.monthly_burn_rate_pln * 0.6))
    cit_advance_to_pay = round(taxable_income * ctx.cit_rate, 2)

    total_tax_liability = round(vat_to_pay + cit_advance_to_pay, 2)

    # 3. Kalkulacja dni do ustawowych terminów (20. CIT, 25. VAT)
    days_to_cit_deadline = 20 - ctx.day_of_month if ctx.day_of_month <= 20 else (30 - ctx.day_of_month + 20)
    days_to_vat_deadline = 25 - ctx.day_of_month if ctx.day_of_month <= 25 else (30 - ctx.day_of_month + 25)

    recommendations: List[Dict[str, Any]] = []
    potential_tax_savings_pln = 0.0
    status = "OPTIMAL"

    # Alerty terminowe i zabezpieczenie gotówki na podatki
    if total_tax_liability > 0:
        status = "ACTION_REQUIRED"
        tax_to_cash_ratio = total_tax_liability / ctx.cash_balance_pln if ctx.cash_balance_pln > 0 else 1.0
        recommendations.append({
            "type": "TAX_ADVANCE_SCHEDULE",
            "priority": "HIGH" if days_to_cit_deadline <= 5 or tax_to_cash_ratio > 0.4 else "MEDIUM",
            "title": "Zabezpieczenie środków na CIT (20.) oraz VAT (25.)",
            "amount_pln": total_tax_liability,
            "details": (
                f"Zaliczka CIT ({int(ctx.cit_rate * 100)}%): {cit_advance_to_pay:,.2f} PLN (płatne za {days_to_cit_deadline} dni). "
                f"Podatek VAT do zapłaty: {vat_to_pay:,.2f} PLN (płatne za {days_to_vat_deadline} dni). "
                f"Zablokuj łącznie {total_tax_liability:,.2f} PLN na subkoncie podatkowym."
            )
        })

    # 4. OPTYMALIZACJA 1: Ulga B+R (R&D Tax Relief)
    rd_categories = {"IT", "R&D", "software", "engineering", "badania"}
    rd_expenses = sum(
        inv.amount for inv in ctx.invoices
        if inv.type == "payable" and inv.category and inv.category.lower() in {c.lower() for c in rd_categories}
    )
    if rd_expenses > 0:
        # W polskiej uldze B+R można odliczyć dodatkowo 100% kosztów kwalifikowanych od podstawy opodatkowania
        rd_tax_saving = round(rd_expenses * ctx.cit_rate, 2)
        potential_tax_savings_pln += rd_tax_saving
        if status == "OPTIMAL":
            status = "OPPORTUNITY_FOUND"
        recommendations.append({
            "type": "OPTIMIZATION_RD_RELIEF",
            "priority": "HIGH",
            "title": "Kwalifikacja wydatków do Ulgi B+R (R&D)",
            "potential_saving_pln": rd_tax_saving,
            "details": (
                f"Wykryto koszty technologiczne/rozwojowe na kwotę {rd_expenses:,.2f} PLN. "
                f"Dodatkowe odliczenie w ramach ulgi B+R obniży podatek CIT o {rd_tax_saving:,.2f} PLN."
            )
        })

    # 5. OPTYMALIZACJA 2: Ulga na złe długi (Bad Debt Relief > 90 dni po terminie)
    bad_debt_invoices = [
        inv for inv in ctx.invoices
        if inv.type == "receivable" and not inv.is_paid and inv.due_in_days <= -90
    ]
    if bad_debt_invoices:
        bad_debt_net = sum(inv.amount for inv in bad_debt_invoices)
        bad_debt_vat = sum(inv.amount * inv.vat_rate for inv in bad_debt_invoices)
        bad_debt_cit_saving = round(bad_debt_net * ctx.cit_rate, 2)
        total_bad_debt_recovery = round(bad_debt_vat + bad_debt_cit_saving, 2)
        potential_tax_savings_pln += total_bad_debt_recovery
        status = "ACTION_REQUIRED"
        recommendations.append({
            "type": "OPTIMIZATION_BAD_DEBT_RELIEF",
            "priority": "HIGH",
            "title": f"Ulga na złe długi ({len(bad_debt_invoices)} faktur > 90 dni po terminie)",
            "potential_saving_pln": total_bad_debt_recovery,
            "details": (
                f"Przeterminowane należności na kwotę {bad_debt_net:,.2f} PLN netto uprawniają do korekty VAT "
                f"(zwrot {bad_debt_vat:,.2f} PLN) oraz pomniejszenia podstawy CIT o {bad_debt_cit_saving:,.2f} PLN."
            )
        })

    # 6. OPTYMALIZACJA 3: Estoński CIT (jeśli dochód jest wysoki i brak wypłat dywidend)
    if taxable_income > 30000 and cit_advance_to_pay > 2500:
        potential_tax_savings_pln += cit_advance_to_pay
        recommendations.append({
            "type": "OPTIMIZATION_ESTONIAN_CIT",
            "priority": "MEDIUM",
            "title": "Symulacja przejścia na Estoński CIT (0% przy reinwestycji)",
            "potential_saving_pln": cit_advance_to_pay,
            "details": (
                f"Przy reinwestowaniu zysku w spółce przejście na Estoński CIT pozwala zatrzymać "
                f"{cit_advance_to_pay:,.2f} PLN miesięcznie w kapitale obrotowym zamiast płacić bieżące zaliczki CIT."
            )
        })

    metrics = {
        "vat_output_pln": round(vat_output, 2),
        "vat_input_pln": round(vat_input, 2),
        "vat_to_pay_pln": vat_to_pay,
        "vat_surplus_carried_forward_pln": vat_surplus_to_carry,
        "cit_advance_to_pay_pln": cit_advance_to_pay,
        "total_tax_liability_pln": total_tax_liability,
        "days_to_cit_deadline": days_to_cit_deadline,
        "days_to_vat_deadline": days_to_vat_deadline,
        "potential_tax_savings_pln": round(potential_tax_savings_pln, 2),
    }

    prompt_context = (
        f"[TAX AGENT] Status: {status}. "
        f"Zaliczka CIT (do 20. dnia, za {days_to_cit_deadline} dni): {cit_advance_to_pay} PLN. "
        f"VAT do zapłaty (do 25. dnia, za {days_to_vat_deadline} dni): {vat_to_pay} PLN. "
        f"Łączna kwota podatków do zabezpieczenia: {total_tax_liability} PLN. "
        f"Zidentyfikowane oszczędności/optymalizacje podatkowe: {round(potential_tax_savings_pln, 2)} PLN."
    )

    return ToolOutput(
        agent_name="TaxAgent",
        status=status,
        metrics=metrics,
        recommendations=recommendations,
        prompt_context=prompt_context,
    )