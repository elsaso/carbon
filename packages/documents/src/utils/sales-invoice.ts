import type { Database } from "@carbon/database";

export function getLineDescription(
  line: Database["public"]["Views"]["salesInvoiceLines"]["Row"]
) {
  switch (line?.invoiceLineType) {
    case "Fixed Asset":
      return (
        (line as any)?.assetReadableId ??
        (line as any)?.assetName ??
        "Fixed Asset"
      );
    case "Comment":
      return line?.description;
    default:
      return line?.itemReadableId;
  }
}

export function getLineDescriptionDetails(
  line: Database["public"]["Views"]["salesInvoiceLines"]["Row"]
) {
  switch (line?.invoiceLineType) {
    case "Fixed Asset":
      return line?.description;
    case "Comment":
    default:
      return line?.description ?? "";
  }
}

export function getLineSubtotal(
  line: Database["public"]["Views"]["salesInvoiceLines"]["Row"]
) {
  return (
    (line?.quantity ?? 0) * (line?.convertedUnitPrice ?? 0) +
    (line?.convertedAddOnCost ?? 0) +
    (line?.convertedNonTaxableAddOnCost ?? 0) +
    (line?.convertedShippingCost ?? 0)
  );
}

export function getLineTaxableSubtotal(
  line: Database["public"]["Views"]["salesInvoiceLines"]["Row"]
) {
  return (
    (line?.quantity ?? 0) * (line?.convertedUnitPrice ?? 0) +
    (line?.convertedAddOnCost ?? 0) +
    (line?.convertedShippingCost ?? 0)
  );
}

export function getLineTaxesAndFees(
  line: Database["public"]["Views"]["salesInvoiceLines"]["Row"]
) {
  const taxPercent = line.taxPercent ?? 0;
  const tax = getLineTaxableSubtotal(line) * taxPercent;
  const fees =
    (line.convertedAddOnCost ?? 0) +
    (line.convertedNonTaxableAddOnCost ?? 0) +
    (line.convertedShippingCost ?? 0);
  return tax + fees;
}

export function getLineTotal(
  line: Database["public"]["Views"]["salesInvoiceLines"]["Row"]
) {
  const taxPercent = line.taxPercent ?? 0;
  const tax = getLineTaxableSubtotal(line) * taxPercent;
  return getLineSubtotal(line) + tax;
}

export function getTotal(
  lines: Database["public"]["Views"]["salesInvoiceLines"]["Row"][],
  salesInvoice: Database["public"]["Views"]["salesInvoices"]["Row"],
  salesInvoiceShipment: Database["public"]["Tables"]["salesInvoiceShipment"]["Row"]
) {
  let total = 0;

  lines.forEach((line) => {
    total += getLineTotal(line);
  });

  return (
    total +
    (salesInvoiceShipment.shippingCost ?? 0) * (salesInvoice.exchangeRate ?? 1)
  );
}

/** One row of the document's tax breakdown: what a single authority component
 *  charged across every line that carries it. */
export type TaxSummaryRow = {
  name: string;
  /** Fraction (0.0625), formatted as a percent by the renderer. */
  rate: number;
  amount: number;
};

/** The component facts the summary needs, resolved for the document's date by
 *  the props builder — this module stays pure and does no I/O. */
export type TaxSummaryComponent = {
  taxCodeId: string;
  name: string;
  rate: number;
  isCompound: boolean;
  sequence: number;
};

/** The legacy row's name when a line carries a flat percent and no code. */
export const LEGACY_TAX_COMPONENT_NAME = "Tax";

/**
 * The per-component tax breakdown a compliant invoice has to show: a VAT/GST
 * invoice states each rate and its amount, not one merged "Tax" figure.
 *
 * Grouped by component NAME rather than id, so a rate change that expires one
 * component and adds its successor still reads as one line to the customer.
 *
 * Compound components are cascaded exactly as posting does — a compound
 * component charges on the base PLUS the tax of every earlier component — so
 * the rows here add up to what was actually posted rather than to a flat sum
 * of rate x base. Lines with no code fall back to their stored `taxPercent`
 * under a single "Tax" row, which is what legacy documents have always shown.
 */
export function getTaxSummaryByComponent(
  lines: Database["public"]["Views"]["salesInvoiceLines"]["Row"][],
  componentsByTaxCodeId: Record<string, TaxSummaryComponent[]>
): TaxSummaryRow[] {
  const rows = new Map<string, TaxSummaryRow>();

  const add = (name: string, rate: number, amount: number) => {
    if (amount === 0) return;
    const existing = rows.get(name);
    if (existing) {
      existing.amount += amount;
    } else {
      rows.set(name, { name, rate, amount });
    }
  };

  for (const line of lines) {
    const base = getLineTaxableSubtotal(line);
    if (base === 0) continue;

    const taxCodeId = (line as { taxCodeId?: string | null }).taxCodeId ?? null;
    const components = taxCodeId ? componentsByTaxCodeId[taxCodeId] : undefined;

    if (!components || components.length === 0) {
      // Legacy / manual line: one row at the stored flat percent.
      add(
        LEGACY_TAX_COMPONENT_NAME,
        line.taxPercent ?? 0,
        base * (line.taxPercent ?? 0)
      );
      continue;
    }

    let priorTax = 0;
    for (const component of [...components].sort(
      (a, b) => a.sequence - b.sequence
    )) {
      const componentBase = component.isCompound ? base + priorTax : base;
      const tax = componentBase * component.rate;
      priorTax += tax;
      add(component.name, component.rate, tax);
    }
  }

  return [...rows.values()];
}
