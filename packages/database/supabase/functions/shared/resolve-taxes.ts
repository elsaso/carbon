/**
 * Posting-time tax resolution: which components of a tax code apply on a given
 * document date, what each one is worth, and how a line's tax splits across
 * them.
 *
 * Pure — no DB, no I/O, no clock. Every input (the components, the taxable
 * base, the document date) is handed in by the caller, so this is
 * unit-testable with `deno test` and safe to call from inside a Kysely
 * transaction in the `post-*` functions.
 *
 * TWIN: the same math lives app-side in
 * `apps/erp/app/modules/accounting/accounting.utils.ts` (determination time,
 * for drafts and previews). **The two must stay line-for-line parallel** — a
 * change here is a change there. Determination and posting disagreeing is the
 * one failure this design cannot tolerate: the invoice would print one number
 * while the GL carried another.
 *
 * Input types are hand-written structural subsets rather than imports from
 * `../lib/types.ts`: it keeps the unit dependency-free (the generated types lag
 * a migration until the DB is rebuilt) and documents exactly which columns the
 * math reads.
 */

import { round } from "./precision.ts";

/**
 * The `taxCodeComponent` columns this math reads. `rate` is a fraction
 * (0.09975 = 9.975%), matching the 0..1 CHECK on the column. `effectiveDate` /
 * `expirationDate` are calendar dates (`YYYY-MM-DD`) or null for "always".
 */
export type EffectiveTaxComponent = {
  id: string;
  name: string;
  taxAuthorityId: string | null;
  rate: number;
  sequence: number;
  isCompound: boolean;
  isRecoverable: boolean;
  salesTaxAccountId: string | null;
  purchaseTaxAccountId: string | null;
  effectiveDate: string | null;
  expirationDate: string | null;
};

/**
 * Normalize a date-ish value to its calendar day. Postgres `DATE` columns
 * arrive as `YYYY-MM-DD`, but a posting date may arrive as a full ISO
 * timestamp; slicing both sides to the day makes the string comparisons below
 * safe (ISO date strings order lexicographically).
 */
const toDay = (value: string): string => value.slice(0, 10);

/**
 * Components in force on `date`, sorted by `sequence`.
 *
 * BOUNDARY: `effectiveDate` and `expirationDate` are both **inclusive** —
 * a component applies when `effectiveDate <= date <= expirationDate`. That is
 * the calendar convention the spec's acceptance criterion assumes: a component
 * with `expirationDate = 2026-06-30` whose successor is `effectiveDate =
 * 2026-07-01` must still be in force ON June 30 (8.25%) and gone on July 1
 * (8.5%). An exclusive upper bound would leave June 30 untaxed. A null bound is
 * open-ended in that direction.
 */
export function filterEffectiveComponents(
  components: EffectiveTaxComponent[],
  date: string
): EffectiveTaxComponent[] {
  const day = toDay(date);
  return components
    .filter((component) => {
      const from = component.effectiveDate;
      const to = component.expirationDate;
      if (from !== null && toDay(from) > day) return false;
      if (to !== null && day > toDay(to)) return false;
      return true;
    })
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Round to currency precision, half away from zero (the accounting
 * convention): 2.345 → 2.35 and -2.345 → -2.35.
 *
 * Delegates to `round` from `./precision.ts` — the numeric standard itself,
 * which `@carbon/utils` re-exports for the app-side twin, so both sides of the
 * determination/posting pair round through one implementation rather than two
 * lookalikes. `RoundingMode.HalfUp` is ties-away-from-zero, matching Postgres
 * `round()`, and its exponent-shift does a decimal round-trip: the classic
 * binary artifacts (1.005 → 1.01, 2.675 → 2.68) come out the way an accountant
 * wrote them without the epsilon nudge this used to scale by.
 *
 * The sign guard stays local: `round` can return -0, and a journal line or an
 * `assertEquals` should never see one.
 */
export function roundCurrency(amount: number, precision = 2): number {
  const rounded = round(amount, precision);
  return rounded === 0 ? 0 : rounded;
}

/**
 * Per-component tax on a taxable base. `components` are assumed already
 * effective-filtered and sequence-sorted (i.e. straight out of
 * `filterEffectiveComponents`).
 *
 * A normal component applies its rate to `taxableBase`. A compound component
 * (tax-on-tax, e.g. a historical PST stacked on GST) applies its rate to
 * `taxableBase` plus the tax of every **prior-sequence** component.
 *
 * No rounding happens here — the compound cascade runs at full precision and
 * rounding is applied exactly once per component, in `splitLineTax`.
 */
export function computeComponentTaxes(
  taxableBase: number,
  components: EffectiveTaxComponent[]
): { componentId: string; base: number; tax: number }[] {
  const result: { componentId: string; base: number; tax: number }[] = [];
  let priorTax = 0;

  for (const component of components) {
    const base = component.isCompound ? taxableBase + priorTax : taxableBase;
    const tax = base * component.rate;
    result.push({ componentId: component.id, base, tax });
    priorTax += tax;
  }

  return result;
}

/**
 * One posted tax amount: everything the caller needs to write a journal line
 * and a `taxLedger` row. `componentId` is null on the legacy path (a flat
 * `taxPercent` with no tax code), where the caller falls back to
 * `accountDefault.salesTaxPayableAccount` / `purchaseTaxPayableAccount`.
 */
export type ComponentTaxSplit = {
  componentId: string | null;
  name: string;
  taxAuthorityId: string | null;
  rate: number;
  base: number;
  tax: number;
  isRecoverable: boolean;
  salesTaxAccountId: string | null;
  purchaseTaxAccountId: string | null;
};

/** Name used for the legacy flat-`taxPercent` pseudo-component. */
const LEGACY_COMPONENT_NAME = "Tax";

/**
 * Split a line's tax across the components of its tax code.
 *
 * With a `taxCodeId`: keep the components effective on `date`, run the
 * (compound-aware) cascade, and round each component's tax half-up at currency
 * precision. `totalTax` is the sum of the **rounded** component amounts, so the
 * journal lines always add up to the posted total exactly.
 *
 * Without a tax code: the legacy path — a single pseudo-component at
 * `legacyTaxPercent` (the flat `customer.taxPercent`/`supplier.taxPercent`
 * copied onto the line), with no authority and no per-component accounts.
 *
 * A component whose rounded tax is 0 (a zero-rated code, or a sub-cent base) is
 * omitted so callers never emit zero-amount journal lines; zero-rated and
 * exempt reporting is written from the line's own exemption snapshot, not from
 * here. No tax at all therefore yields an empty split and `totalTax` 0.
 */
export function splitLineTax(args: {
  taxableBase: number;
  taxCodeId: string | null;
  components: EffectiveTaxComponent[];
  legacyTaxPercent: number;
  date: string;
}): { componentTaxes: ComponentTaxSplit[]; totalTax: number } {
  const { taxableBase, taxCodeId, components, legacyTaxPercent, date } = args;

  if (taxCodeId) {
    const effective = filterEffectiveComponents(components, date);
    const computed = computeComponentTaxes(taxableBase, effective);

    const componentTaxes = effective
      .map((component, index) => ({
        componentId: component.id,
        name: component.name,
        taxAuthorityId: component.taxAuthorityId,
        rate: component.rate,
        base: computed[index].base,
        tax: roundCurrency(computed[index].tax),
        isRecoverable: component.isRecoverable,
        salesTaxAccountId: component.salesTaxAccountId,
        purchaseTaxAccountId: component.purchaseTaxAccountId,
      }))
      .filter((componentTax) => componentTax.tax !== 0);

    return {
      componentTaxes,
      totalTax: componentTaxes.reduce((total, { tax }) => total + tax, 0),
    };
  }

  if (legacyTaxPercent > 0) {
    const tax = roundCurrency(taxableBase * legacyTaxPercent);
    if (tax !== 0) {
      return {
        componentTaxes: [
          {
            componentId: null,
            name: LEGACY_COMPONENT_NAME,
            taxAuthorityId: null,
            rate: legacyTaxPercent,
            base: taxableBase,
            tax,
            isRecoverable: false,
            salesTaxAccountId: null,
            purchaseTaxAccountId: null,
          },
        ],
        totalTax: tax,
      };
    }
  }

  return { componentTaxes: [], totalTax: 0 };
}
