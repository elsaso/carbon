import {
  assertAlmostEquals,
  assertEquals,
} from "https://deno.land/std@0.175.0/testing/asserts.ts";
import {
  computeComponentTaxes,
  filterEffectiveComponents,
  roundCurrency,
  splitLineTax,
  type EffectiveTaxComponent,
} from "./resolve-taxes.ts";

// Fixtures mirror the spec's driving cases: Quebec (GST + QST, both applied to
// the sale price since 2013), a historical compound PST stacked on GST, and the
// Texas rate change used as the effective-date acceptance criterion.

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

// ---------------------------------------------------------------------------
// roundCurrency
// ---------------------------------------------------------------------------

Deno.test("roundCurrency rounds half away from zero", () => {
  assertEquals(roundCurrency(2.345), 2.35);
  assertEquals(roundCurrency(-2.345), -2.35);
  assertEquals(roundCurrency(2.344), 2.34);
  assertEquals(roundCurrency(-2.344), -2.34);
});

Deno.test("roundCurrency survives the classic float traps", () => {
  // 1.005 * 100 is 100.49999999999999 in IEEE-754; a bare Math.round gives 1.00.
  assertEquals(roundCurrency(1.005), 1.01);
  assertEquals(roundCurrency(1.015), 1.02);
  assertEquals(roundCurrency(2.675), 2.68);
  assertEquals(roundCurrency(8.005), 8.01);
  assertEquals(roundCurrency(0.615), 0.62);
  // ...without dragging values that are genuinely below the half up with them.
  assertEquals(roundCurrency(1.0049), 1);
  assertEquals(roundCurrency(2.674), 2.67);
});

Deno.test("roundCurrency honors a non-default precision and never returns -0", () => {
  assertEquals(roundCurrency(0.0997512, 4), 0.0998);
  assertEquals(roundCurrency(2.5, 0), 3);
  assertEquals(roundCurrency(0), 0);
  assertEquals(Object.is(roundCurrency(-0.001), 0), true);
});

// ---------------------------------------------------------------------------
// filterEffectiveComponents
// ---------------------------------------------------------------------------

Deno.test("filterEffectiveComponents keeps open-ended components and sorts by sequence", () => {
  const effective = filterEffectiveComponents([qst, gst], "2026-08-16");
  assertEquals(
    effective.map((c) => c.id),
    ["gst", "qst"]
  );
});

Deno.test("filterEffectiveComponents excludes components that are not yet in force", () => {
  const future = component({ id: "future", effectiveDate: "2026-09-01" });
  assertEquals(filterEffectiveComponents([future], "2026-08-31"), []);
  assertEquals(
    filterEffectiveComponents([future], "2026-09-01").map((c) => c.id),
    ["future"]
  );
});

Deno.test("expirationDate is inclusive — the rate change lands on the successor's effective date", () => {
  // Spec acceptance criterion: a component expiring 2026-06-30 with a successor
  // effective 2026-07-01 => June 30 computes 8.25%, July 1 computes 8.5%.
  const oldRate = component({
    id: "tx-old",
    name: "TX State",
    rate: 0.0825,
    expirationDate: "2026-06-30",
  });
  const newRate = component({
    id: "tx-new",
    name: "TX State",
    rate: 0.085,
    effectiveDate: "2026-07-01",
  });
  const components = [oldRate, newRate];

  const june30 = filterEffectiveComponents(components, "2026-06-30");
  assertEquals(june30.map((c) => c.id), ["tx-old"]);
  assertEquals(june30[0].rate, 0.0825);

  const july1 = filterEffectiveComponents(components, "2026-07-01");
  assertEquals(july1.map((c) => c.id), ["tx-new"]);
  assertEquals(july1[0].rate, 0.085);

  // ...and through the whole split: 8.25 on June 30, 8.50 on July 1.
  assertEquals(
    splitLineTax({
      taxableBase: 100,
      taxCodeId: "tx-austin",
      components,
      legacyTaxPercent: 0,
      date: "2026-06-30",
    }).totalTax,
    8.25
  );
  assertEquals(
    splitLineTax({
      taxableBase: 100,
      taxCodeId: "tx-austin",
      components,
      legacyTaxPercent: 0,
      date: "2026-07-01",
    }).totalTax,
    8.5
  );
});

// ---------------------------------------------------------------------------
// computeComponentTaxes
// ---------------------------------------------------------------------------

Deno.test("computeComponentTaxes applies non-compound rates to the line base, unrounded", () => {
  const taxes = computeComponentTaxes(100, [gst, qst]);
  assertEquals(taxes.length, 2);
  assertEquals(taxes[0], { componentId: "gst", base: 100, tax: 5 });
  assertEquals(taxes[1].base, 100);
  assertAlmostEquals(taxes[1].tax, 9.975, 1e-9);
});

Deno.test("computeComponentTaxes stacks a compound component on prior-sequence taxes", () => {
  const base = component({ id: "gst", rate: 0.05, sequence: 1 });
  const compoundPst = component({
    id: "pst",
    rate: 0.07,
    sequence: 2,
    isCompound: true,
  });
  const taxes = computeComponentTaxes(100, [base, compoundPst]);
  assertEquals(taxes[0], { componentId: "gst", base: 100, tax: 5 });
  assertEquals(taxes[1].base, 105);
  assertAlmostEquals(taxes[1].tax, 7.35, 1e-9);
});

Deno.test("computeComponentTaxes returns nothing for no components", () => {
  assertEquals(computeComponentTaxes(100, []), []);
});

// ---------------------------------------------------------------------------
// splitLineTax
// ---------------------------------------------------------------------------

Deno.test("QC: GST 5% + QST 9.975% on 100 splits 5.00 / 9.98", () => {
  const { componentTaxes, totalTax } = splitLineTax({
    taxableBase: 100,
    taxCodeId: "qc",
    components: [gst, qst],
    legacyTaxPercent: 0,
    date: "2026-08-16",
  });

  assertEquals(componentTaxes.length, 2);
  assertEquals(componentTaxes[0].componentId, "gst");
  assertEquals(componentTaxes[0].name, "GST");
  assertEquals(componentTaxes[0].taxAuthorityId, "cra");
  assertEquals(componentTaxes[0].base, 100);
  assertEquals(componentTaxes[0].tax, 5);
  assertEquals(componentTaxes[1].componentId, "qst");
  assertEquals(componentTaxes[1].taxAuthorityId, "rq");
  assertEquals(componentTaxes[1].base, 100);
  assertEquals(componentTaxes[1].tax, 9.98); // 9.975 rounded half-up
  // Total is the sum of the ROUNDED components, so the journal lines add up.
  assertEquals(totalTax, 14.98);
});

Deno.test("compound: 5% + 7%-compound on 100 splits 5.00 / 7.35", () => {
  const gstBase = component({ id: "gst", name: "GST", rate: 0.05, sequence: 1 });
  const compoundPst = component({
    id: "pst",
    name: "PST",
    rate: 0.07,
    sequence: 2,
    isCompound: true,
  });

  const { componentTaxes, totalTax } = splitLineTax({
    taxableBase: 100,
    taxCodeId: "legacy-compound",
    components: [gstBase, compoundPst],
    legacyTaxPercent: 0,
    date: "2026-08-16",
  });

  assertEquals(componentTaxes.map((c) => c.tax), [5, 7.35]);
  assertEquals(componentTaxes[1].base, 105);
  assertEquals(totalTax, 12.35);
});

Deno.test("compound ordering follows sequence, not array order", () => {
  const gstBase = component({ id: "gst", name: "GST", rate: 0.05, sequence: 1 });
  const compoundPst = component({
    id: "pst",
    name: "PST",
    rate: 0.07,
    sequence: 2,
    isCompound: true,
  });

  // Shuffled input: the compound row arrives first.
  const { componentTaxes, totalTax } = splitLineTax({
    taxableBase: 100,
    taxCodeId: "legacy-compound",
    components: [compoundPst, gstBase],
    legacyTaxPercent: 0,
    date: "2026-08-16",
  });

  assertEquals(
    componentTaxes.map((c) => c.componentId),
    ["gst", "pst"]
  );
  assertEquals(componentTaxes[1].base, 105);
  assertEquals(totalTax, 12.35);
});

Deno.test("legacy: no tax code falls back to a single flat pseudo-component", () => {
  const { componentTaxes, totalTax } = splitLineTax({
    taxableBase: 100,
    taxCodeId: null,
    components: [],
    legacyTaxPercent: 0.0825,
    date: "2026-08-16",
  });

  assertEquals(componentTaxes.length, 1);
  assertEquals(componentTaxes[0], {
    componentId: null,
    name: "Tax",
    taxAuthorityId: null,
    rate: 0.0825,
    base: 100,
    tax: 8.25,
    isRecoverable: false,
    salesTaxAccountId: null,
    purchaseTaxAccountId: null,
  });
  assertEquals(totalTax, 8.25);
});

Deno.test("legacy: components present but no tax code are ignored", () => {
  const { componentTaxes, totalTax } = splitLineTax({
    taxableBase: 100,
    taxCodeId: null,
    components: [gst, qst],
    legacyTaxPercent: 0.0825,
    date: "2026-08-16",
  });

  assertEquals(componentTaxes.length, 1);
  assertEquals(componentTaxes[0].componentId, null);
  assertEquals(totalTax, 8.25);
});

Deno.test("zero tax: no code and no legacy percent yields an empty split", () => {
  assertEquals(
    splitLineTax({
      taxableBase: 100,
      taxCodeId: null,
      components: [],
      legacyTaxPercent: 0,
      date: "2026-08-16",
    }),
    { componentTaxes: [], totalTax: 0 }
  );
});

Deno.test("zero tax: a zero-rated code emits no component lines", () => {
  const zeroRated = component({ id: "zr", name: "Zero-Rated", rate: 0 });
  assertEquals(
    splitLineTax({
      taxableBase: 100,
      taxCodeId: "zero-rated",
      components: [zeroRated],
      legacyTaxPercent: 0,
      date: "2026-08-16",
    }),
    { componentTaxes: [], totalTax: 0 }
  );
});

Deno.test("zero tax: a code whose components have all expired emits nothing", () => {
  const expired = component({
    id: "old",
    rate: 0.0825,
    expirationDate: "2026-06-30",
  });
  assertEquals(
    splitLineTax({
      taxableBase: 100,
      taxCodeId: "tx-austin",
      components: [expired],
      legacyTaxPercent: 0,
      date: "2026-07-01",
    }),
    { componentTaxes: [], totalTax: 0 }
  );
});

Deno.test("credit memo: a negative base produces negative tax on both paths", () => {
  const coded = splitLineTax({
    taxableBase: -100,
    taxCodeId: "qc",
    components: [gst, qst],
    legacyTaxPercent: 0,
    date: "2026-08-16",
  });
  assertEquals(coded.componentTaxes.map((c) => c.tax), [-5, -9.98]);
  assertEquals(coded.totalTax, -14.98);

  const legacy = splitLineTax({
    taxableBase: -100,
    taxCodeId: null,
    components: [],
    legacyTaxPercent: 0.0825,
    date: "2026-08-16",
  });
  assertEquals(legacy.totalTax, -8.25);
});

Deno.test("component fields are carried through for the journal + taxLedger writer", () => {
  const recoverable = component({
    id: "vat",
    name: "VAT",
    taxAuthorityId: "hmrc",
    rate: 0.2,
    isRecoverable: true,
    salesTaxAccountId: "acc-sales",
    purchaseTaxAccountId: "acc-purchase",
  });

  const { componentTaxes } = splitLineTax({
    taxableBase: 100,
    taxCodeId: "uk-standard",
    components: [recoverable],
    legacyTaxPercent: 0,
    date: "2026-08-16",
  });

  assertEquals(componentTaxes[0], {
    componentId: "vat",
    name: "VAT",
    taxAuthorityId: "hmrc",
    rate: 0.2,
    base: 100,
    tax: 20,
    isRecoverable: true,
    salesTaxAccountId: "acc-sales",
    purchaseTaxAccountId: "acc-purchase",
  });
});

Deno.test("a timestamp posting date compares on its calendar day", () => {
  const expiring = component({
    id: "tx-old",
    rate: 0.0825,
    expirationDate: "2026-06-30",
  });
  assertEquals(
    filterEffectiveComponents([expiring], "2026-06-30T23:59:59.000Z").map(
      (c) => c.id
    ),
    ["tx-old"]
  );
  assertEquals(
    filterEffectiveComponents([expiring], "2026-07-01T00:00:00.000Z"),
    []
  );
});
