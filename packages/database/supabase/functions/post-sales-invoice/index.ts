import { serve } from "https://deno.land/std@0.175.0/http/server.ts";
import { format } from "https://deno.land/std@0.205.0/datetime/mod.ts";
import { nanoid } from "https://deno.land/x/nanoid@v3.0.0/mod.ts";
import z from "npm:zod@^3.24.1";
import { DB, getConnectionPool, getDatabaseClient } from "../lib/database.ts";
import { corsHeaders } from "../lib/headers.ts";
import { requirePermissions } from "../lib/supabase.ts";
import type { Database } from "../lib/types.ts";

import { credit, debit, journalReference } from "../lib/utils.ts";
import { getCurrentAccountingPeriod } from "../shared/get-accounting-period.ts";
import { getNextSequence } from "../shared/get-next-sequence.ts";
import {
  getDefaultPostingGroup,
  resolveInventoryAccount,
} from "../shared/get-posting-group.ts";
import { calculateCOGS } from "../shared/calculate-cogs.ts";
import type { EffectiveTaxComponent } from "../shared/resolve-taxes.ts";
import {
  resolveSalesLineTax,
  type SalesLineTax,
} from "./build-tax-lines.ts";

const pool = getConnectionPool(1);
const db = getDatabaseClient<DB>(pool);

const payloadValidator = z.object({
  type: z.enum(["post", "void"]).default("post"),
  invoiceId: z.string(),
  userId: z.string(),
  companyId: z.string(),
});

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const payload = await req.json();
  const today = format(new Date(), "yyyy-MM-dd");

  try {
    const { type, invoiceId, userId, companyId } =
      payloadValidator.parse(payload);

    console.log({
      function: "post-sales-invoice",
      type,
      invoiceId,
      userId,
      companyId,
    });

    const client = await requirePermissions(req, companyId, userId, { update: "invoicing" });

    const [companyRecord, accountingSettings] = await Promise.all([
      client
        .from("company")
        .select("companyGroupId")
        .eq("id", companyId)
        .single(),
      client
        .from("companySettings")
        .select("accountingEnabled, shippingIsTaxable")
        .eq("id", companyId)
        .single(),
    ]);
    if (companyRecord.error) throw new Error("Failed to fetch company");
    const companyGroupId = companyRecord.data.companyGroupId;
    const accountingEnabled = accountingSettings.data?.accountingEnabled ?? false;
    // Header shipping is outside the tax basis unless a company opts in. The
    // column defaults to FALSE, so every existing company keeps today's basis.
    const shippingIsTaxable =
      accountingSettings.data?.shippingIsTaxable ?? false;

    const [salesInvoice, salesInvoiceLines, salesInvoiceShipment] =
      await Promise.all([
        client.from("salesInvoice").select("*").eq("id", invoiceId).single(),
        client.from("salesInvoiceLine").select("*").eq("invoiceId", invoiceId),
        client
          .from("salesInvoiceShipment")
          .select("shippingCost, shippingMethodId")
          .eq("id", invoiceId)
          .single(),
      ]);

    if (salesInvoice.error) throw new Error("Failed to fetch salesInvoice");
    if (salesInvoiceLines.error)
      throw new Error("Failed to fetch shipment lines");
    if (salesInvoiceShipment.error)
      throw new Error("Failed to fetch sales invoice shipment");

    const shippingCost = salesInvoiceShipment.data?.shippingCost ?? 0;

    // Fetch sales order lines (needed by both post and void cases)
    const salesOrderLineIds = salesInvoiceLines.data.reduce<string[]>(
      (acc, invoiceLine) => {
        if (
          invoiceLine.salesOrderLineId &&
          !acc.includes(invoiceLine.salesOrderLineId)
        ) {
          acc.push(invoiceLine.salesOrderLineId);
        }
        return acc;
      },
      []
    );

    const { data: salesOrderLines } = await client
      .from("salesOrderLine")
      .select("*")
      .in("id", salesOrderLineIds);

    if (!salesOrderLines) {
      throw new Error("Failed to fetch sales order lines");
    }

    switch (type) {
      case "post": {
        // Pre-tax denominator for allocating the header shipping cost.
        // Comment lines post no journal entries, so they must not absorb a
        // share of the shipping (it would never reach the GL).
        const totalLinesCost = salesInvoiceLines.data.reduce(
          (acc, invoiceLine) => {
            if (invoiceLine.invoiceLineType === "Comment") return acc;
            const lineCost =
              (invoiceLine.quantity ?? 0) * (invoiceLine.unitPrice ?? 0) +
              (invoiceLine.shippingCost ?? 0) +
              (invoiceLine.addOnCost ?? 0);
            return acc + lineCost;
          },
          0
        );

        const postableLineCount = salesInvoiceLines.data.filter(
          (invoiceLine) => invoiceLine.invoiceLineType !== "Comment"
        ).length;

        const itemIds = salesInvoiceLines.data.reduce<string[]>(
          (acc, invoiceLine) => {
            if (invoiceLine.itemId && !acc.includes(invoiceLine.itemId)) {
              acc.push(invoiceLine.itemId);
            }
            return acc;
          },
          []
        );

        const [items, itemCosts, customer] = await Promise.all([
          client
            .from("item")
            .select("id, itemTrackingType, replenishmentSystem, taxable")
            .in("id", itemIds)
            .eq("companyId", companyId),
          client
            .from("itemCost")
            .select("itemId, itemPostingGroupId, costingMethod")
            .in("itemId", itemIds),
          client
            .from("customer")
            .select("*")
            .eq("id", salesInvoice.data.customerId ?? "")
            .eq("companyId", companyId)
            .single(),
        ]);
        if (items.error) throw new Error("Failed to fetch items");
        if (itemCosts.error) throw new Error("Failed to fetch item costs");
        if (customer.error) throw new Error("Failed to fetch customer");

        // Detect intercompany transaction
        const isIntercompany =
          customer.data.intercompanyCompanyId != null;
        const intercompanyPartnerId = isIntercompany
          ? customer.data.intercompanyCompanyId
          : null;

        const salesOrders = await client
          .from("salesOrder")
          .select("*")
          .in(
            "salesOrderId",
            salesOrderLines.reduce<string[]>((acc, salesOrderLine) => {
              if (
                salesOrderLine.salesOrderId &&
                !acc.includes(salesOrderLine.salesOrderId)
              ) {
                acc.push(salesOrderLine.salesOrderId);
              }
              return acc;
            }, [])
          )
          .eq("companyId", companyId);

        if (salesOrders.error) throw new Error("Failed to fetch sales orders");

        const journalLineInserts: Omit<
          Database["public"]["Tables"]["journalLine"]["Insert"],
          "journalId"
        >[] = [];

        const shipmentLineInserts: Omit<
          Database["public"]["Tables"]["shipmentLine"]["Insert"],
          "shipmentId"
        >[] = [];

        // Immutable tax subledger rows. Written inside the same transaction as
        // the journal (so `journalId` is known); independent of
        // `accountingEnabled`, because the tax liability report reads these rows
        // whether or not the company posts to a GL.
        const taxLedgerInserts: Omit<
          Database["public"]["Tables"]["taxLedger"]["Insert"],
          "journalId"
        >[] = [];

        const itemLedgerInserts: Database["public"]["Tables"]["itemLedger"]["Insert"][] =
          [];

        // Fixed-asset disposal state changes are deferred and applied inside the
        // same Kysely transaction as the journal posting, so a failure to update
        // the asset/disposal rows rolls the journals back instead of leaving the
        // ledger posted against a stale asset record.
        const fixedAssetDisposalUpdates: {
          disposalId: string;
          assetId: string;
          saleProceeds: number;
          gainLoss: number;
        }[] = [];

        const salesInvoiceLinesBySalesOrderLine = salesInvoiceLines.data.reduce<
          Record<
            string,
            Database["public"]["Tables"]["salesInvoiceLine"]["Row"]
          >
        >((acc, invoiceLine) => {
          if (invoiceLine.salesOrderLineId) {
            acc[invoiceLine.salesOrderLineId] = invoiceLine;
          }
          return acc;
        }, {});

        const salesOrderLineUpdates = salesOrderLines.reduce<
          Record<
            string,
            Database["public"]["Tables"]["salesOrderLine"]["Update"]
          >
        >((acc, salesOrderLine) => {
          const invoiceLine =
            salesInvoiceLinesBySalesOrderLine[salesOrderLine.id];
          if (
            invoiceLine &&
            invoiceLine.quantity &&
            salesOrderLine.saleQuantity &&
            salesOrderLine.saleQuantity > 0
          ) {
            const newQuantityInvoiced =
              (salesOrderLine.quantityInvoiced ?? 0) + invoiceLine.quantity;

            const invoicedComplete =
              newQuantityInvoiced >=
              (salesOrderLine.quantityToInvoice ?? salesOrderLine.saleQuantity);

            return {
              ...acc,
              [salesOrderLine.id]: {
                quantityInvoiced: newQuantityInvoiced,
                invoicedComplete,
                salesOrderId: salesOrderLine.salesOrderId,
              },
            };
          }

          return acc;
        }, {});

        // Get account defaults (once for all lines)
        const accountDefaults = accountingEnabled
          ? await getDefaultPostingGroup(client, companyId)
          : null;
        if (accountingEnabled && (accountDefaults?.error || !accountDefaults?.data)) {
          throw new Error("Error getting account defaults");
        }

        const dimensions = accountingEnabled
          ? await client
              .from("dimension")
              .select("id, entityType")
              .eq("companyGroupId", companyGroupId)
              .eq("active", true)
              .in("entityType", [
                "CustomerType",
                "ItemPostingGroup",
                "Location",
                "CostCenter",
                "FixedAssetClass",
                "Customer",
                "Item",
              ])
          : null;

        const dimensionMap = new Map<string, string>();
        if (dimensions?.data) {
          for (const dim of dimensions.data) {
            if (dim.entityType) dimensionMap.set(dim.entityType, dim.id);
          }
        }

        const journalLineDimensionsMeta: {
          customerTypeId: string | null;
          itemPostingGroupId: string | null;
          itemId: string | null;
          locationId: string | null;
          costCenterId: string | null;
          fixedAssetClassId: string | null;
        }[] = [];

        // For IC transactions, book to Inter-Company Receivables instead of
        // regular AR. Resolve it from accountDefault (stable id), not by account
        // number — numbers are user-editable. Fall back to regular receivables
        // if the IC default isn't configured.
        const icReceivablesAccount = (
          accountDefaults?.data as unknown as {
            intercompanyReceivablesAccount?: string | null;
          }
        )?.intercompanyReceivablesAccount;
        const receivablesAccountId: string | undefined =
          isIntercompany && icReceivablesAccount
            ? icReceivablesAccount
            : accountDefaults?.data?.receivablesAccount;

        // Invoice exchange rate (defaults to 1 for base-currency invoices).
        // journalLine.amount is denominated in base currency, so all monetary
        // amounts derived from the invoice's foreign-currency unitPrice etc.
        // must be multiplied by this rate before they reach a journal line.
        const invoiceExchangeRate = salesInvoice.data?.exchangeRate ?? 1;

        // Tax point = the DOCUMENT date, not the posting date. The spec's
        // acceptance criterion is "invoices DATED June 30 vs July 1 compute
        // 8.25% vs 8.5%", so effective-dated components are selected against
        // dateIssued; taxLedger.postingDate stays `today`. Must match the tax
        // point in post-purchase-invoice/index.ts or the two sides disagree at
        // a rate-change boundary.
        const taxPointDate = salesInvoice.data?.dateIssued ?? today;

        // ---------------------------------------------------------------
        // Tax configuration (multi-jurisdiction tax, Phase 1)
        //
        // Loaded once, outside the transaction, beside the account defaults.
        // A company with no tax codes on any line skips both config queries
        // entirely; the customer's exemption row is a single-row lookup that
        // only ever produces behavior when `taxExempt` is actually set.
        // ---------------------------------------------------------------
        const lineTaxCodeIds = salesInvoiceLines.data.reduce<string[]>(
          (acc, invoiceLine) => {
            if (invoiceLine.taxCodeId && !acc.includes(invoiceLine.taxCodeId)) {
              acc.push(invoiceLine.taxCodeId);
            }
            return acc;
          },
          []
        );

        const taxCodes =
          lineTaxCodeIds.length > 0
            ? await client
                .from("taxCode")
                .select("id, name, active")
                .eq("companyId", companyId)
                .in("id", lineTaxCodeIds)
            : null;
        if (taxCodes?.error) throw new Error("Failed to fetch tax codes");

        const taxCodeComponents =
          lineTaxCodeIds.length > 0
            ? await client
                .from("taxCodeComponent")
                .select("*")
                .eq("companyId", companyId)
                .in("taxCodeId", lineTaxCodeIds)
            : null;
        if (taxCodeComponents?.error)
          throw new Error("Failed to fetch tax code components");

        const customerTax = await client
          .from("customerTax")
          .select("taxExempt, taxExemptionReason, taxExemptionCertificateNumber")
          .eq("customerId", salesInvoice.data.customerId ?? "")
          .eq("companyId", companyId)
          .maybeSingle();
        // A read failure here must not be swallowed: silently treating an
        // exempt customer as taxable would post a liability they don't owe.
        if (customerTax.error)
          throw new Error("Failed to fetch customer tax settings");

        // Only active codes of THIS company resolve; anything else falls back to
        // the line's legacy flat `taxPercent`.
        const activeTaxCodeIds = new Set(
          (taxCodes?.data ?? [])
            .filter((taxCode) => taxCode.active)
            .map((taxCode) => taxCode.id)
        );

        const taxComponentsByCodeId = new Map<string, EffectiveTaxComponent[]>();
        for (const component of taxCodeComponents?.data ?? []) {
          const existing = taxComponentsByCodeId.get(component.taxCodeId) ?? [];
          existing.push({
            id: component.id,
            name: component.name,
            taxAuthorityId: component.taxAuthorityId,
            rate: Number(component.rate),
            sequence: component.sequence,
            isCompound: component.isCompound,
            isRecoverable: component.isRecoverable,
            salesTaxAccountId: component.salesTaxAccountId,
            purchaseTaxAccountId: component.purchaseTaxAccountId,
            effectiveDate: component.effectiveDate,
            expirationDate: component.expirationDate,
          });
          taxComponentsByCodeId.set(component.taxCodeId, existing);
        }

        const customerIsTaxExempt = customerTax.data?.taxExempt === true;
        // Resolved BY ID from the posting group — never by account number/name,
        // which users can edit.
        const salesTaxPayableAccount =
          accountDefaults?.data?.salesTaxPayableAccount;

        const resolveLineTax = (
          invoiceLine: Database["public"]["Tables"]["salesInvoiceLine"]["Row"],
          preTaxLineCost: number,
          lineWeightedShippingCost: number
        ): SalesLineTax => {
          const resolvedTaxCodeId =
            invoiceLine.taxCodeId &&
            activeTaxCodeIds.has(invoiceLine.taxCodeId)
              ? invoiceLine.taxCodeId
              : null;

          return resolveSalesLineTax({
            preTaxLineCost,
            lineWeightedShippingCost,
            shippingIsTaxable,
            taxCodeId: resolvedTaxCodeId,
            components: resolvedTaxCodeId
              ? taxComponentsByCodeId.get(resolvedTaxCodeId) ?? []
              : [],
            legacyTaxPercent: invoiceLine.taxPercent ?? 0,
            date: taxPointDate,
            exchangeRate: invoiceExchangeRate,
            customerIsTaxExempt,
            itemIsTaxable:
              items.data.find((item) => item.id === invoiceLine.itemId)
                ?.taxable ?? true,
          });
        };

        // One output-tax credit per component, pushed AFTER the line's
        // revenue/AR pair (and after their dimension metas) so that the
        // COGS/inventory pair stays adjacent for the positional back-patch
        // below, and so `journalLineDimensionsMeta` stays index-aligned 1:1
        // with `journalLineInserts` — every push here has a matching meta push.
        const pushTaxJournalLines = (
          lineTax: SalesLineTax,
          context: {
            journalLineReference: string;
            quantity: number;
            documentLineReference: string | null;
            itemPostingGroupId: string | null;
            itemId: string | null;
            locationId: string | null;
          }
        ) => {
          for (const posting of lineTax.postings) {
            const accountId =
              posting.salesTaxAccountId ?? salesTaxPayableAccount;
            if (!accountId) {
              throw new Error(
                "Missing sales tax payable account default; cannot post sales tax"
              );
            }

            journalLineInserts.push({
              accountId,
              description: `Sales Tax — ${posting.componentName}`,
              amount: credit("liability", posting.taxAmountBase),
              quantity: context.quantity,
              documentType: "Invoice",
              documentId: salesInvoice.data?.id,
              externalDocumentId: salesInvoice.data?.customerReference,
              documentLineReference: context.documentLineReference,
              journalLineReference: context.journalLineReference,
              companyId,
            });

            journalLineDimensionsMeta.push({
              customerTypeId: customer.data.customerTypeId ?? null,
              itemPostingGroupId: context.itemPostingGroupId,
              itemId: context.itemId,
              locationId: context.locationId,
              costCenterId: null,
              fixedAssetClassId: null,
            });
          }
        };

        const pushTaxLedgerRows = (
          lineTax: SalesLineTax,
          documentLineId: string
        ) => {
          const shared = {
            companyId,
            source: "Sales" as const,
            documentType: "Sales Invoice",
            documentId: invoiceId,
            documentLineId,
            postingDate: today,
            customerId: salesInvoice.data.customerId,
            currencyCode: salesInvoice.data.currencyCode,
            exchangeRate: invoiceExchangeRate,
            createdBy: userId,
          };

          for (const posting of lineTax.postings) {
            taxLedgerInserts.push({
              ...shared,
              taxCodeId: posting.taxCodeId,
              taxCodeComponentId: posting.componentId,
              componentName: posting.componentName,
              taxAuthorityId: posting.taxAuthorityId,
              rate: posting.rate,
              taxableAmount: posting.taxableAmountBase,
              taxAmount: posting.taxAmountBase,
              exemptAmount: 0,
            });
          }

          // Exempt / zero-rated bases are reported on tax returns, so they get a
          // row of their own — but only when a configured condition fired (see
          // build-tax-lines.ts).
          if (lineTax.exempt) {
            const isCustomerExemption = lineTax.exempt.reason === "customer";
            taxLedgerInserts.push({
              ...shared,
              taxCodeId: lineTax.resolvedTaxCodeId,
              taxCodeComponentId: null,
              componentName: null,
              taxAuthorityId: null,
              rate: 0,
              taxableAmount: 0,
              taxAmount: 0,
              exemptAmount: lineTax.exempt.exemptAmountBase,
              taxExemptionReason: isCustomerExemption
                ? customerTax.data?.taxExemptionReason ?? null
                : null,
              exemptionCertificateNumber: isCustomerExemption
                ? customerTax.data?.taxExemptionCertificateNumber ?? null
                : null,
            });
          }
        };

        for await (const invoiceLine of salesInvoiceLines.data) {
          const invoiceLineQuantityInInventoryUnit = invoiceLine.quantity;

          const preTaxLineCost =
            invoiceLine.quantity * (invoiceLine.unitPrice ?? 0) +
            (invoiceLine.shippingCost ?? 0) +
            (invoiceLine.addOnCost ?? 0);

          // nonTaxableAddOnCost is part of the invoice total (and of the
          // salesInvoices view balance that caps payments) but is excluded
          // from the tax basis.
          const totalLineCost =
            preTaxLineCost * (1 + (invoiceLine.taxPercent ?? 0)) +
            (invoiceLine.nonTaxableAddOnCost ?? 0);

          // Header shipping is untaxed (matching the salesInvoices view), so
          // it is weighted by the pre-tax basis — weights sum to exactly 1.
          // When every line has a zero basis, fall back to equal weights so
          // the shipping still reaches AR.
          const lineCostPercentageOfTotalCost =
            invoiceLine.invoiceLineType === "Comment"
              ? 0
              : totalLinesCost === 0
              ? postableLineCount === 0
                ? 0
                : 1 / postableLineCount
              : preTaxLineCost / totalLinesCost;
          const lineWeightedShippingCost =
            shippingCost * lineCostPercentageOfTotalCost;
          // Convert to base currency for the GL.
          const totalLineCostWithWeightedShipping =
            (totalLineCost + lineWeightedShippingCost) * invoiceExchangeRate;

          const invoiceLineUnitCostInInventoryUnit =
            totalLineCostWithWeightedShipping / invoiceLine.quantity;

          let journalLineReference: string;

          switch (invoiceLine.invoiceLineType) {
            case "Part":
            case "Service":
            case "Consumable":
            case "Fixture":
            case "Material":
            case "Tool":
              {
                const invoiceLineItem = items.data.find(
                  (item) => item.id === invoiceLine.itemId
                );
                const itemTrackingType =
                  invoiceLineItem?.itemTrackingType ?? "Inventory";

                // Output tax for this line. With no tax code, no tax percent, a
                // taxable item and a non-exempt customer this is empty and
                // `totalTaxBase` is 0 — nothing below changes.
                const lineTax = resolveLineTax(
                  invoiceLine,
                  preTaxLineCost,
                  lineWeightedShippingCost
                );

                // AR stays GROSS; the revenue credit is reduced by exactly the
                // amount credited to the tax liability accounts, so the entry
                // balances to the bit. The explicit zero branch guarantees the
                // untaxed case emits the identical float it did before.
                const revenueAmountBase =
                  lineTax.totalTaxBase === 0
                    ? totalLineCostWithWeightedShipping
                    : totalLineCostWithWeightedShipping - lineTax.totalTaxBase;

                pushTaxLedgerRows(lineTax, invoiceLine.id);

                // if the sales order line is null, we ship the part, do the normal entries and do not use accrual/reversing
                if (
                  invoiceLine.salesOrderLineId === null &&
                  invoiceLine.methodType !== "Make to Order"
                ) {
                  // Services are never shipped, so they must not materialize a
                  // shipment document — only the revenue + AR entries below.
                  if (invoiceLine.invoiceLineType !== "Service") {
                    // create the shipment line
                    shipmentLineInserts.push({
                      itemId: invoiceLine.itemId!,
                      lineId: invoiceLine.id,
                      orderQuantity: invoiceLineQuantityInInventoryUnit,
                      outstandingQuantity: invoiceLineQuantityInInventoryUnit,
                      shippedQuantity: invoiceLineQuantityInInventoryUnit,
                      locationId: invoiceLine.locationId,
                      storageUnitId: invoiceLine.storageUnitId,
                      unitOfMeasure: invoiceLine.unitOfMeasureCode ?? "EA",
                      unitPrice: invoiceLine.unitPrice ?? 0,
                      createdBy: invoiceLine.createdBy,
                      companyId,
                    });
                  }

                  if (itemTrackingType === "Inventory") {
                    // create the part ledger line
                    itemLedgerInserts.push({
                      postingDate: today,
                      itemId: invoiceLine.itemId!,
                      quantity: -invoiceLineQuantityInInventoryUnit,
                      locationId: invoiceLine.locationId,
                      storageUnitId: invoiceLine.storageUnitId,
                      entryType: "Negative Adjmt.",
                      documentType: "Sales Shipment",
                      documentId: salesInvoice.data?.id ?? undefined,
                      externalDocumentId:
                        salesInvoice.data?.customerReference ?? undefined,
                      createdBy: userId,
                      companyId,
                    });
                  }

                  // create the normal GL entries for a part

                  if (accountingEnabled && accountDefaults?.data) {
                    const lineItemPostingGroupId =
                      itemCosts.data.find(
                        (cost) => cost.itemId === invoiceLine.itemId
                      )?.itemPostingGroupId ?? null;

                    journalLineReference = nanoid();

                    // credit the sales account (net of output tax)
                    journalLineInserts.push({
                      accountId: accountDefaults.data.salesAccount,
                      description: "Sales Account",
                      amount: credit("revenue", revenueAmountBase),
                      quantity: invoiceLineQuantityInInventoryUnit,
                      documentType: "Invoice",
                      documentId: salesInvoice.data?.id,
                      externalDocumentId: salesInvoice.data?.customerReference,
                      documentLineReference: journalReference.to.salesInvoice(
                        invoiceLine.salesOrderLineId!
                      ),
                      journalLineReference,
                      companyId,
                    });

                    // debit the accounts receivable account
                    journalLineInserts.push({
                      accountId: receivablesAccountId,
                      description: isIntercompany
                        ? "IC Receivables"
                        : "Accounts Receivable",
                      amount: debit("asset", totalLineCostWithWeightedShipping),
                      quantity: invoiceLineQuantityInInventoryUnit,
                      documentType: "Invoice",
                      documentId: salesInvoice.data?.id,
                      externalDocumentId: salesInvoice.data?.customerReference,
                      documentLineReference: journalReference.to.salesInvoice(
                        invoiceLine.salesOrderLineId!
                      ),
                      journalLineReference,
                      intercompanyPartnerId,
                      companyId,
                    });

                    for (let i = 0; i < 2; i++) {
                      journalLineDimensionsMeta.push({
                        customerTypeId: customer.data.customerTypeId ?? null,
                        itemPostingGroupId: lineItemPostingGroupId,
                        itemId: invoiceLine.itemId ?? null,
                        locationId: invoiceLine.locationId ?? null,
                        costCenterId: null,
                        fixedAssetClassId: null,
                      });
                    }

                    // Output tax — after the revenue/AR pair and their metas,
                    // before the COGS/inventory pair (which must stay adjacent).
                    pushTaxJournalLines(lineTax, {
                      journalLineReference,
                      quantity: invoiceLineQuantityInInventoryUnit,
                      documentLineReference: journalReference.to.salesInvoice(
                        invoiceLine.salesOrderLineId!
                      ),
                      itemPostingGroupId: lineItemPostingGroupId,
                      itemId: invoiceLine.itemId ?? null,
                      locationId: invoiceLine.locationId ?? null,
                    });

                    if (itemTrackingType === "Inventory") {
                      const cogsJournalLineReference = nanoid();

                      journalLineInserts.push({
                        accountId: accountDefaults.data.costOfGoodsSoldAccount,
                        description: "Cost of Goods Sold",
                        amount: 0,
                        quantity: invoiceLineQuantityInInventoryUnit,
                        documentType: "Invoice",
                        documentId: salesInvoice.data?.id,
                        externalDocumentId: salesInvoice.data?.customerReference,
                        journalLineReference: cogsJournalLineReference,
                        companyId,
                      });

                      const inventoryAccount = resolveInventoryAccount(
                        invoiceLineItem?.replenishmentSystem ?? null,
                        accountDefaults.data
                      );
                      journalLineInserts.push({
                        accountId: inventoryAccount.account,
                        description: inventoryAccount.description,
                        amount: 0,
                        quantity: invoiceLineQuantityInInventoryUnit,
                        documentType: "Invoice",
                        documentId: salesInvoice.data?.id,
                        externalDocumentId: salesInvoice.data?.customerReference,
                        journalLineReference: cogsJournalLineReference,
                        companyId,
                      });

                      for (let i = 0; i < 2; i++) {
                        journalLineDimensionsMeta.push({
                          customerTypeId: customer.data.customerTypeId ?? null,
                          itemPostingGroupId: lineItemPostingGroupId,
                          itemId: invoiceLine.itemId ?? null,
                          locationId: invoiceLine.locationId ?? null,
                          costCenterId: null,
                          fixedAssetClassId: null,
                        });
                      }
                    }
                  }
                } // if the line is associated with a sales order line, COGS was posted at shipment — keep only AR + Revenue
                else {
                  if (accountingEnabled && accountDefaults?.data) {
                    // Create the normal GL entries for the invoice
                    journalLineReference = nanoid();

                    // Credit the sales account (net of output tax)
                    journalLineInserts.push({
                      accountId: accountDefaults.data.salesAccount,
                      description: "Sales Account",
                      amount: credit("revenue", revenueAmountBase),
                      quantity: invoiceLineQuantityInInventoryUnit,
                      documentType: "Invoice",
                      documentId: salesInvoice.data?.id,
                      externalDocumentId: salesInvoice.data?.customerReference,
                      documentLineReference: invoiceLine.salesOrderLineId
                        ? journalReference.to.salesInvoice(
                            invoiceLine.salesOrderLineId
                          )
                        : null,
                      journalLineReference,
                      companyId,
                    });

                    // Debit the accounts receivable account
                    journalLineInserts.push({
                      accountId: receivablesAccountId,
                      description: isIntercompany
                        ? "IC Receivables"
                        : "Accounts Receivable",
                      amount: debit("asset", totalLineCostWithWeightedShipping),
                      quantity: invoiceLineQuantityInInventoryUnit,
                      documentType: "Invoice",
                      documentId: salesInvoice.data?.id,
                      externalDocumentId: salesInvoice.data?.customerReference,
                      documentLineReference: invoiceLine.salesOrderLineId
                        ? journalReference.to.salesInvoice(
                            invoiceLine.salesOrderLineId
                          )
                        : null,
                      journalLineReference,
                      intercompanyPartnerId,
                      companyId,
                    });

                    const itemPostingGroupId =
                      itemCosts.data.find(
                        (cost) => cost.itemId === invoiceLine.itemId
                      )?.itemPostingGroupId ?? null;

                    for (let i = 0; i < 2; i++) {
                      journalLineDimensionsMeta.push({
                        customerTypeId: customer.data.customerTypeId ?? null,
                        itemPostingGroupId,
                        itemId: invoiceLine.itemId ?? null,
                        locationId: invoiceLine.locationId ?? null,
                        costCenterId: null,
                        fixedAssetClassId: null,
                      });
                    }

                    // Output tax — after the revenue/AR pair and their metas.
                    pushTaxJournalLines(lineTax, {
                      journalLineReference,
                      quantity: invoiceLineQuantityInInventoryUnit,
                      documentLineReference: invoiceLine.salesOrderLineId
                        ? journalReference.to.salesInvoice(
                            invoiceLine.salesOrderLineId
                          )
                        : null,
                      itemPostingGroupId,
                      itemId: invoiceLine.itemId ?? null,
                      locationId: invoiceLine.locationId ?? null,
                    });
                  }
                }
              }

              break;
            case "Fixed Asset": {
              // Silently skipping would post less to AR than the invoice
              // total the payment flow is allowed to apply against.
              if (accountingEnabled && !invoiceLine.assetId) {
                throw new Error(
                  `Fixed Asset invoice line ${invoiceLine.id} has no asset selected`
                );
              }
              if (accountingEnabled && accountDefaults?.data && invoiceLine.assetId) {
                const salesOrderLine = salesOrderLines?.find(
                  (sol) => sol.id === invoiceLine.salesOrderLineId
                );
                const wasShipped = salesOrderLine?.sentComplete === true;
                const saleProceeds = totalLineCostWithWeightedShipping;

                if (wasShipped && invoiceLine.salesOrderLineId) {
                  // Shipment already removed the asset and parked its NBV in the
                  // disposal clearing account (writeOffAccountId). Here we book
                  // AR, clear the holding account back to zero, and recognize the
                  // explicit gain/loss on the matching Gain/Loss on Disposal account.
                  const assetRecord = await client
                    .from("fixedAsset")
                    .select(
                      "locationId, fixedAssetClassId, fixedAssetClass:fixedAssetClassId(id, writeOffAccountId, gainOnDisposalAccountId, lossOnDisposalAccountId)"
                    )
                    .eq("id", invoiceLine.assetId)
                    .eq("companyId", companyId)
                    .single();

                  if (assetRecord.error)
                    throw new Error("Failed to fetch fixed asset");

                  const assetClass = assetRecord.data.fixedAssetClass as any;
                  const writeOffAccountId = assetClass.writeOffAccountId;
                  const gainOnDisposalAccountId =
                    assetClass.gainOnDisposalAccountId;
                  const lossOnDisposalAccountId =
                    assetClass.lossOnDisposalAccountId;

                  // NBV was recorded on the disposal row at shipment. The
                  // shipment must have created it; if it is missing the ledger
                  // would be left unbalanced, so abort rather than guess.
                  const disposal = await client
                    .from("fixedAssetDisposal")
                    .select("id, netBookValueAtDisposal")
                    .eq("fixedAssetId", invoiceLine.assetId)
                    .eq("companyId", companyId)
                    .order("createdAt", { ascending: false })
                    .limit(1)
                    .single();

                  if (disposal.error || !disposal.data) {
                    throw new Error(
                      `No disposal record found for asset ${invoiceLine.assetId} — shipment must create the disposal record before invoice posting`
                    );
                  }

                  const nbv = Number(disposal.data.netBookValueAtDisposal);
                  const gainLoss = saleProceeds - nbv;

                  const arJournalLineReference = nanoid();

                  journalLineInserts.push({
                    accountId: receivablesAccountId,
                    description: "Accounts Receivable",
                    amount: debit("asset", saleProceeds),
                    quantity: invoiceLineQuantityInInventoryUnit,
                    documentType: "Invoice",
                    documentId: salesInvoice.data?.id ?? undefined,
                    externalDocumentId:
                      salesInvoice.data?.customerReference ?? undefined,
                    documentLineReference: journalReference.to.salesInvoice(
                      invoiceLine.salesOrderLineId
                    ),
                    journalLineReference: arJournalLineReference,
                    intercompanyPartnerId,
                    companyId,
                  });

                  // Clear the disposal clearing account back to zero (credit the
                  // NBV that was debited there at shipment).
                  journalLineInserts.push({
                    accountId: writeOffAccountId,
                    description: "Clear disposal clearing",
                    amount: credit("expense", nbv),
                    quantity: invoiceLineQuantityInInventoryUnit,
                    documentType: "Invoice",
                    documentId: salesInvoice.data?.id ?? undefined,
                    externalDocumentId:
                      salesInvoice.data?.customerReference ?? undefined,
                    documentLineReference: journalReference.to.salesInvoice(
                      invoiceLine.salesOrderLineId
                    ),
                    journalLineReference: arJournalLineReference,
                    companyId,
                  });

                  for (let i = 0; i < 2; i++) {
                    journalLineDimensionsMeta.push({
                      customerTypeId: customer.data.customerTypeId ?? null,
                      itemPostingGroupId: null,
                      itemId: null,
                      locationId: invoiceLine.locationId ?? salesOrderLine?.locationId ?? assetRecord.data.locationId ?? null,
                      costCenterId: null,
                      fixedAssetClassId: assetClass?.id ?? null,
                    });
                  }

                  // Recognize the explicit gain (credit) or loss (debit) on the
                  // matching non-operating account: gains to the Gain on Disposal
                  // account, losses to the Loss on Disposal account.
                  if (gainLoss !== 0) {
                    journalLineInserts.push({
                      accountId:
                        gainLoss > 0
                          ? gainOnDisposalAccountId
                          : lossOnDisposalAccountId,
                      description:
                        gainLoss > 0 ? "Gain on disposal" : "Loss on disposal",
                      amount:
                        gainLoss > 0
                          ? credit("revenue", gainLoss)
                          : debit("expense", -gainLoss),
                      quantity: invoiceLineQuantityInInventoryUnit,
                      documentType: "Invoice",
                      documentId: salesInvoice.data?.id ?? undefined,
                      externalDocumentId:
                        salesInvoice.data?.customerReference ?? undefined,
                      documentLineReference: journalReference.to.salesInvoice(
                        invoiceLine.salesOrderLineId
                      ),
                      journalLineReference: arJournalLineReference,
                      companyId,
                    });

                    journalLineDimensionsMeta.push({
                      customerTypeId: customer.data.customerTypeId ?? null,
                      itemPostingGroupId: null,
                      itemId: null,
                      locationId: invoiceLine.locationId ?? salesOrderLine?.locationId ?? assetRecord.data.locationId ?? null,
                      costCenterId: null,
                      fixedAssetClassId: assetClass?.id ?? null,
                    });
                  }

                  // Defer the fixedAssetDisposal + fixedAsset writes so they run
                  // inside the same transaction as the journal posting (below).
                  fixedAssetDisposalUpdates.push({
                    disposalId: disposal.data.id,
                    assetId: invoiceLine.assetId,
                    saleProceeds,
                    gainLoss,
                  });
                } else {
                  // Direct invoice (no prior shipment) — combined single-step
                  // disposal: remove the asset + its accumulated depreciation,
                  // book AR for proceeds, and recognize the explicit gain/loss on
                  // the matching Gain/Loss on Disposal account. No NBV write-off
                  // is comingled with proceeds.
                  const assetRecord = await client
                    .from("fixedAsset")
                    .select(
                      "id, status, acquisitionCost, accumulatedDepreciation, locationId, fixedAssetClass:fixedAssetClassId(id, assetAccountId, accumulatedDepreciationAccountId, gainOnDisposalAccountId, lossOnDisposalAccountId)"
                    )
                    .eq("id", invoiceLine.assetId)
                    .eq("companyId", companyId)
                    .single();

                  if (assetRecord.error)
                    throw new Error(
                      "Failed to fetch fixed asset for disposal"
                    );

                  const assetClass =
                    assetRecord.data.fixedAssetClass as any;
                  const acquisitionCost =
                    Number(assetRecord.data.acquisitionCost) ?? 0;
                  const accumulatedDepreciation =
                    Number(assetRecord.data.accumulatedDepreciation) ?? 0;
                  const nbv = acquisitionCost - accumulatedDepreciation;
                  const gainLoss = saleProceeds - nbv;

                  const disposalDimensionMeta = () => ({
                    customerTypeId: customer.data.customerTypeId ?? null,
                    itemPostingGroupId: null,
                    itemId: null,
                    locationId:
                      invoiceLine.locationId ??
                      salesOrderLine?.locationId ??
                      assetRecord.data.locationId ??
                      null,
                    costCenterId: null,
                    fixedAssetClassId: assetClass?.id ?? null,
                  });
                  const disposalDocumentLineReference =
                    invoiceLine.salesOrderLineId
                      ? journalReference.to.salesInvoice(
                          invoiceLine.salesOrderLineId
                        )
                      : null;

                  if (accumulatedDepreciation > 0) {
                    journalLineReference = nanoid();
                    journalLineInserts.push({
                      accountId:
                        assetClass.accumulatedDepreciationAccountId,
                      description: "Clear accumulated depreciation",
                      amount: debit("asset", accumulatedDepreciation),
                      quantity: 1,
                      documentType: "Invoice",
                      documentId: salesInvoice.data?.id ?? undefined,
                      externalDocumentId:
                        salesInvoice.data?.customerReference ?? undefined,
                      documentLineReference: disposalDocumentLineReference,
                      journalLineReference,
                      companyId,
                    });

                    journalLineDimensionsMeta.push(disposalDimensionMeta());
                  }

                  const removeJournalLineReference = nanoid();
                  journalLineInserts.push({
                    accountId: assetClass.assetAccountId,
                    description: "Remove asset at cost",
                    amount: credit("asset", acquisitionCost),
                    quantity: 1,
                    documentType: "Invoice",
                    documentId: salesInvoice.data?.id ?? undefined,
                    externalDocumentId:
                      salesInvoice.data?.customerReference ?? undefined,
                    documentLineReference: disposalDocumentLineReference,
                    journalLineReference: removeJournalLineReference,
                    companyId,
                  });

                  journalLineDimensionsMeta.push(disposalDimensionMeta());

                  const arJournalLineReference = nanoid();
                  journalLineInserts.push({
                    accountId: receivablesAccountId,
                    description: "Accounts Receivable",
                    amount: debit("asset", saleProceeds),
                    quantity: invoiceLineQuantityInInventoryUnit,
                    documentType: "Invoice",
                    documentId: salesInvoice.data?.id ?? undefined,
                    externalDocumentId:
                      salesInvoice.data?.customerReference ?? undefined,
                    documentLineReference: disposalDocumentLineReference,
                    journalLineReference: arJournalLineReference,
                    intercompanyPartnerId,
                    companyId,
                  });

                  journalLineDimensionsMeta.push(disposalDimensionMeta());

                  // Explicit gain (credit) / loss (debit) on the matching
                  // non-operating account — Gain on Disposal for a gain, Loss on
                  // Disposal for a loss.
                  if (gainLoss !== 0) {
                    journalLineInserts.push({
                      accountId:
                        gainLoss > 0
                          ? assetClass.gainOnDisposalAccountId
                          : assetClass.lossOnDisposalAccountId,
                      description:
                        gainLoss > 0 ? "Gain on disposal" : "Loss on disposal",
                      amount:
                        gainLoss > 0
                          ? credit("revenue", gainLoss)
                          : debit("expense", -gainLoss),
                      quantity: 1,
                      documentType: "Invoice",
                      documentId: salesInvoice.data?.id ?? undefined,
                      externalDocumentId:
                        salesInvoice.data?.customerReference ?? undefined,
                      documentLineReference: disposalDocumentLineReference,
                      journalLineReference: arJournalLineReference,
                      companyId,
                    });

                    journalLineDimensionsMeta.push(disposalDimensionMeta());
                  }

                  await client
                    .from("fixedAsset")
                    .update({
                      status: "Disposed",
                      disposalDate: today,
                      disposalMethod: "Sale",
                      saleProceeds,
                      updatedBy: userId,
                    })
                    .eq("id", invoiceLine.assetId)
                    .eq("companyId", companyId);

                  await client.from("fixedAssetDisposal").insert({
                    fixedAssetId: invoiceLine.assetId,
                    disposalMethod: "Sale",
                    disposalDate: today,
                    saleProceeds,
                    netBookValueAtDisposal: nbv,
                    gainLoss,
                    companyId,
                    createdBy: userId,
                  });
                }
              }
              break;
            }
            case "Comment":
              break;

            default:
              throw new Error("Unsupported invoice line type");
          }
        }

        const accountingPeriodId = accountingEnabled
          ? await getCurrentAccountingPeriod(client, companyId, db)
          : null;

        await db.transaction().execute(async (trx) => {
          if (shipmentLineInserts.length > 0) {
            const shipmentLinesGroupedByLocationId = shipmentLineInserts.reduce<
              Record<string, typeof shipmentLineInserts>
            >((acc, line) => {
              if (line.locationId) {
                if (line.locationId in acc) {
                  acc[line.locationId].push(line);
                } else {
                  acc[line.locationId] = [line];
                }
              }

              return acc;
            }, {});

            for await (const [locationId, shipmentLines] of Object.entries(
              shipmentLinesGroupedByLocationId
            )) {
              const readableShipmentId = await getNextSequence(
                trx,
                "shipment",
                companyId
              );
              const shipment = await trx
                .insertInto("shipment")
                .values({
                  shipmentId: readableShipmentId ?? "x",
                  locationId,
                  sourceDocument: "Sales Invoice",
                  sourceDocumentId: salesInvoice.data.id,
                  sourceDocumentReadableId: salesInvoice.data.invoiceId,
                  shippingMethodId: salesInvoiceShipment.data?.shippingMethodId,
                  customerId: salesInvoice.data.customerId,
                  externalDocumentId: salesInvoice.data.customerReference,
                  status: "Posted",
                  postingDate: today,
                  postedBy: userId,
                  invoiced: true,
                  opportunityId: salesInvoice.data.opportunityId,
                  companyId,
                  createdBy: salesInvoice.data.createdBy,
                })
                .returning(["id"])
                .execute();

              const shipmentId = shipment[0].id;
              if (!shipmentId) throw new Error("Failed to insert shipment");

              await trx
                .insertInto("shipmentLine")
                .values(
                  shipmentLines.map((r) => ({
                    ...r,
                    shipmentId: shipmentId,
                  }))
                )
                .returning(["id"])
                .execute();
            }
          }

          for await (const [salesOrderLineId, update] of Object.entries(
            salesOrderLineUpdates
          )) {
            await trx
              .updateTable("salesOrderLine")
              .set(update)
              .where("id", "=", salesOrderLineId)
              .execute();
          }

          const salesOrdersUpdated = Object.values(
            salesOrderLineUpdates
          ).reduce<string[]>((acc, update) => {
            if (update.salesOrderId && !acc.includes(update.salesOrderId)) {
              acc.push(update.salesOrderId);
            }
            return acc;
          }, []);

          for await (const salesOrderId of salesOrdersUpdated) {
            const salesOrderLines = await trx
              .selectFrom("salesOrderLine")
              .selectAll()
              .where("salesOrderId", "=", salesOrderId)
              .execute();

            const areAllLinesInvoiced = salesOrderLines.every(
              (line) =>
                line.salesOrderLineType === "Comment" || line.invoicedComplete
            );

            const areAllLinesShipped = salesOrderLines.every(
              (line) =>
                line.salesOrderLineType === "Comment" ||
                  line.salesOrderLineType === "Service" ||
                  line.sentComplete
            );

            let status: Database["public"]["Tables"]["salesOrder"]["Row"]["status"] =
              "To Ship and Invoice";

            if (areAllLinesInvoiced && areAllLinesShipped) {
              status = "Completed";
            } else if (areAllLinesInvoiced) {
              status = "To Ship";
            } else if (areAllLinesShipped) {
              status = "To Invoice";
            }

            if (areAllLinesInvoiced) {
              await trx
                .updateTable("shipment")
                .set({
                  invoiced: true,
                })
                .where("sourceDocumentId", "=", salesOrderId)
                .execute();
            }

            await trx
              .updateTable("salesOrder")
              .set({
                status,
              })
              .where("id", "=", salesOrderId)
              .execute();
          }

          // Calculate COGS for direct invoice items (no sales order)
          const directInvoiceItems = salesInvoiceLines.data.filter(
            (line) => line.salesOrderLineId === null && line.itemId
          );

          for (const directLine of directInvoiceItems) {
            if (!directLine.itemId) continue;

            const itemTrackingType =
              items.data.find((item) => item.id === directLine.itemId)
                ?.itemTrackingType ?? "Inventory";

            if (itemTrackingType !== "Inventory") continue;

            const cogsResult = await calculateCOGS(trx, {
              itemId: directLine.itemId,
              quantity: directLine.quantity,
              companyId,
            });

            for (let i = 0; i < journalLineInserts.length; i++) {
              const jl = journalLineInserts[i];
              if (
                jl.description === "Cost of Goods Sold" &&
                jl.amount === 0 &&
                jl.quantity === directLine.quantity
              ) {
                journalLineInserts[i].amount = debit("expense", cogsResult.totalCost);
                if (i + 1 < journalLineInserts.length) {
                  journalLineInserts[i + 1].amount = credit("asset", cogsResult.totalCost);
                }

                await trx
                  .insertInto("costLedger")
                  .values({
                    itemLedgerType: "Sale",
                    costLedgerType: "Direct Cost",
                    adjustment: false,
                    documentType: "Sales Shipment",
                    documentId: salesInvoice.data?.id ?? "",
                    itemId: directLine.itemId,
                    quantity: -directLine.quantity,
                    cost: -cogsResult.totalCost,
                    remainingQuantity: 0,
                    companyId,
                  })
                  .execute();

                break;
              }
            }
          }

          let journalLineResults: { id: string }[] = [];
          let postedJournalId: string | null = null;
          if (accountingEnabled) {
            const journalEntryId = await getNextSequence(
              trx,
              "journalEntry",
              companyId
            );

            const journalResult = await trx
              .insertInto("journal")
              .values({
                journalEntryId,
                accountingPeriodId,
                description: `Sales Invoice ${salesInvoice.data?.invoiceId}`,
                postingDate: today,
                companyId,
                sourceType: "Sales Invoice",
                status: "Posted",
                postedAt: new Date().toISOString(),
                postedBy: userId,
                createdBy: userId,
              })
              .returning(["id"])
              .executeTakeFirstOrThrow();

            postedJournalId = journalResult.id;

            if (journalLineInserts.length > 0) {
              journalLineResults = await trx
                .insertInto("journalLine")
                .values(
                  journalLineInserts.map((line) => ({
                    ...line,
                    journalId: journalResult.id,
                  }))
                )
                .returning(["id"])
                .execute();
            }

            if (dimensionMap.size > 0) {
              const journalLineDimensionInserts: {
                journalLineId: string;
                dimensionId: string;
                valueId: string;
                companyId: string;
              }[] = [];

              journalLineResults.forEach((jl, index) => {
                const meta = journalLineDimensionsMeta[index];
                if (!meta) return;

                if (meta.customerTypeId && dimensionMap.has("CustomerType")) {
                  journalLineDimensionInserts.push({
                    journalLineId: jl.id,
                    dimensionId: dimensionMap.get("CustomerType")!,
                    valueId: meta.customerTypeId,
                    companyId,
                  });
                }
                if (meta.itemPostingGroupId && dimensionMap.has("ItemPostingGroup")) {
                  journalLineDimensionInserts.push({
                    journalLineId: jl.id,
                    dimensionId: dimensionMap.get("ItemPostingGroup")!,
                    valueId: meta.itemPostingGroupId,
                    companyId,
                  });
                }
                if (meta.locationId && dimensionMap.has("Location")) {
                  journalLineDimensionInserts.push({
                    journalLineId: jl.id,
                    dimensionId: dimensionMap.get("Location")!,
                    valueId: meta.locationId,
                    companyId,
                  });
                }
                if (meta.costCenterId && dimensionMap.has("CostCenter")) {
                  journalLineDimensionInserts.push({
                    journalLineId: jl.id,
                    dimensionId: dimensionMap.get("CostCenter")!,
                    valueId: meta.costCenterId,
                    companyId,
                  });
                }
                if (meta.fixedAssetClassId && dimensionMap.has("FixedAssetClass")) {
                  journalLineDimensionInserts.push({
                    journalLineId: jl.id,
                    dimensionId: dimensionMap.get("FixedAssetClass")!,
                    valueId: meta.fixedAssetClassId,
                    companyId,
                  });
                }
                if (meta.itemId && dimensionMap.has("Item")) {
                  journalLineDimensionInserts.push({
                    journalLineId: jl.id,
                    dimensionId: dimensionMap.get("Item")!,
                    valueId: meta.itemId,
                    companyId,
                  });
                }
                if (salesInvoice.data?.customerId && dimensionMap.has("Customer")) {
                  journalLineDimensionInserts.push({
                    journalLineId: jl.id,
                    dimensionId: dimensionMap.get("Customer")!,
                    valueId: salesInvoice.data.customerId,
                    companyId,
                  });
                }
              });

              if (journalLineDimensionInserts.length > 0) {
                await trx
                  .insertInto("journalLineDimension")
                  .values(journalLineDimensionInserts)
                  .execute();
              }
            }
          }

          // Tax subledger. Written after the journal so the rows can point at
          // it; `postedJournalId` stays null when accounting is disabled, which
          // the column allows. Empty for a company with no tax configuration.
          if (taxLedgerInserts.length > 0) {
            await trx
              .insertInto("taxLedger")
              .values(
                taxLedgerInserts.map((row) => ({
                  ...row,
                  journalId: postedJournalId,
                }))
              )
              .execute();
          }

          if (itemLedgerInserts.length > 0) {
            await trx
              .insertInto("itemLedger")
              .values(itemLedgerInserts)
              .returning(["id"])
              .execute();
          }

          if (salesInvoice.data.shipmentId) {
            await trx
              .updateTable("shipment")
              .set({
                invoiced: true,
              })
              .where("id", "=", salesInvoice.data.shipmentId)
              .execute();
          }

          // Create intercompany transaction record if IC
          if (accountingEnabled && isIntercompany && intercompanyPartnerId) {
            const icJournalLineId = journalLineResults.length > 0
              ? journalLineResults[0].id
              : null;

            await trx
              .insertInto("intercompanyTransaction")
              .values({
                companyGroupId: companyGroupId!,
                sourceCompanyId: companyId,
                targetCompanyId: intercompanyPartnerId,
                sourceJournalLineId: icJournalLineId,
                amount: totalLinesCost,
                currencyCode: salesInvoice.data?.currencyCode ?? "USD",
                description: `Sales Invoice ${salesInvoice.data?.invoiceId}`,
                documentType: "Invoice",
                documentId: salesInvoice.data?.id,
                status: "Unmatched",
              })
              .execute();
          }

          // Apply deferred fixed-asset disposal writes inside the transaction so
          // any failure rolls back the journals posted above.
          for (const upd of fixedAssetDisposalUpdates) {
            await trx
              .updateTable("fixedAssetDisposal")
              .set({
                saleProceeds: upd.saleProceeds,
                gainLoss: upd.gainLoss,
              })
              .where("id", "=", upd.disposalId)
              .where("companyId", "=", companyId)
              .execute();

            await trx
              .updateTable("fixedAsset")
              .set({
                saleProceeds: upd.saleProceeds,
                updatedBy: userId,
              })
              .where("id", "=", upd.assetId)
              .where("companyId", "=", companyId)
              .execute();
          }

          await trx
            .updateTable("salesInvoice")
            .set({
              dateIssued: today,
              postingDate: today,
              status: "Submitted",
            })
            .where("id", "=", invoiceId)
            .execute();
        });
        break;
      }

      case "void": {
        // Get journal entries to reverse
        const { data: journalEntries } = await client
          .from("journalLine")
          .select("*")
          .eq("documentId", invoiceId)
          .eq("documentType", "Invoice");

        if (!journalEntries) {
          throw new Error("No journal entries found for invoice");
        }

        // Get shipments created from this invoice
        const { data: invoiceShipments } = await client
          .from("shipment")
          .select("id")
          .eq("sourceDocument", "Sales Invoice")
          .eq("sourceDocumentId", invoiceId);

        const salesOrderLinesBySalesOrderLineId = salesOrderLines.reduce<
          Record<string, Database["public"]["Tables"]["salesOrderLine"]["Row"]>
        >((acc, salesOrderLine) => {
          acc[salesOrderLine.id] = salesOrderLine;
          return acc;
        }, {});

        // Reverse sales order line updates
        const salesOrderLineUpdates = salesInvoiceLines.data.reduce<
          Record<
            string,
            Database["public"]["Tables"]["salesOrderLine"]["Update"]
          >
        >((acc, invoiceLine) => {
          const salesOrderLine =
            salesOrderLinesBySalesOrderLineId[
              invoiceLine.salesOrderLineId ?? ""
            ];
          if (
            invoiceLine.salesOrderLineId &&
            salesOrderLine &&
            invoiceLine.quantity &&
            salesOrderLine.saleQuantity &&
            salesOrderLine.saleQuantity > 0
          ) {
            const newQuantityInvoiced = Math.max(
              0,
              (salesOrderLine.quantityInvoiced ?? 0) - invoiceLine.quantity
            );

            const invoicedComplete =
              newQuantityInvoiced >= salesOrderLine.saleQuantity;

            const updates: Database["public"]["Tables"]["salesOrderLine"]["Update"] =
              {
                quantityInvoiced: newQuantityInvoiced,
                invoicedComplete,
                salesOrderId: salesOrderLine.salesOrderId,
              };

            return {
              ...acc,
              [invoiceLine.salesOrderLineId]: updates,
            };
          }

          return acc;
        }, {});

        // Create reversing journal entries
        const reversingJournalEntries = accountingEnabled
          ? journalEntries.map((entry) => ({
              accountId: entry.accountId,
              description: `VOID: ${entry.description}`,
              amount: -entry.amount, // Reverse the amount
              quantity: -entry.quantity,
              documentType: "Invoice" as const,
              documentId: salesInvoice.data?.id,
              externalDocumentId: entry.externalDocumentId,
              documentLineReference: entry.documentLineReference,
              journalLineReference: entry.journalLineReference,
              companyId,
            }))
          : [];

        // Reverse the tax subledger. The journal reversal above already sweeps
        // up the output-tax journal lines (it mirrors every `journalLine` with
        // this invoice's `documentId`/`documentType`, and the tax lines carry
        // the same pair), but `taxLedger` is a separate ledger and has to be
        // unwound explicitly or the liability report keeps counting a voided
        // invoice. Snapshots are copied verbatim; only the three amounts flip
        // sign, so the reversal reports against the same authority/component.
        const { data: originalTaxLedgerEntries } = await client
          .from("taxLedger")
          .select("*")
          .eq("companyId", companyId)
          .eq("documentId", invoiceId)
          .eq("documentType", "Sales Invoice");

        const reversingTaxLedgerEntries: Omit<
          Database["public"]["Tables"]["taxLedger"]["Insert"],
          "journalId"
        >[] = (originalTaxLedgerEntries ?? []).map((entry) => ({
          companyId,
          source: entry.source,
          documentType: entry.documentType,
          documentId: entry.documentId,
          documentLineId: entry.documentLineId,
          postingDate: today,
          taxCodeId: entry.taxCodeId,
          taxCodeComponentId: entry.taxCodeComponentId,
          componentName: entry.componentName,
          taxAuthorityId: entry.taxAuthorityId,
          customerId: entry.customerId,
          supplierId: entry.supplierId,
          rate: entry.rate,
          taxableAmount: -entry.taxableAmount,
          taxAmount: -entry.taxAmount,
          exemptAmount: -entry.exemptAmount,
          taxExemptionReason: entry.taxExemptionReason,
          exemptionCertificateNumber: entry.exemptionCertificateNumber,
          currencyCode: entry.currencyCode,
          exchangeRate: entry.exchangeRate,
          postedToInputAccount: entry.postedToInputAccount,
          createdBy: userId,
        }));

        // Create reversing item ledger entries
        const reversingItemLedgerEntries: Database["public"]["Tables"]["itemLedger"]["Insert"][] =
          [];

        const { data: originalItemLedgerEntries } = await client
          .from("itemLedger")
          .select("*")
          .eq("documentId", invoiceId)
          .eq("documentType", "Sales Shipment");

        if (originalItemLedgerEntries) {
          originalItemLedgerEntries.forEach((entry) => {
            reversingItemLedgerEntries.push({
              postingDate: today,
              itemId: entry.itemId,
              quantity: -entry.quantity, // Reverse the quantity
              locationId: entry.locationId,
              storageUnitId: entry.storageUnitId,
              entryType:
                entry.entryType === "Negative Adjmt."
                  ? "Positive Adjmt."
                  : "Negative Adjmt.",
              documentType: "Sales Shipment",
              documentId: salesInvoice.data?.id ?? undefined,
              externalDocumentId: entry.externalDocumentId,
              createdBy: userId,
              companyId,
            });
          });
        }

        const accountingPeriodId = accountingEnabled
          ? await getCurrentAccountingPeriod(client, companyId, db)
          : null;

        await db.transaction().execute(async (trx) => {
          // Update sales order lines to reverse invoiced quantities
          for await (const [salesOrderLineId, update] of Object.entries(
            salesOrderLineUpdates
          )) {
            await trx
              .updateTable("salesOrderLine")
              .set(update)
              .where("id", "=", salesOrderLineId)
              .execute();
          }

          // Update sales orders status - fetch fresh data after updates
          const salesOrdersUpdated = Object.values(
            salesOrderLineUpdates
          ).reduce<string[]>((acc, update) => {
            if (update.salesOrderId && !acc.includes(update.salesOrderId)) {
              acc.push(update.salesOrderId);
            }
            return acc;
          }, []);

          for await (const salesOrderId of salesOrdersUpdated) {
            // Fetch fresh data after the sales order line updates
            const salesOrderLines = await trx
              .selectFrom("salesOrderLine")
              .selectAll()
              .where("salesOrderId", "=", salesOrderId)
              .execute();

            const areAllLinesInvoiced = salesOrderLines.every(
              (line) =>
                line.salesOrderLineType === "Comment" || line.invoicedComplete
            );

            const areAllLinesShipped = salesOrderLines.every(
              (line) =>
                line.salesOrderLineType === "Comment" ||
                  line.salesOrderLineType === "Service" ||
                  line.sentComplete
            );

            let status: Database["public"]["Tables"]["salesOrder"]["Row"]["status"] =
              "To Ship and Invoice";

            if (areAllLinesInvoiced && areAllLinesShipped) {
              status = "Completed";
            } else if (areAllLinesInvoiced) {
              status = "To Ship";
            } else if (areAllLinesShipped) {
              status = "To Invoice";
            }

            // If no lines are invoiced anymore, remove invoiced flag from shipments
            if (!areAllLinesInvoiced) {
              await trx
                .updateTable("shipment")
                .set({
                  invoiced: false,
                })
                .where("sourceDocumentId", "=", salesOrderId)
                .execute();
            }

            await trx
              .updateTable("salesOrder")
              .set({
                status,
              })
              .where("id", "=", salesOrderId)
              .execute();
          }

          let voidJournalId: string | null = null;
          if (accountingEnabled) {
            const voidJournalEntryId = await getNextSequence(
              trx,
              "journalEntry",
              companyId
            );

            const voidJournalResult = await trx
              .insertInto("journal")
              .values({
                journalEntryId: voidJournalEntryId,
                accountingPeriodId,
                description: `VOID Sales Invoice ${salesInvoice.data?.invoiceId}`,
                postingDate: today,
                companyId,
                sourceType: "Sales Invoice",
                status: "Posted",
                postedAt: new Date().toISOString(),
                postedBy: userId,
                createdBy: userId,
              })
              .returning(["id"])
              .executeTakeFirstOrThrow();

            voidJournalId = voidJournalResult.id;

            if (reversingJournalEntries.length > 0) {
              await trx
                .insertInto("journalLine")
                .values(
                  reversingJournalEntries.map((line) => ({
                    ...line,
                    journalId: voidJournalResult.id,
                  }))
                )
                .returning(["id"])
                .execute();
            }
          }

          // Insert reversing tax ledger entries
          if (reversingTaxLedgerEntries.length > 0) {
            await trx
              .insertInto("taxLedger")
              .values(
                reversingTaxLedgerEntries.map((row) => ({
                  ...row,
                  journalId: voidJournalId,
                }))
              )
              .execute();
          }

          // Insert reversing item ledger entries
          if (reversingItemLedgerEntries.length > 0) {
            await trx
              .insertInto("itemLedger")
              .values(reversingItemLedgerEntries)
              .returning(["id"])
              .execute();
          }

          // Delete invoice-created shipments
          if (invoiceShipments && invoiceShipments.length > 0) {
            for (const shipment of invoiceShipments) {
              await trx
                .updateTable("shipment")
                .set({
                  invoiced: false,
                  status: "Voided",
                  updatedAt: today,
                  updatedBy: userId,
                })
                .where("id", "=", shipment.id)
                .execute();
            }
          }

          // Remove invoiced flag from related shipment if it exists
          if (salesInvoice.data.shipmentId) {
            await trx
              .updateTable("shipment")
              .set({
                invoiced: false,
              })
              .where("id", "=", salesInvoice.data.shipmentId)
              .execute();
          }

          // Update invoice status to voided
          await trx
            .updateTable("salesInvoice")
            .set({
              status: "Voided",
              updatedAt: today,
              updatedBy: userId,
            })
            .where("id", "=", invoiceId)
            .execute();
        });

        break;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error(err);
    if ("invoiceId" in payload) {
      const client = await requirePermissions(req, payload.companyId, payload.userId, { update: "invoicing" });
      await client
        .from("salesInvoice")
        .update({ status: "Draft" })
        .eq("id", payload.invoiceId);
    }
    return new Response(JSON.stringify(err), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
