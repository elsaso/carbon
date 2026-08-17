/**
 * Sales-side posting-time tax resolution for one invoice line.
 *
 * Pure — no DB, no I/O, no clock — so `deno test` can pin every branch. The
 * driver (`index.ts`) does all the impure work (loading the line's tax code
 * components, the customer's exemption row, the company's `shippingIsTaxable`
 * setting) and hands the values in; this decides *what* should be posted.
 *
 * All tax math is delegated to `../shared/resolve-taxes.ts` (`splitLineTax`) —
 * the single authority shared with the purchase and memo posting paths, and the
 * twin of the app-side determination math. Nothing here re-derives a rate.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT: a line with no tax code, no tax
 * percent, a taxable item and a non-exempt customer must produce **zero**
 * postings and **zero** ledger rows, so that a company with no tax
 * configuration posts byte-identically to the pre-tax-feature code. Every early
 * return below is written to make that observable at a glance.
 */

import {
  splitLineTax,
  type EffectiveTaxComponent,
} from "../shared/resolve-taxes.ts";

/**
 * One output-tax credit: enough to write both a `journalLine` and a `taxLedger`
 * row. Amounts are already in **base currency** (the document amount multiplied
 * by the invoice's exchange rate), because that is what `journalLine.amount`
 * and the tax subledger are denominated in.
 */
export type SalesLineTaxPosting = {
  /** `taxCodeComponent.id`, or null on the legacy flat-`taxPercent` path. */
  componentId: string | null;
  /** The code the component came from, or null on the legacy path. */
  taxCodeId: string | null;
  /** Snapshot of the component name at posting time. */
  componentName: string;
  taxAuthorityId: string | null;
  /** Fraction (0.09975 = 9.975%), snapshotted at posting time. */
  rate: number;
  /** Component-level account override; the driver falls back to the default. */
  salesTaxAccountId: string | null;
  /**
   * The base the rate was applied to, in base currency. For a compound
   * component this is the line base *plus prior-sequence tax* — i.e. exactly
   * what the rate multiplied, which is what a tax return wants to see.
   */
  taxableAmountBase: number;
  taxAmountBase: number;
};

/** Why a line produced an exempt (zero-tax) ledger row. */
export type SalesLineTaxExemptReason = "customer" | "item" | "zero-rated";

export type SalesLineTax = {
  /** Empty when the line is untaxed — the driver then emits nothing. */
  postings: SalesLineTaxPosting[];
  /**
   * Sum of `postings[].taxAmountBase`, summed in array order. The driver
   * subtracts exactly this number from the revenue credit and pushes exactly
   * these component amounts, so the entry balances to the last bit even in
   * IEEE-754.
   */
  totalTaxBase: number;
  /** The line's taxable base in base currency (before any compounding). */
  taxableBaseAmount: number;
  /** The tax code actually applied (null on the legacy / untaxed path). */
  resolvedTaxCodeId: string | null;
  /**
   * Set only when a *configured* condition fired: an exempt customer, a
   * non-taxable item, or an assigned code that produced no tax. Never set for a
   * plain unconfigured line — see the invariant in the file header.
   */
  exempt: { exemptAmountBase: number; reason: SalesLineTaxExemptReason } | null;
};

export function resolveSalesLineTax(args: {
  /** Line quantity × unit price + line shipping + add-on, document currency. */
  preTaxLineCost: number;
  /** This line's share of the header shipping cost, document currency. */
  lineWeightedShippingCost: number;
  /** `companySettings.shippingIsTaxable` — default false preserves today. */
  shippingIsTaxable: boolean;
  /** `salesInvoiceLine.taxCodeId`, already validated against the company. */
  taxCodeId: string | null;
  /** Components of that code (unfiltered — `splitLineTax` filters by date). */
  components: EffectiveTaxComponent[];
  /** `salesInvoiceLine.taxPercent` — the legacy flat rate. */
  legacyTaxPercent: number;
  /** Posting date; drives component effective/expiration filtering. */
  date: string;
  /** `salesInvoice.exchangeRate` (1 for base-currency invoices). */
  exchangeRate: number;
  /** `customerTax.taxExempt`. */
  customerIsTaxExempt: boolean;
  /** `item.taxable` (defaults true — the column's own default). */
  itemIsTaxable: boolean;
}): SalesLineTax {
  const {
    preTaxLineCost,
    lineWeightedShippingCost,
    shippingIsTaxable,
    taxCodeId,
    components,
    legacyTaxPercent,
    date,
    exchangeRate,
    customerIsTaxExempt,
    itemIsTaxable,
  } = args;

  // Header shipping is untaxed today (it is excluded from the invoice view's
  // tax basis as well). The setting is gated strictly: false — the default, and
  // the value every existing company has — reproduces today's basis exactly.
  const taxableBase =
    preTaxLineCost + (shippingIsTaxable ? lineWeightedShippingCost : 0);
  const taxableBaseAmount = taxableBase * exchangeRate;

  // Exemption short-circuits determination entirely (spec: "customerTax.taxExempt
  // short-circuits determination"). No tax is posted even if the line still
  // carries a stale taxPercent — which keeps the GL identical to today, since
  // today's revenue credit already absorbs that amount.
  if (customerIsTaxExempt || !itemIsTaxable) {
    return {
      postings: [],
      totalTaxBase: 0,
      taxableBaseAmount,
      resolvedTaxCodeId: taxCodeId,
      exempt: {
        exemptAmountBase: taxableBaseAmount,
        reason: customerIsTaxExempt ? "customer" : "item",
      },
    };
  }

  const { componentTaxes } = splitLineTax({
    taxableBase,
    taxCodeId,
    components,
    legacyTaxPercent,
    date,
  });

  if (componentTaxes.length === 0) {
    // Nothing to post. This is a zero-rated line ONLY if a tax code was
    // deliberately assigned and the line carries no legacy percent. A line with
    // a code whose components produced nothing while `taxPercent > 0` is a
    // configuration mismatch: we emit no ledger row rather than claim an exempt
    // base the document does not have. And an unconfigured line (no code, no
    // percent) emits nothing at all — the zero-config invariant.
    const isZeroRated = taxCodeId !== null && legacyTaxPercent === 0;
    return {
      postings: [],
      totalTaxBase: 0,
      taxableBaseAmount,
      resolvedTaxCodeId: taxCodeId,
      exempt: isZeroRated
        ? { exemptAmountBase: taxableBaseAmount, reason: "zero-rated" }
        : null,
    };
  }

  const postings: SalesLineTaxPosting[] = componentTaxes.map((componentTax) => ({
    componentId: componentTax.componentId,
    taxCodeId: componentTax.componentId === null ? null : taxCodeId,
    componentName: componentTax.name,
    taxAuthorityId: componentTax.taxAuthorityId,
    rate: componentTax.rate,
    salesTaxAccountId: componentTax.salesTaxAccountId,
    taxableAmountBase: componentTax.base * exchangeRate,
    taxAmountBase: componentTax.tax * exchangeRate,
  }));

  return {
    postings,
    totalTaxBase: postings.reduce(
      (total, posting) => total + posting.taxAmountBase,
      0
    ),
    taxableBaseAmount,
    resolvedTaxCodeId: taxCodeId,
    exempt: null,
  };
}
