import os
import sys
from typing import Any, Dict, List

# Point directly to the "backend" folder (one level above "tools")
BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from schemas import FinancialContext, ToolOutput


def run_tax_agent(ctx: FinancialContext) -> ToolOutput:
    """
    Calculates German business taxes in EUR (VAT and Corporate Income Tax),
    tracks official Finanzamt deadlines (10th of the month), and finds simple
    ways to save money on taxes.
    """
    # 1. Calculate VAT (Umsatzsteuer) in EUR
    # VAT collected from customers minus VAT paid on business purchases
    vat_collected = sum(
        inv.amount * inv.vat_rate for inv in ctx.invoices
        if inv.type == "receivable" and inv.currency.upper() == "EUR"
    )
    vat_paid_on_purchases = sum(
        inv.amount * inv.vat_rate for inv in ctx.invoices
        if inv.type == "payable" and inv.currency.upper() == "EUR"
    )
    vat_to_pay = max(0.0, round(vat_collected - vat_paid_on_purchases, 2))
    vat_refund_credit = max(0.0, round(vat_paid_on_purchases - vat_collected, 2))

    # 2. Calculate profit and estimated Corporate Income Tax (Körperschaftsteuer + Gewerbesteuer)
    total_sales_net = sum(
        inv.amount for inv in ctx.invoices
        if inv.type == "receivable" and inv.currency.upper() == "EUR"
    )
    business_expenses_net = sum(
        inv.amount for inv in ctx.invoices
        if inv.type == "payable" and inv.currency.upper() == "EUR" and inv.category != "entertainment"
    )
    # Include regular monthly operating costs (e.g., salaries, rent from burn rate)
    estimated_profit = max(0.0, total_sales_net - business_expenses_net - (ctx.monthly_burn_rate_eur * 0.6))

    # Standard combined German corporate tax rate is ~30% (or uses ctx.cit_rate if customized above 15%)
    effective_tax_rate = ctx.cit_rate if ctx.cit_rate >= 0.15 else 0.30
    corporate_tax_to_set_aside = round(estimated_profit * effective_tax_rate, 2)

    total_tax_to_set_aside = round(vat_to_pay + corporate_tax_to_set_aside, 2)

    # 3. Calculate days left until the German Tax Office (Finanzamt) deadline (10th of the month)
    days_to_finanzamt_deadline = 10 - ctx.day_of_month if ctx.day_of_month <= 10 else (30 - ctx.day_of_month + 10)

    recommendations: List[Dict[str, Any]] = []
    potential_tax_savings_eur = 0.0
    status = "OPTIMAL"

    # Reminder to set aside cash so the business is never surprised by a tax bill
    if total_tax_to_set_aside > 0:
        status = "ACTION_REQUIRED"
        tax_to_cash_ratio = total_tax_to_set_aside / ctx.cash_balance_eur if ctx.cash_balance_eur > 0 else 1.0
        recommendations.append({
            "type": "TAX_SAVINGS_RESERVE",
            "priority": "HIGH" if days_to_finanzamt_deadline <= 5 or tax_to_cash_ratio > 0.35 else "MEDIUM",
            "title": "Set aside money for your upcoming German tax bill",
            "amount_eur": total_tax_to_set_aside,
            "details": (
                f"You should keep {total_tax_to_set_aside:,.2f} EUR safe for the tax office (Finanzamt). "
                f"This covers {vat_to_pay:,.2f} EUR in VAT due in {days_to_finanzamt_deadline} days (on the 10th of the month) "
                f"plus {corporate_tax_to_set_aside:,.2f} EUR saved for your profit tax."
            ),
        })

    # 4. MONEY-SAVER 1: German Research & Tech Grant (Forschungszulage)
    rd_categories = {"it", "r&d", "software", "engineering", "research", "tech"}
    rd_expenses = sum(
        inv.amount for inv in ctx.invoices
        if inv.type == "payable" and inv.category and inv.category.lower() in rd_categories
    )
    if rd_expenses > 0:
        # Under Germany's Forschungszulage, companies can get 25% of qualifying tech/R&D costs back from the tax office
        rd_cash_back = round(rd_expenses * 0.25, 2)
        potential_tax_savings_eur += rd_cash_back
        if status == "OPTIMAL":
            status = "OPPORTUNITY_FOUND"
        recommendations.append({
            "type": "GERMAN_RD_TAX_GRANT",
            "priority": "HIGH",
            "title": "Claim up to 25% cash back on your tech and software work",
            "potential_saving_eur": rd_cash_back,
            "details": (
                f"You spent {rd_expenses:,.2f} EUR on software and development. "
                f"Under the German Research Allowance (Forschungszulage), you can claim back up to "
                f"{rd_cash_back:,.2f} EUR directly from your tax bill."
            ),
        })

    # 5. MONEY-SAVER 2: Unpaid Customer Invoices (VAT Refund on Bad Debt)
    unpaid_overdue_invoices = [
        inv for inv in ctx.invoices
        if inv.type == "receivable" and not inv.is_paid and inv.due_in_days <= -60
    ]
    if unpaid_overdue_invoices:
        overdue_net = sum(inv.amount for inv in unpaid_overdue_invoices)
        overdue_vat = sum(inv.amount * inv.vat_rate for inv in unpaid_overdue_invoices)
        corporate_tax_reduction = round(overdue_net * effective_tax_rate, 2)
        total_recovery = round(overdue_vat + corporate_tax_reduction, 2)
        potential_tax_savings_eur += total_recovery
        status = "ACTION_REQUIRED"
        recommendations.append({
            "type": "UNPAID_INVOICE_TAX_REFUND",
            "priority": "HIGH",
            "title": f"Get back taxes you already paid on {len(unpaid_overdue_invoices)} unpaid customer bill(s)",
            "potential_saving_eur": total_recovery,
            "details": (
                f"Customers still owe you {overdue_net:,.2f} EUR (over 60 days late). "
                f"In Germany, you do not have to lose the tax you already paid on uncollectible bills—you can reclaim "
                f"{overdue_vat:,.2f} EUR in VAT and reduce your profit tax by {corporate_tax_reduction:,.2f} EUR."
            ),
        })

    # 6. MONEY-SAVER 3: Smart Reinvestment Deduction (Investitionsabzugsbetrag - IAB)
    if estimated_profit > 15000 and corporate_tax_to_set_aside > 2000:
        iab_tax_saving = round(corporate_tax_to_set_aside * 0.40, 2)
        potential_tax_savings_eur += iab_tax_saving
        recommendations.append({
            "type": "EQUIPMENT_INVESTMENT_DEDUCTION",
            "priority": "MEDIUM",
            "title": "Lower this year's tax bill if you plan to buy new equipment",
            "potential_saving_eur": iab_tax_saving,
            "details": (
                f"If you plan to buy laptops, machinery, or vehicles for your business in the next 3 years, "
                f"German tax rules (IAB) let you deduct 50% of the planned cost right now—saving you around "
                f"{iab_tax_saving:,.2f} EUR in taxes today."
            ),
        })

    metrics = {
        "currency": "EUR",
        "vat_collected_eur": round(vat_collected, 2),
        "vat_paid_on_purchases_eur": round(vat_paid_on_purchases, 2),
        "vat_to_pay_eur": vat_to_pay,
        "vat_refund_credit_eur": vat_refund_credit,
        "corporate_tax_reserve_eur": corporate_tax_to_set_aside,
        "total_tax_to_set_aside_eur": total_tax_to_set_aside,
        "days_to_finanzamt_deadline": days_to_finanzamt_deadline,
        "potential_tax_savings_eur": round(potential_tax_savings_eur, 2),
    }

    prompt_context = (
        f"[GERMAN TAX AGENT] Status: {status}. "
        f"VAT owed to Finanzamt (due on the 10th, in {days_to_finanzamt_deadline} days): {vat_to_pay} EUR. "
        f"Profit tax to keep aside: {corporate_tax_to_set_aside} EUR. "
        f"Total cash to set aside for taxes: {total_tax_to_set_aside} EUR. "
        f"Extra tax savings found: {round(potential_tax_savings_eur, 2)} EUR."
    )

    return ToolOutput(
        agent_name="TaxAgent",
        status=status,
        metrics=metrics,
        recommendations=recommendations,
        prompt_context=prompt_context,
    )