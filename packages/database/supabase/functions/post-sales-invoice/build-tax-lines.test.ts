import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.175.0/testing/asserts.ts";
import type { EffectiveTaxComponent } from "../shared/resolve-taxes.ts";
import { resolveSalesLineTax } from "./build-tax-lines.ts";

// Fixtures mirror the spec's driving case: Quebec (GST 5% + QST 9.975%, both
// applied to the sale price since 2013).

const component = (
  overrides: Partial<EffectiveTaxComponent> = {}
): EffectiveTaxComponent => ({
  id: "cmp",
  name: "Tax",
  taxAuthorityId: null,
  rate: 0,
  sequence: 1,
  isCompound: false,
  isRecoverable: false,
  salesTaxAccountId: null,
  purchaseTaxAccountId: null,
  effectiveDate: null,
  expirationDate: null,
  ...overrides,
});

const gst = component({
  id: "gst",
  name: "GST",
  taxAuthorityId: "cra",
  rate: 0.05,
  sequence: 1,
});

const qst = component({
  id: "qst",
  name: "QST",
  taxAuthorityId: "rq",
  rate: 0.09975,
  sequence: 2,
});

const line = (
  overrides: Partial<Parameters<typeof resolveSalesLineTax>[0]> = {}
) =>
  resolveSalesLineTax({
    preTaxLineCost: 100,
    lineWeightedShippingCost: 0,
    shippingIsTaxable: false,
    taxCodeId: null,
    components: [],
    legacyTaxPercent: 0,
    date: "2026-08-17",
    exchangeRate: 1,
    customerIsTaxExempt: false,
    itemIsTaxable: true,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// The zero-config invariant — the reason this module exists
// ---------------------------------------------------------------------------

Deno.test("a line with no tax configuration emits nothing at all", () => {
  const result = line();
  assertEquals(result.postings, []);
  assertEquals(result.totalTaxBase, 0);
  assertEquals(result.exempt, null);
  assertEquals(result.resolvedTaxCodeId, null);
});

Deno.test("no configuration still reports the taxable base for the caller", () => {
  // The base is informational here; with no postings and no exempt row the
  // driver never reads it.
  assertEquals(line().taxableBaseAmount, 100);
});

// ---------------------------------------------------------------------------
// Quebec: the worked example from the spec
// ---------------------------------------------------------------------------

Deno.test("GST + QST on 100 splits into two rounded component credits", () => {
  const result = line({ taxCodeId: "qc", components: [gst, qst] });

  assertEquals(result.postings.length, 2);
  assertEquals(result.postings[0].componentName, "GST");
  assertEquals(result.postings[0].taxAmountBase, 5);
  assertEquals(result.postings[0].taxableAmountBase, 100);
  assertEquals(result.postings[0].taxAuthorityId, "cra");
  assertEquals(result.postings[0].rate, 0.05);
  assertEquals(result.postings[0].taxCodeId, "qc");
  assertEquals(result.postings[0].componentId, "gst");

  // 9.975 rounds half away from zero.
  assertEquals(result.postings[1].componentName, "QST");
  assertEquals(result.postings[1].taxAmountBase, 9.98);
  assertEquals(result.postings[1].taxableAmountBase, 100);

  assertEquals(result.totalTaxBase, 14.98);
  assertEquals(result.exempt, null);
});

Deno.test("totalTaxBase is bit-identical to the sum of the pushed credits", () => {
  // The driver subtracts totalTaxBase from the gross AR figure and pushes the
  // individual amounts; if these disagreed by one ulp the entry would not
  // balance. Same array, same order, so this must hold exactly.
  const result = line({
    preTaxLineCost: 133.33,
    taxCodeId: "qc",
    components: [gst, qst],
  });
  assertStrictEquals(
    result.postings.reduce((total, p) => total + p.taxAmountBase, 0),
    result.totalTaxBase
  );
});

Deno.test("a compound component is taxed on base plus prior-sequence tax", () => {
  const result = line({
    taxCodeId: "compound",
    components: [
      gst,
      component({ id: "pst", name: "PST", rate: 0.1, sequence: 2, isCompound: true }),
    ],
  });

  assertEquals(result.postings[1].taxableAmountBase, 105);
  assertEquals(result.postings[1].taxAmountBase, 10.5);
});

Deno.test("component effective dates are honored at the posting date", () => {
  const expired = component({
    id: "old",
    name: "Old",
    rate: 0.0825,
    expirationDate: "2026-06-30",
  });
  const current = component({
    id: "new",
    name: "New",
    rate: 0.085,
    sequence: 2,
    effectiveDate: "2026-07-01",
  });

  const before = line({
    taxCodeId: "tx",
    components: [expired, current],
    date: "2026-06-30",
  });
  assertEquals(before.postings.length, 1);
  assertEquals(before.postings[0].componentName, "Old");

  const after = line({
    taxCodeId: "tx",
    components: [expired, current],
    date: "2026-07-01",
  });
  assertEquals(after.postings.length, 1);
  assertEquals(after.postings[0].componentName, "New");
});

// ---------------------------------------------------------------------------
// Legacy flat taxPercent (no tax code) — OQ 1: same treatment, default account
// ---------------------------------------------------------------------------

Deno.test("a legacy taxPercent line posts one component with no code or authority", () => {
  const result = line({ legacyTaxPercent: 0.0825 });

  assertEquals(result.postings.length, 1);
  assertEquals(result.postings[0].componentId, null);
  assertEquals(result.postings[0].taxCodeId, null);
  assertEquals(result.postings[0].taxAuthorityId, null);
  assertEquals(result.postings[0].salesTaxAccountId, null);
  assertEquals(result.postings[0].componentName, "Tax");
  assertEquals(result.postings[0].taxAmountBase, 8.25);
  assertEquals(result.exempt, null);
});

Deno.test("a component account override is carried through for the driver", () => {
  const result = line({
    taxCodeId: "qc",
    components: [component({ id: "gst", name: "GST", rate: 0.05, salesTaxAccountId: "acct-1" })],
  });
  assertEquals(result.postings[0].salesTaxAccountId, "acct-1");
});

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

Deno.test("amounts are converted to base currency after per-line rounding", () => {
  const result = line({
    taxCodeId: "qc",
    components: [gst, qst],
    exchangeRate: 2,
  });

  assertEquals(result.taxableBaseAmount, 200);
  assertEquals(result.postings[0].taxAmountBase, 10);
  assertEquals(result.postings[0].taxableAmountBase, 200);
  assertEquals(result.postings[1].taxAmountBase, 19.96);
  assertEquals(result.totalTaxBase, 29.96);
});

// ---------------------------------------------------------------------------
// Shipping taxability (gated strictly; false is the shipped default)
// ---------------------------------------------------------------------------

Deno.test("weighted shipping is outside the taxable base by default", () => {
  const result = line({
    lineWeightedShippingCost: 50,
    taxCodeId: "qc",
    components: [gst],
  });
  assertEquals(result.taxableBaseAmount, 100);
  assertEquals(result.postings[0].taxAmountBase, 5);
});

Deno.test("weighted shipping joins the taxable base when the setting is on", () => {
  const result = line({
    lineWeightedShippingCost: 50,
    shippingIsTaxable: true,
    taxCodeId: "qc",
    components: [gst],
  });
  assertEquals(result.taxableBaseAmount, 150);
  assertEquals(result.postings[0].taxAmountBase, 7.5);
});

// ---------------------------------------------------------------------------
// Exemptions — the only paths that write a ledger row with no tax
// ---------------------------------------------------------------------------

Deno.test("an exempt customer posts no tax and records the exempt base", () => {
  const result = line({
    taxCodeId: "qc",
    components: [gst, qst],
    customerIsTaxExempt: true,
  });

  assertEquals(result.postings, []);
  assertEquals(result.totalTaxBase, 0);
  assertEquals(result.exempt, { exemptAmountBase: 100, reason: "customer" });
});

Deno.test("an exempt customer short-circuits even a stale legacy taxPercent", () => {
  // The GL is unchanged by this: today's revenue credit already absorbs that
  // tax, and we credit no liability, so revenue keeps the gross figure.
  const result = line({ legacyTaxPercent: 0.0825, customerIsTaxExempt: true });
  assertEquals(result.postings, []);
  assertEquals(result.exempt?.reason, "customer");
});

Deno.test("a non-taxable item records an exempt base with no exemption reason", () => {
  const result = line({
    taxCodeId: "qc",
    components: [gst],
    itemIsTaxable: false,
  });
  assertEquals(result.postings, []);
  assertEquals(result.exempt, { exemptAmountBase: 100, reason: "item" });
});

Deno.test("a zero-rated code records the exempt base", () => {
  const result = line({
    taxCodeId: "zero",
    components: [component({ id: "z", name: "Zero", rate: 0 })],
  });
  assertEquals(result.postings, []);
  assertEquals(result.exempt, { exemptAmountBase: 100, reason: "zero-rated" });
  assertEquals(result.resolvedTaxCodeId, "zero");
});

Deno.test("a code that yields no tax while the line carries a percent writes nothing", () => {
  // Configuration mismatch (the code's components expired, say, but the line
  // was priced with a rate). Claiming an exempt base would be a lie, and the
  // tax is already inside the revenue credit exactly as it is today.
  const result = line({ taxCodeId: "qc", components: [], legacyTaxPercent: 0.0825 });
  assertEquals(result.postings, []);
  assertEquals(result.totalTaxBase, 0);
  assertEquals(result.exempt, null);
});

Deno.test("customer exemption wins over a non-taxable item for the reason snapshot", () => {
  const result = line({ customerIsTaxExempt: true, itemIsTaxable: false });
  assertEquals(result.exempt?.reason, "customer");
});
