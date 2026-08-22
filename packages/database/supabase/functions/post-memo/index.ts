import { serve } from "https://deno.land/std@0.175.0/http/server.ts";
import { nanoid } from "https://deno.land/x/nanoid@v3.0.0/mod.ts";
import z from "npm:zod@^3.24.1";
import { DB, getConnectionPool, getDatabaseClient } from "../lib/database.ts";
import { datetime, getCompanyTimeZone } from "../lib/datetime.ts";
import { corsPreflight, errorResponse, jsonResponse } from "../lib/response.ts";
import { getSupabaseServiceRole } from "../lib/supabase.ts";

import { getCurrentAccountingPeriod } from "../shared/get-accounting-period.ts";
import { getNextSequence } from "../shared/get-next-sequence.ts";
import { getDefaultPostingGroup } from "../shared/get-posting-group.ts";
import { reconcileToStoredTaxAmount } from "../post-purchase-invoice/purchase-invoice-tax.ts";
import { splitLineTax } from "../shared/resolve-taxes.ts";
import {
  buildMemoJournal,
  type MemoJournalLine,
  type MemoTaxLeg,
} from "./build-memo-journal.ts";

const pool = getConnectionPool(1);
const db = getDatabaseClient<DB>(pool);

const payloadValidator = z.object({
  type: z.enum(["post", "void"]).default("post"),
  memoId: z.string(),
  userId: z.string(),
  companyId: z.string(),
});

serve(async (req: Request) => {
  const preflight = corsPreflight(req);
  if (preflight) return preflight;

  const payload = await req.json();

  try {
    const { type, memoId, userId, companyId } = payloadValidator.parse(payload);

    console.log({ function: "post-memo", type, memoId, userId, companyId });

    const client = await getSupabaseServiceRole(
      req.headers.get("Authorization"),
      req.headers.get("carbon-key") ?? "",
      companyId
    );
    const today = datetime.today(await getCompanyTimeZone(client, companyId)).toString();

    const accountingSettings = await client
      .from("companySettings")
      .select("accountingEnabled")
      .eq("id", companyId)
      .single();
    const accountingEnabled =
      accountingSettings.data?.accountingEnabled ?? false;

    const [memo, accountDefaults] = await Promise.all([
      client.from("memo").select("*").eq("id", memoId).single(),
      getDefaultPostingGroup(client, companyId),
    ]);

    if (memo.error) throw new Error("Failed to fetch memo");
    if (accountingEnabled && accountDefaults.error)
      throw new Error("Failed to fetch account defaults");

    // isAR: a customer memo settles AR; a supplier memo settles AP.
    const isAR = memo.data.customerId != null;

    // --------------------------------------------------------------
    // VOID
    // --------------------------------------------------------------
    if (type === "void") {
      if (memo.data.status !== "Posted") {
        throw new Error(
          `Cannot void memo in status ${memo.data.status} (only Posted)`
        );
      }

      const accountingPeriodId = accountingEnabled
        ? await getCurrentAccountingPeriod(client, companyId, db, today)
        : null;

      await db.transaction().execute(async (trx) => {
        // Lock the memo row and re-assert it's still Posted INSIDE the
        // transaction. The status check above runs before the lock (a TOCTOU
        // window): two concurrent voids could otherwise both pass it and each
        // emit a reversing journal. The FOR UPDATE serializes them.
        const lockedMemo = await trx
          .selectFrom("memo")
          .select(["id", "status"])
          .where("id", "=", memoId)
          .where("companyId", "=", companyId)
          .forUpdate()
          .executeTakeFirst();
        if (!lockedMemo) throw new Error("Memo not found");
        if (lockedMemo.status !== "Posted") {
          throw new Error(
            `Cannot void memo in status ${lockedMemo.status} (only Posted)`
          );
        }

        // Stamped onto the reversing tax rows below; stays null when accounting
        // is disabled (the subledger is still reversed — it is not GL-gated).
        let voidJournalId: string | null = null;

        if (accountingEnabled && memo.data.journalId) {
          // Mirror the original journal's lines into a reversing journal (the
          // same paired-journal approach post-payment/post-purchase-invoice use
          // for voids — never mutate the original).
          const originalLines = await trx
            .selectFrom("journalLine")
            .selectAll()
            .where("journalId", "=", memo.data.journalId)
            .execute();

          if (originalLines.length > 0) {
            const voidEntryId = await getNextSequence(
              trx,
              "journalEntry",
              companyId
            );

            const voidJournal = await trx
              .insertInto("journal")
              .values({
                journalEntryId: voidEntryId,
                accountingPeriodId,
                description: `VOID Memo ${memo.data.memoId}`,
                postingDate: today,
                companyId,
                sourceType:
                  memo.data.direction === "Credit"
                    ? "Credit Memo"
                    : "Debit Memo",
                status: "Posted",
                postedAt: new Date().toISOString(),
                postedBy: userId,
                createdBy: userId,
              })
              .returning(["id"])
              .executeTakeFirstOrThrow();
            voidJournalId = voidJournal.id;

            const voidLineResults = await trx
              .insertInto("journalLine")
              .values(
                originalLines.map((line) => ({
                  journalId: voidJournal.id,
                  accountId: line.accountId,
                  amount: -line.amount,
                  quantity: line.quantity,
                  description: `VOID: ${line.description ?? ""}`,
                  documentType: "Memo" as const,
                  documentId: memoId,
                  documentLineReference: line.documentLineReference,
                  journalLineReference: line.journalLineReference,
                  companyId,
                }))
              )
              .returning(["id"])
              .execute();

            // Carry the original lines' dimensions onto the reversing lines so
            // dimension-filtered balances net to zero after the void.
            const origDimensions = await trx
              .selectFrom("journalLineDimension")
              .select(["journalLineId", "dimensionId", "valueId"])
              .where(
                "journalLineId",
                "in",
                originalLines.map((l) => l.id)
              )
              .execute();
            if (origDimensions.length > 0) {
              const idxByOriginalId = new Map(
                originalLines.map((l, i) => [l.id, i])
              );
              await trx
                .insertInto("journalLineDimension")
                .values(
                  origDimensions.map((d) => ({
                    journalLineId:
                      voidLineResults[idxByOriginalId.get(d.journalLineId)!].id,
                    dimensionId: d.dimensionId,
                    valueId: d.valueId,
                    companyId,
                  }))
                )
                .execute();
            }
          }
        }

        // Reverse the tax subledger as well as the GL. The liability report
        // reads this table, not the journal, so a GL-only void would leave a
        // voided memo permanently adjusting a period's tax. Reversing ROWS
        // rather than deleting keeps the subledger append-only.
        const originalTaxLedger = await trx
          .selectFrom("taxLedger")
          .selectAll()
          .where("documentId", "=", memoId)
          .where("documentType", "=", "Memo")
          .where("companyId", "=", companyId)
          .execute();

        if (originalTaxLedger.length > 0) {
          await trx
            .insertInto("taxLedger")
            .values(
              originalTaxLedger.map((entry) => ({
                source: entry.source,
                documentType: entry.documentType,
                documentId: entry.documentId,
                documentLineId: entry.documentLineId,
                journalId: voidJournalId,
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
                currencyCode: entry.currencyCode,
                exchangeRate: entry.exchangeRate,
                // The reversal unwinds the same account the original hit.
                postedToInputAccount: entry.postedToInputAccount,
                // A reversal is never part of the original's filed return.
                taxReturnId: null,
                createdBy: userId,
                companyId,
              }))
            )
            .execute();
        }

        await trx
          .updateTable("memo")
          .set({
            status: "Voided",
            voidedAt: new Date().toISOString(),
            voidedBy: userId,
            updatedAt: new Date().toISOString(),
            updatedBy: userId,
          })
          .where("id", "=", memoId)
          .where("companyId", "=", companyId)
          .execute();
      });

      return jsonResponse({ success: true });
    }

    // --------------------------------------------------------------
    // POST
    // --------------------------------------------------------------
    if (memo.data.status !== "Draft") {
      throw new Error(
        `Cannot post memo in status ${memo.data.status} (only Draft)`
      );
    }
    if (memo.data.exchangeRate <= 0) {
      throw new Error("Memo exchange rate must be > 0");
    }

    const accountingPeriodId = accountingEnabled
      ? await getCurrentAccountingPeriod(client, companyId, db, today)
      : null;

    // Build the (balanced, two-line) journal in base currency. Account-id
    // resolution + the control/reason sign logic live in the pure
    // `buildMemoJournal` so they are unit-tested (post-memo.test.ts).
    const journalLineInserts: MemoJournalLine[] = [];
    const partyDimensions: { dimensionId: string; valueId: string }[] = [];
    // Collected while the journal is built, written inside the same transaction.
    const memoTaxLedgerRows: {
      componentTax: {
        componentId: string;
        name: string;
        taxAuthorityId: string | null;
        rate: number;
        isRecoverable: boolean;
      };
      taxAmountBase: number;
      accountId: string;
    }[] = [];
    // The offset ("reason") account is derived here (not a user choice) and
    // stored on the memo at posting for the audit trail / list display.
    let derivedReasonAccountId: string | null = null;

    if (accountingEnabled) {
      if (!accountDefaults.data) {
        throw new Error(
          "Accounting is enabled but this company has no account defaults configured"
        );
      }
      const ad = accountDefaults.data;
      const controlAccountId = isAR
        ? ad.receivablesAccount
        : ad.payablesAccount;

      // The offset account is deterministic by party side (NOT a user choice):
      // customer memos adjust sales (salesDiscountAccount); supplier memos adjust
      // purchases (supplierPaymentDiscountAccount). Direction only flips the
      // debit/credit side, handled inside buildMemoJournal.
      const reasonAccountId = isAR
        ? ad.salesDiscountAccount
        : ad.supplierPaymentDiscountAccount;
      if (!reasonAccountId) {
        throw new Error(
          `Missing ${
            isAR ? "salesDiscountAccount" : "supplierPaymentDiscountAccount"
          } account default; cannot post memo to GL`
        );
      }
      derivedReasonAccountId = reasonAccountId;

      // Resolve the reason account's class so its natural-balance amount sign is
      // correct (the account can be any class).
      const reasonAccount = await client
        .from("account")
        .select("class")
        .eq("id", reasonAccountId)
        .single();
      if (reasonAccount.error || !reasonAccount.data) {
        throw new Error("Failed to fetch the derived reason account");
      }

      // ---- Tax split ------------------------------------------------------
      // A memo amount is tax-INCLUSIVE. `memo.taxAmount` is the authoritative
      // total (typed or derived in the form); the components only decide how it
      // is APPORTIONED and which accounts it hits — exactly the supplier-
      // authoritative treatment on the purchase side, which is why the same
      // reconciliation helper is reused. Guarded so a memo with no tax code
      // posts byte-identically to before this feature.
      const memoTaxAmount = Number(memo.data.taxAmount ?? 0);
      const memoTaxCodeId = memo.data.taxCodeId as string | null;
      const exchangeRate = Number(memo.data.exchangeRate);
      const amountBase = Number(memo.data.amount) * exchangeRate;
      const taxLegs: MemoTaxLeg[] = [];

      if (memoTaxCodeId && memoTaxAmount > 0) {
        const components = await client
          .from("taxCodeComponent")
          .select("*")
          .eq("companyId", companyId)
          .eq("taxCodeId", memoTaxCodeId);
        if (components.error) {
          throw new Error("Failed to fetch tax code components");
        }

        // Apportion over the NET base so compound components cascade the way
        // they do on an invoice; the result is then scaled to the stored total.
        const netBase = Number(memo.data.amount) - memoTaxAmount;
        const split = splitLineTax({
          taxableBase: netBase,
          taxCodeId: memoTaxCodeId,
          components: (components.data ?? []).map((component) => ({
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
          })),
          legacyTaxPercent: 0,
          date: (memo.data.memoDate as string) ?? today,
        });

        if (split.componentTaxes.length === 0) {
          throw new Error(
            "Memo carries a tax amount but its tax code resolves to no effective components on the memo date"
          );
        }

        const reconciled = reconcileToStoredTaxAmount(
          split.componentTaxes.map((componentTax) => componentTax.tax),
          memoTaxAmount
        );

        // One batched read of the classes: the account a tax leg posts to is
        // configuration, so its class cannot be assumed (see lib/account-sign).
        const defaultTaxAccountId = isAR
          ? ad.salesTaxPayableAccount
          : ad.purchaseTaxPayableAccount;
        const legAccountIds = split.componentTaxes.map(
          (componentTax) =>
            (isAR
              ? componentTax.salesTaxAccountId
              : componentTax.purchaseTaxAccountId) ?? defaultTaxAccountId
        );
        if (legAccountIds.some((accountId) => !accountId)) {
          throw new Error(
            `Missing ${isAR ? "salesTaxPayableAccount" : "purchaseTaxPayableAccount"} account default; cannot post memo tax`
          );
        }
        const taxAccounts = await client
          .from("account")
          .select("id, class")
          .in("id", [...new Set(legAccountIds as string[])]);
        if (taxAccounts.error) {
          throw new Error("Failed to fetch memo tax account classes");
        }
        const classById = new Map(
          (taxAccounts.data ?? []).map((account) => [account.id, account.class])
        );

        split.componentTaxes.forEach((componentTax, index) => {
          const accountId = legAccountIds[index] as string;
          const accountClass = classById.get(accountId);
          if (!accountClass) {
            throw new Error(
              `Tax account ${accountId} could not be classified; refusing to post memo tax`
            );
          }
          const taxAmountBase = reconciled[index] * exchangeRate;
          taxLegs.push({
            componentName: componentTax.name,
            taxAmountBase,
            accountId,
            accountClass: accountClass as string,
          });
          memoTaxLedgerRows.push({
            componentTax,
            taxAmountBase,
            accountId,
          });
        });
      }

      const journalLineReference = nanoid();
      const { lines } = buildMemoJournal({
        memoId,
        companyId,
        isAR,
        direction: memo.data.direction as "Credit" | "Debit",
        amountBase,
        journalLineReference,
        controlAccountId,
        reasonAccountId,
        reasonAccountClass: reasonAccount.data.class as string,
        taxLegs,
      });
      journalLineInserts.push(...lines);

      // Tag the journal lines with the counterparty type + entity dimensions so
      // AR/AP can be reported by counterparty (mirrors post-payment).
      const companyRecord = await client
        .from("company")
        .select("companyGroupId")
        .eq("id", companyId)
        .single();
      const companyGroupId = companyRecord.data?.companyGroupId ?? null;
      const partyId = isAR
        ? (memo.data.customerId as string | null)
        : (memo.data.supplierId as string | null);
      const typeEntityType = isAR ? "CustomerType" : "SupplierType";
      const entityEntityType = isAR ? "Customer" : "Supplier";
      if (companyGroupId && partyId) {
        const [partyRow, dimRows] = await Promise.all([
          isAR
            ? client
                .from("customer")
                .select("customerTypeId")
                .eq("id", partyId)
                .maybeSingle()
            : client
                .from("supplier")
                .select("supplierTypeId")
                .eq("id", partyId)
                .maybeSingle(),
          client
            .from("dimension")
            .select("id, entityType")
            .eq("companyGroupId", companyGroupId)
            .eq("active", true)
            .in("entityType", [typeEntityType, entityEntityType]),
        ]);
        const dimByEntityType = new Map<string, string>();
        for (const d of dimRows.data ?? []) {
          if (d.entityType) dimByEntityType.set(d.entityType, d.id);
        }
        // deno-lint-ignore no-explicit-any
        const party = partyRow.data as any;
        const partyTypeId = isAR
          ? (party?.customerTypeId ?? null)
          : (party?.supplierTypeId ?? null);
        const typeDimensionId = dimByEntityType.get(typeEntityType);
        if (typeDimensionId && partyTypeId) {
          partyDimensions.push({
            dimensionId: typeDimensionId,
            valueId: partyTypeId,
          });
        }
        const entityDimensionId = dimByEntityType.get(entityEntityType);
        if (entityDimensionId) {
          partyDimensions.push({ dimensionId: entityDimensionId, valueId: partyId });
        }
      }
    }

    // --------------------------------------------------------------
    // Commit: lock the memo, re-check Draft, post the journal, flip Posted.
    // Applying a memo to invoices is GL-neutral (both sit in AR/AP), so there is
    // no invoice validation here — that lives in replaceMemoSettlements.
    // --------------------------------------------------------------
    let createdJournalId: string | null = null;
    await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom("memo")
        .select(["id", "status"])
        .where("id", "=", memoId)
        .where("companyId", "=", companyId)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) throw new Error("Memo not found");
      if (locked.status !== "Draft") {
        throw new Error(
          `Cannot post memo in status ${locked.status} (only Draft)`
        );
      }

      let journalId: string | null = null;
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
            description: `${memo.data.direction} Memo ${memo.data.memoId}`,
            postingDate: today,
            companyId,
            sourceType:
              memo.data.direction === "Credit" ? "Credit Memo" : "Debit Memo",
            status: "Posted",
            postedAt: new Date().toISOString(),
            postedBy: userId,
            createdBy: userId,
          })
          .returning(["id"])
          .executeTakeFirstOrThrow();
        journalId = journalResult.id;

        if (journalLineInserts.length > 0) {
          const journalLineResults = await trx
            .insertInto("journalLine")
            .values(
              journalLineInserts.map((line) => ({
                ...line,
                journalId: journalResult.id,
              }))
            )
            .returning(["id"])
            .execute();

          if (partyDimensions.length > 0) {
            await trx
              .insertInto("journalLineDimension")
              .values(
                journalLineResults.flatMap((jl) =>
                  partyDimensions.map((d) => ({
                    journalLineId: jl.id,
                    dimensionId: d.dimensionId,
                    valueId: d.valueId,
                    companyId,
                  }))
                )
              )
              .execute();
          }
        }

        // The tax subledger, signed so a period's totals move the way the memo
        // moves the obligation. A customer CREDIT memo hands tax back, so it
        // REDUCES output tax (negative); a customer DEBIT memo increases it. On
        // the supplier side the same control-account rule inverts the meaning:
        // a supplier credit memo increases what we owe, hence more input tax.
        // Both reduce to the control side — the tax leg always sits opposite it.
        if (memoTaxLedgerRows.length > 0) {
          const increasesTax = isAR
            ? memo.data.direction === "Debit"
            : memo.data.direction === "Credit";
          const sign = increasesTax ? 1 : -1;
          const netBaseSigned =
            sign *
            (Number(memo.data.amount) - Number(memo.data.taxAmount ?? 0)) *
            Number(memo.data.exchangeRate);

          await trx
            .insertInto("taxLedger")
            .values(
              memoTaxLedgerRows.map((row) => ({
                source: isAR ? "Sales" : "Purchase",
                documentType: "Memo",
                documentId: memoId,
                documentLineId: null,
                journalId,
                postingDate: today,
                taxCodeId: memo.data.taxCodeId,
                taxCodeComponentId: row.componentTax.componentId,
                componentName: row.componentTax.name,
                taxAuthorityId: row.componentTax.taxAuthorityId,
                customerId: memo.data.customerId,
                supplierId: memo.data.supplierId,
                rate: row.componentTax.rate,
                taxableAmount: netBaseSigned,
                taxAmount: sign * row.taxAmountBase,
                exemptAmount: 0,
                currencyCode: memo.data.currencyCode,
                exchangeRate: memo.data.exchangeRate,
                // A memo's purchase-side tax lands on the same input account the
                // invoice used, so it nets against it in the liability report.
                postedToInputAccount: !isAR && row.componentTax.isRecoverable,
                createdBy: userId,
                companyId,
              }))
            )
            .execute();
        }
      }

      await trx
        .updateTable("memo")
        .set({
          status: "Posted",
          postingDate: today,
          journalId,
          reasonAccount: derivedReasonAccountId,
          postedAt: new Date().toISOString(),
          postedBy: userId,
          updatedAt: new Date().toISOString(),
          updatedBy: userId,
        })
        .where("id", "=", memoId)
        .where("companyId", "=", companyId)
        .execute();

      createdJournalId = journalId;
    });

    return jsonResponse({ success: true, journalId: createdJournalId });
  } catch (err) {
    return errorResponse(err, 500);
  }
});
