import {
  assertEquals,
} from "https://deno.land/std@0.175.0/testing/asserts.ts";
import { type EffectiveTaxComponent } from "../shared/resolve-taxes.ts";
import {
  emptyPurchaseLineTaxPlan,
  reconcileToStoredTaxAmount,
  resolvePurchaseLineTax,
} from "./purchase-invoice-tax.ts";

// The four-case matrix from the spec's "Corrected GL posting" table, worked on
// the same fixture throughout: a 10 × $10 line (ex-tax base 100) at 20%.
//
// The invariant every case is checked against:
//   costSide  = 100 + storedTaxAmount + costAdjustment
//   AP        = 100 + storedTaxAmount   (never touched by this module)
// so `costAdjustment` is the entire behavioral surface of the change.

const component = (
  overrides: Partial<EffectiveTaxComponent> = {}
): EffectiveTaxComponent => ({
  id: "tcc_1",
  name: "VAT",
  taxAuthorityId: "ta_1",
  rate: 0.2,
  sequence: 1,
  isCompound: false,
  isRecoverable: false,
  salesTaxAccountId: null,
  purchaseTaxAccountId: null,
  effectiveDate: null,
  expirationDate: null,
  ...overrides,
});

const DATE = "2026-08-17";

Deno.test("no tax code → empty plan, zero cost adjustment", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: null,
    calculationType: null,
    components: [component({ isRecoverable: true })],
    taxableBase: 100,
    storedTaxAmount: 20,
    date: DATE,
  });

  assertEquals(plan, emptyPurchaseLineTaxPlan());
  // Literal zero, so the driver's `costAdjustment === 0` fast path holds.
  assertEquals(Object.is(plan.costAdjustment, 0), true);
});

Deno.test("a code with no components → empty plan", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [],
    taxableBase: 100,
    storedTaxAmount: 20,
    date: DATE,
  });

  assertEquals(plan, emptyPurchaseLineTaxPlan());
});

Deno.test("a code whose components all expired → empty plan", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [
      component({ isRecoverable: true, expirationDate: "2026-06-30" }),
    ],
    taxableBase: 100,
    storedTaxAmount: 20,
    date: DATE,
  });

  assertEquals(plan, emptyPurchaseLineTaxPlan());
});

Deno.test("case 1: Normal + non-recoverable → capitalized, cost unchanged", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [component()],
    taxableBase: 100,
    storedTaxAmount: 20,
    date: DATE,
  });

  assertEquals(plan.costAdjustment, 0);
  assertEquals(Object.is(plan.costAdjustment, 0), true);
  assertEquals(plan.components.length, 1);
  assertEquals(plan.components[0].treatment, "Capitalized");
  assertEquals(plan.components[0].taxAmount, 20);
  assertEquals(plan.components[0].taxableAmount, 100);
  assertEquals(plan.components[0].postedToInputAccount, false);
});

Deno.test("case 2: Normal + recoverable → cost posts net of the tax", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [component({ isRecoverable: true })],
    taxableBase: 100,
    storedTaxAmount: 20,
    date: DATE,
  });

  assertEquals(plan.costAdjustment, -20);
  assertEquals(plan.components[0].treatment, "Recoverable");
  assertEquals(plan.components[0].postedToInputAccount, true);
});

Deno.test("case 3: Reverse Charge + recoverable → cost unchanged, paired legs", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Reverse Charge",
    // The supplier billed nothing: the notional comes off the ex-tax base.
    components: [component({ isRecoverable: true })],
    taxableBase: 100,
    storedTaxAmount: 0,
    date: DATE,
  });

  assertEquals(plan.isReverseCharge, true);
  assertEquals(plan.costAdjustment, 0);
  assertEquals(plan.components[0].treatment, "Reverse Charge Recoverable");
  assertEquals(plan.components[0].taxAmount, 20);
  assertEquals(plan.components[0].postedToInputAccount, true);
});

Deno.test("case 4: Reverse Charge + non-recoverable (use tax) → capitalizes", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Reverse Charge",
    components: [component()],
    taxableBase: 100,
    storedTaxAmount: 0,
    date: DATE,
  });

  assertEquals(plan.costAdjustment, 20);
  assertEquals(plan.components[0].treatment, "Reverse Charge Capitalized");
  assertEquals(plan.components[0].postedToInputAccount, false);
});

Deno.test("Reverse Charge is never reconciled against the stored tax amount", () => {
  // A stored 0 would scale a Normal code to nothing; reverse charge must still
  // self-assess the full notional.
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Reverse Charge",
    components: [component({ isRecoverable: true })],
    taxableBase: 100,
    storedTaxAmount: 0,
    date: DATE,
  });

  assertEquals(plan.components[0].taxAmount, 20);
});

Deno.test("mixed code: recoverable + non-recoverable split the stored total", () => {
  // TPS 5% recoverable + a 9.975% non-recoverable component on a 100 base.
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [
      component({ id: "tcc_gst", name: "TPS", rate: 0.05, isRecoverable: true }),
      component({ id: "tcc_pst", name: "TVQ", rate: 0.09975, sequence: 2 }),
    ],
    taxableBase: 100,
    storedTaxAmount: 14.98,
    date: DATE,
  });

  assertEquals(plan.components.map((c) => c.taxAmount), [5, 9.98]);
  // Only the recoverable half leaves cost; the TVQ stays capitalized.
  assertEquals(plan.costAdjustment, -5);
  assertEquals(plan.components[0].treatment, "Recoverable");
  assertEquals(plan.components[1].treatment, "Capitalized");
});

Deno.test("reconciliation: within tolerance keeps the recomputed components", () => {
  // Components sum to 20.00; the supplier billed 20.01 (1c apart < 2c).
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [component({ isRecoverable: true })],
    taxableBase: 100,
    storedTaxAmount: 20.01,
    date: DATE,
  });

  assertEquals(plan.components[0].taxAmount, 20);
  assertEquals(plan.costAdjustment, -20);
});

Deno.test("reconciliation: beyond tolerance scales to the supplier's total", () => {
  // Configured 20%, supplier billed 8.25% — their invoice wins.
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [component({ isRecoverable: true })],
    taxableBase: 100,
    storedTaxAmount: 8.25,
    date: DATE,
  });

  assertEquals(plan.components[0].taxAmount, 8.25);
  assertEquals(plan.costAdjustment, -8.25);
});

Deno.test("reconciliation: scaled components sum exactly to the stored total", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [
      component({ id: "a", name: "A", rate: 0.05, isRecoverable: true }),
      component({ id: "b", name: "B", rate: 0.09975, sequence: 2 }),
      component({ id: "c", name: "C", rate: 0.01, sequence: 3 }),
    ],
    taxableBase: 100,
    storedTaxAmount: 10,
    date: DATE,
  });

  const sum = plan.components.reduce((total, c) => total + c.taxAmount, 0);
  assertEquals(Math.round(sum * 100) / 100, 10);
});

Deno.test("reconciliation: supplier billed no tax under a Normal code → nothing posts", () => {
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [component({ isRecoverable: true })],
    taxableBase: 100,
    storedTaxAmount: 0,
    date: DATE,
  });

  // Never invent tax the supplier did not charge — and the cost path stays
  // byte-identical.
  assertEquals(plan, emptyPurchaseLineTaxPlan());
});

Deno.test("reconcileToStoredTaxAmount distributes the rounding residual", () => {
  const scaled = reconcileToStoredTaxAmount([1, 1, 1], 10);
  assertEquals(scaled.reduce((total, amount) => total + amount, 0), 10);
});

Deno.test("reconcileToStoredTaxAmount on an all-zero split stays zero", () => {
  assertEquals(reconcileToStoredTaxAmount([0, 0], 10), [0, 0]);
});

Deno.test("compound components reconcile against the stored total too", () => {
  // GST 5% then a compound 10% on (base + GST) = 5 + 10.5 = 15.50.
  const plan = resolvePurchaseLineTax({
    taxCodeId: "tc_1",
    calculationType: "Normal",
    components: [
      component({ id: "gst", name: "GST", rate: 0.05, isRecoverable: true }),
      component({
        id: "pst",
        name: "PST",
        rate: 0.1,
        sequence: 2,
        isCompound: true,
      }),
    ],
    taxableBase: 100,
    storedTaxAmount: 15.5,
    date: DATE,
  });

  assertEquals(plan.components.map((c) => c.taxAmount), [5, 10.5]);
  assertEquals(plan.components[1].taxableAmount, 105);
  assertEquals(plan.costAdjustment, -5);
});
