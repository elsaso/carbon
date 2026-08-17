/**
 * Purchase-side posting-time tax treatment: given a line's tax code, its
 * components and the tax the supplier actually billed, decide what each
 * component does to the general ledger and to inventory cost.
 *
 * Pure — no DB, no I/O, no clock — so it is unit-testable with `deno test` and
 * safe to call from inside the posting loop. The driver (`index.ts`) fetches the
 * code + components and owns every account id; this module only classifies and
 * reconciles amounts. All math is delegated to `../shared/resolve-taxes.ts`,
 * which is the single authority for the compound cascade and for rounding —
 * nothing here re-implements it.
 *
 * ## The four cases (spec: "Corrected GL posting")
 *
 * | Code / components                       | Cost              | GL legs added                        | AP     |
 * |-----------------------------------------|-------------------|--------------------------------------|--------|
 * | none, or `Normal` + all non-recoverable | gross (unchanged) | none                                 | gross  |
 * | `Normal` + recoverable component        | **net** of it     | DR input tax                         | gross  |
 * | `Reverse Charge` + recoverable          | unchanged         | DR input tax / CR reverse-charge     | net    |
 * | `Reverse Charge` + non-recoverable      | **plus** notional | CR reverse-charge (DR sits in cost)  | net    |
 *
 * Non-recoverable tax capitalizing into cost is the CORRECT treatment for US
 * purchase tax, not a bug — it is deliberately preserved bit-for-bit.
 *
 * ## Reconciliation
 *
 * The supplier's invoice is authoritative for the TOTAL tax on a `Normal` line
 * (`purchaseInvoiceLine.taxAmount`, a GENERATED column derived from
 * `supplierTaxAmount / exchangeRate`, therefore already base currency and NOT
 * writable). The components only say how that total splits across authorities.
 * So the recomputed component sum is compared against the stored total and, on
 * material drift, scaled to match it exactly. See `reconcileToStoredTaxAmount`.
 *
 * A `Reverse Charge` line is NOT reconciled: the supplier billed no tax at all
 * (`supplierTaxAmount = 0`), so the notional self-assessed tax is computed from
 * the components on the ex-tax base and there is nothing to reconcile against.
 * If a `Reverse Charge` line DOES carry a supplier tax amount the document is
 * mis-coded — the stored tax still capitalizes into the line cost (as it always
 * has) and the notional is self-assessed on top of it. Determination (PR-B)
 * should never produce that combination.
 */

import {
  roundCurrency,
  splitLineTax,
  type EffectiveTaxComponent,
} from "../shared/resolve-taxes.ts";

/** How a single component's tax lands in the GL. */
export type PurchaseTaxTreatment =
  /** Non-recoverable, `Normal`: already inside the line cost. No GL leg. */
  | "Capitalized"
  /** Recoverable, `Normal`: DR input tax, cost posts net. */
  | "Recoverable"
  /** `Reverse Charge` + recoverable: DR input tax / CR reverse-charge payable. */
  | "Reverse Charge Recoverable"
  /** `Reverse Charge` + non-recoverable (US use tax): CR reverse-charge payable, DR capitalized into cost. */
  | "Reverse Charge Capitalized";

/**
 * One component's posted tax on one line. Amounts are BASE currency (the same
 * units as `purchaseInvoiceLine.taxAmount`); the driver applies the document's
 * exchange-rate multiplier when it writes the journal leg, exactly as it does
 * for every other leg on the document.
 */
export type PurchaseComponentTax = {
  componentId: string | null;
  name: string;
  taxAuthorityId: string | null;
  rate: number;
  /** The base the rate applied to (compound components see prior tax too). */
  taxableAmount: number;
  taxAmount: number;
  isRecoverable: boolean;
  /** Component override for the input-tax account; null → `accountDefault`. */
  purchaseTaxAccountId: string | null;
  treatment: PurchaseTaxTreatment;
  /** `taxLedger.postedToInputAccount` — true when the tax became an asset. */
  postedToInputAccount: boolean;
};

export type PurchaseLineTaxPlan = {
  components: PurchaseComponentTax[];
  /**
   * Signed, base currency. ADD to the line's gross cost to get the cost that
   * should reach the debit legs, `costLedger.cost` and the inventory unit cost.
   *
   * Exactly `0` (the literal, never a computed near-zero) whenever the line has
   * no tax code and whenever every component is `Normal` + non-recoverable —
   * that is what makes those two paths byte-identical to the pre-tax behavior.
   */
  costAdjustment: number;
  isReverseCharge: boolean;
};

/**
 * Drift (base currency) we tolerate between the recomputed component sum and
 * the tax the supplier billed before rescaling. Two cents absorbs per-component
 * half-up rounding on a handful of components; anything larger means the
 * supplier used different rates than the configured code and their total wins.
 */
export const TAX_RECONCILIATION_TOLERANCE = 0.02;

/** A fresh no-tax plan. Fresh (not a shared constant) so callers can't alias it. */
export function emptyPurchaseLineTaxPlan(): PurchaseLineTaxPlan {
  return { components: [], costAdjustment: 0, isReverseCharge: false };
}

/**
 * Scale component amounts so they sum EXACTLY to the tax the supplier billed.
 *
 * Only invoked when the recomputed sum drifts by at least
 * `TAX_RECONCILIATION_TOLERANCE`. Each component is scaled by
 * `storedTaxAmount / computedSum` and re-rounded; the residual left by rounding
 * is dropped on the largest component so the split adds up to the cent.
 *
 * `storedTaxAmount = 0` (supplier billed no tax under a `Normal` code) scales
 * everything to zero — the posting must never invent tax the supplier did not
 * charge.
 */
export function reconcileToStoredTaxAmount(
  amounts: number[],
  storedTaxAmount: number
): number[] {
  const computedSum = amounts.reduce((total, amount) => total + amount, 0);
  if (computedSum === 0) return amounts.map(() => 0);

  const factor = storedTaxAmount / computedSum;
  const scaled = amounts.map((amount) => roundCurrency(amount * factor));

  const scaledSum = scaled.reduce((total, amount) => total + amount, 0);
  const residual = roundCurrency(storedTaxAmount - scaledSum);
  if (residual !== 0) {
    let largestIndex = 0;
    for (let index = 1; index < scaled.length; index++) {
      if (Math.abs(scaled[index]) > Math.abs(scaled[largestIndex])) {
        largestIndex = index;
      }
    }
    scaled[largestIndex] = roundCurrency(scaled[largestIndex] + residual);
  }

  return scaled;
}

export function resolvePurchaseLineTax(args: {
  /** `purchaseInvoiceLine.taxCodeId` — null on every legacy/unconfigured line. */
  taxCodeId: string | null;
  /** `taxCode.calculationType`; null when the code row could not be resolved. */
  calculationType: "Normal" | "Reverse Charge" | null;
  components: EffectiveTaxComponent[];
  /** Ex-tax line base: `quantity * unitPrice + shippingCost` (base currency). */
  taxableBase: number;
  /** `purchaseInvoiceLine.taxAmount` — already base currency (generated column). */
  storedTaxAmount: number;
  /** Tax point (the supplier's invoice date) — picks the effective components. */
  date: string;
}): PurchaseLineTaxPlan {
  const {
    taxCodeId,
    calculationType,
    components,
    taxableBase,
    storedTaxAmount,
    date,
  } = args;

  // No code → the legacy path. `splitLineTax`'s flat-`taxPercent` fallback is
  // deliberately NOT used here: on the purchase side the flat percent is
  // already baked into the generated `taxAmount` sitting inside the line cost,
  // and posting it again would double-count. Legacy lines keep capitalizing.
  if (!taxCodeId) return emptyPurchaseLineTaxPlan();

  const isReverseCharge = calculationType === "Reverse Charge";

  const { componentTaxes } = splitLineTax({
    taxableBase,
    taxCodeId,
    components,
    legacyTaxPercent: 0,
    date,
  });

  if (componentTaxes.length === 0) return emptyPurchaseLineTaxPlan();

  // RECONCILIATION: the supplier's invoice is authoritative for the total on a
  // `Normal` line; the components only split it. Within tolerance we keep the
  // recomputed amounts (they carry the per-authority precision); beyond it we
  // scale them to the supplier's total. Reverse charge is self-assessed, so
  // there is no supplier total to reconcile against.
  let amounts = componentTaxes.map((componentTax) => componentTax.tax);
  if (!isReverseCharge) {
    const computedSum = amounts.reduce((total, amount) => total + amount, 0);
    if (Math.abs(computedSum - storedTaxAmount) >= TAX_RECONCILIATION_TOLERANCE) {
      amounts = reconcileToStoredTaxAmount(amounts, storedTaxAmount);
    }
  }

  const planComponents: PurchaseComponentTax[] = [];
  let costAdjustment = 0;

  componentTaxes.forEach((componentTax, index) => {
    const taxAmount = amounts[index];
    // A component scaled to zero would only produce a zero-amount journal leg
    // and a zero-value ledger row; `splitLineTax` drops them for the same
    // reason, so reconciliation drops them too.
    if (taxAmount === 0) return;

    let treatment: PurchaseTaxTreatment;
    if (isReverseCharge) {
      if (componentTax.isRecoverable) {
        // EU acquisition: DR input tax / CR reverse-charge payable, netting to
        // zero. Cost and AP both untouched.
        treatment = "Reverse Charge Recoverable";
      } else {
        // US use tax: self-assessed and non-recoverable, so the debit side is
        // the goods themselves — capitalize it.
        treatment = "Reverse Charge Capitalized";
        costAdjustment += taxAmount;
      }
    } else if (componentTax.isRecoverable) {
      // The supplier charged it and we can reclaim it: pull it out of cost and
      // park it in the input-tax asset. AP still owes the supplier the gross.
      treatment = "Recoverable";
      costAdjustment -= taxAmount;
    } else {
      // Already inside `taxAmount`, already inside the line cost. Nothing to do
      // — this is the branch that must stay byte-identical to today.
      treatment = "Capitalized";
    }

    planComponents.push({
      componentId: componentTax.componentId,
      name: componentTax.name,
      taxAuthorityId: componentTax.taxAuthorityId,
      rate: componentTax.rate,
      taxableAmount: componentTax.base,
      taxAmount,
      isRecoverable: componentTax.isRecoverable,
      purchaseTaxAccountId: componentTax.purchaseTaxAccountId,
      treatment,
      postedToInputAccount:
        treatment === "Recoverable" ||
        treatment === "Reverse Charge Recoverable",
    });
  });

  if (planComponents.length === 0) return emptyPurchaseLineTaxPlan();

  return {
    components: planComponents,
    // Round once at the end: a mixed code can otherwise leave a sub-cent tail
    // that would make the cost side disagree with the sum of the legs.
    costAdjustment: costAdjustment === 0 ? 0 : roundCurrency(costAdjustment),
    isReverseCharge,
  };
}
