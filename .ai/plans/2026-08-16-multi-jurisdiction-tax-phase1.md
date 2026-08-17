# Multi-Jurisdiction Tax — Phase 1 implementation plan

**Spec:** .ai/specs/2026-07-03-multi-jurisdiction-tax.md (all 6 OQs resolved)
**Research:** .ai/research/multi-jurisdiction-tax.md
**Upstream:** crbnos/carbon#1036 (Phase 1 only — no Phase 2/3, nothing under packages/ee)
**Branches:** four PR slices, each branched off `main` after the previous merges:
`feat/tax-phase1-a-schema` → `feat/tax-phase1-b-determination` → `feat/tax-phase1-c-posting` → `feat/tax-phase1-d-surfaces`

## Spec corrections discovered during planning (bake into every task)

1. **`country` has no integer `id`.** PK is `alpha2` CHAR(2) (`20240928155702_country-codes.sql` dropped `id`). The spec's `countryId INTEGER` becomes **`"countryCode" TEXT REFERENCES "country"("alpha2")`** everywhere. Addresses live in the `address` table (`countryCode`, `stateProvince`), reached via `customerLocation.addressId` / `supplierLocation.addressId`.
2. **Purchase lines cannot store a resolved `taxPercent`.** `purchaseOrderLine.taxPercent`/`taxAmount` and `purchaseInvoiceLine.taxPercent`/`taxAmount` are `GENERATED ALWAYS … STORED` from `supplierTaxAmount` (`20250128195311`, `20250807094441`, `20250204164256`). Purchase-side determination writes **`supplierTaxAmount`** (foreign currency); the generated columns derive the rest. Sales-side determination writes `taxPercent` directly.
3. **The three tax accounts already exist and are seeded** — `accountDefault.salesTaxPayableAccount` / `purchaseTaxPayableAccount` / `reverseChargeSalesTaxPayableAccount` are NOT NULL, FK'd, form-editable, seeded to accounts 2210/2220/2230 (`lib/seed.data.ts:672-674,798-800`), and read by zero posting paths (verified). No migration needed for them; PR-C just starts reading them by id (per the lessons.md control-account rule).
4. **Memo `amount` semantics untouched** — the 6 AR/AP RPCs (`get_ar_tie_out` etc., newest defs in `20260702224219_fix-ar-ap-legacy-paid.sql`) read `memo.amount` gross. Adding `memo.taxAmount` (tax carved out *within* the gross) requires **no RPC changes**. Do not touch those RPCs.
5. **Overrides are audit-logged for free** — quote/sales-order/invoice line tables are already covered by the trigger→PGMQ→Inngest audit pipeline. A normal `.update()` of `taxCodeId`/`taxPercent` produces the audit row (OQ 3). No `insertAuditLogEntries` calls needed.
6. **PDF tax block = an option on the existing `summary` block**, not a new block type. A new `DocumentBlockType` is an Ask-First 9-registry fan-out; extending `summaryOptionsSchema` touches 4 files and needs no registry churn.

## Upstream coordination gates (PR-C only)

PR-A/B touch no `post-*` function and can proceed immediately. **PR-C must not start until upstream #1030/#1298 (FX convention) and #1165/#1161 (tax-posting split) resolve** — if #1165's `shared/sales-invoice-amounts.ts` lands first, PR-C's sales-side edits rebase onto that helper instead of the inline math at `post-sales-invoice/index.ts:321-349`. State any deviation from the spec in the PR body as a question.

## Validation commands used throughout

```bash
pnpm exec turbo run typecheck --filter=erp            # app typecheck (scoped — whole-repo OOMs)
pnpm exec turbo run typecheck --filter=@carbon/database
pnpm exec turbo run typecheck --filter=@carbon/documents
pnpm run lint
cd apps/erp && pnpm exec vitest run app/modules/accounting/accounting.utils.test.ts   # apps/erp has NO test script — pnpm --filter erp test is a silent no-op
cd packages/database/supabase/functions && deno test <dir-or-file>   # edge-fn tests (NOT wired into turbo — run manually)
```

Edge-function type gate (lessons.md): `deno check` is never clean repo-wide; gate on the **delta** of errors attributed to the touched file vs `git show HEAD:<path>`.

## Progress

- [x] Task 1: Create the Phase-1 tax migration (tables + enums + RLS)
- [x] Task 2: Add tax columns to existing tables + view exposure
- [ ] Task 3: Regenerate DB types
- [ ] Task 4: Tax validators + const enums in accounting.models.ts
- [ ] Task 5: Tax CRUD service functions in accounting.service.ts
- [ ] Task 6: Compound-aware effective-rate math in accounting.utils.ts (+ tests)
- [ ] Task 7: path.to entries + tax-authorities routes (4 files)
- [ ] Task 8: tax-codes routes (4 files) with inline components editor
- [ ] Task 9: tax-registrations routes (4 files)
- [ ] Task 10: ui/Tax components (tables + drawer forms)
- [ ] Task 11: "Tax" nav group in useAccountingSubmodules
- [ ] Task 12: item.taxable switch in Properties panels + bulk update route
- [ ] Task 13: Tax code assignment selects on CustomerTaxForm / SupplierTaxForm / location drawers
- [ ] Task 14: suggestTaxCode service + address-match suggestion UI
- [ ] Task 15: PR-A gate — typecheck, lint, browser verification, PR
- [ ] Task 16: resolveLineTaxes determination core (pure fn + service + tests)
- [ ] Task 17: TaxCode form selector component + api route
- [ ] Task 18: Wire determination into sales line create/edit paths
- [ ] Task 19: Wire determination into purchase line create/edit paths
- [ ] Task 20: Recalculate-taxes actions on ship-to change
- [ ] Task 21: PR-B gate — typecheck, tests, browser verification, PR
- [ ] Task 22: Shared posting-time tax resolver (functions/shared/resolve-taxes.ts + deno tests)
- [ ] Task 23: Corrected sales posting + taxLedger writes in post-sales-invoice
- [ ] Task 24: Corrected purchase posting (recoverable / reverse charge) in post-purchase-invoice
- [ ] Task 25: Memo tax split in post-memo + golden-master tests
- [ ] Task 26: shippingIsTaxable setting (toggle UI + posting behavior)
- [ ] Task 27: PR-C gate — legacy-invariance tests, deno check deltas, browser verification, PR
- [ ] Task 28: PDF tax breakdown block + registration/invoiceMessage printing
- [ ] Task 29: Tax liability report (service + route + table + CSV)
- [ ] Task 30: customer/supplier taxPercent sunset UX
- [ ] Task 31: PR-D gate — full acceptance-criteria browser verification, PR

## Dependencies

- Tasks 1→2→3 strictly sequential (migration → columns/views → types).
- Tasks 4–6 need Task 3 (types). Tasks 7–9 need 4–5. Task 10 needs 4–6; Tasks 7–9 and 10 are written together in practice (routes import the components). Tasks 11–14 independent of each other, all need 3–5.
- Task 16 needs Task 3; 17 needs 5; 18–20 need 16+17. Tasks 18 and 19 are independent of each other.
- Task 22 needs Task 3 only; 23–25 need 22; 23, 24, 25 independent of each other. Task 26 needs 23.
- Task 28 needs PR-A schema + Task 16 (live computation for drafts); 29 needs taxLedger rows (PR-C merged); 28 and 29–30 independent of each other.
- **PR-C (22–27) additionally gated on upstream #1030/#1165 resolution — see coordination note.**

---

# PR-A — Schema + config CRUD (no behavior change)

## Task 1: Create the Phase-1 tax migration (tables + enums + RLS)

**Depends on:** none
**Files:**
- Create: `packages/database/supabase/migrations/<timestamp>_multi-jurisdiction-tax.sql` (via `pnpm db:migrate:new multi-jurisdiction-tax` — never hand-pick the timestamp; verify it sorts after `20260720094011_model-original-size.sql`)
- Copy from (precedent): `packages/database/supabase/migrations/20260317233050_cost-centers.sql` (four RLS policies), `20260609143732_document-template.sql` (composite-PK table shape), `20260630093809_ar-ap-payments.sql` (idempotency guards, enum DO-block)

**Steps:**

1. Run `pnpm db:migrate:new multi-jurisdiction-tax`.
2. Write the migration. Every statement idempotency-guarded (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$`). Full DDL:

```sql
-- Enums
DO $$ BEGIN
  CREATE TYPE "taxCalculationType" AS ENUM ('Normal', 'Reverse Charge');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "taxReportingCategory" AS ENUM
    ('Standard', 'Reduced', 'Zero-Rated', 'Exempt', 'Reverse Charge', 'Export', 'Out of Scope');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "taxLedgerSource" AS ENUM ('Sales', 'Purchase');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tax authority: who you remit to
CREATE TABLE IF NOT EXISTS "taxAuthority" (
  "id" TEXT NOT NULL DEFAULT id(),
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "supplierId" TEXT,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  "customFields" JSONB,
  PRIMARY KEY ("id", "companyId"),
  FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE,
  FOREIGN KEY ("supplierId", "companyId") REFERENCES "supplier"("id", "companyId")
);
DO $$ BEGIN
  ALTER TABLE "taxAuthority" ADD CONSTRAINT "taxAuthority_companyId_name_key" UNIQUE ("companyId", "name");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "taxAuthority_companyId_idx" ON "taxAuthority" ("companyId");
CREATE INDEX IF NOT EXISTS "taxAuthority_supplierId_idx" ON "taxAuthority" ("supplierId");
CREATE INDEX IF NOT EXISTS "taxAuthority_createdBy_idx" ON "taxAuthority" ("createdBy");

-- Tax code: a named treatment
CREATE TABLE IF NOT EXISTS "taxCode" (
  "id" TEXT NOT NULL DEFAULT id(),
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "calculationType" "taxCalculationType" NOT NULL DEFAULT 'Normal',
  "reportingCategory" "taxReportingCategory" NOT NULL DEFAULT 'Standard',
  "invoiceMessage" TEXT,
  "countryCode" TEXT REFERENCES "country"("alpha2"),
  "state" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  "customFields" JSONB,
  PRIMARY KEY ("id", "companyId"),
  FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE
);
DO $$ BEGIN
  ALTER TABLE "taxCode" ADD CONSTRAINT "taxCode_companyId_name_key" UNIQUE ("companyId", "name");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "taxCode_companyId_idx" ON "taxCode" ("companyId");
CREATE INDEX IF NOT EXISTS "taxCode_companyId_countryCode_state_idx" ON "taxCode" ("companyId", "countryCode", "state");
CREATE INDEX IF NOT EXISTS "taxCode_createdBy_idx" ON "taxCode" ("createdBy");

-- Tax code component: 1..n per code
CREATE TABLE IF NOT EXISTS "taxCodeComponent" (
  "id" TEXT NOT NULL DEFAULT id(),
  "companyId" TEXT NOT NULL,
  "taxCodeId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "taxAuthorityId" TEXT,
  "rate" NUMERIC NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 1,
  "isCompound" BOOLEAN NOT NULL DEFAULT FALSE,
  "isRecoverable" BOOLEAN NOT NULL DEFAULT FALSE,
  "salesTaxAccountId" TEXT,
  "purchaseTaxAccountId" TEXT,
  "effectiveDate" DATE,
  "expirationDate" DATE,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY ("id", "companyId"),
  FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE,
  FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId") ON DELETE CASCADE,
  FOREIGN KEY ("taxAuthorityId", "companyId") REFERENCES "taxAuthority"("id", "companyId"),
  CONSTRAINT "taxCodeComponent_rate_check" CHECK ("rate" >= 0 AND "rate" <= 1),
  CONSTRAINT "taxCodeComponent_dates_check" CHECK ("expirationDate" IS NULL OR "effectiveDate" IS NULL OR "expirationDate" > "effectiveDate")
);
CREATE INDEX IF NOT EXISTS "taxCodeComponent_companyId_idx" ON "taxCodeComponent" ("companyId");
CREATE INDEX IF NOT EXISTS "taxCodeComponent_taxCodeId_idx" ON "taxCodeComponent" ("taxCodeId", "companyId");
CREATE INDEX IF NOT EXISTS "taxCodeComponent_taxAuthorityId_idx" ON "taxCodeComponent" ("taxAuthorityId");
CREATE INDEX IF NOT EXISTS "taxCodeComponent_createdBy_idx" ON "taxCodeComponent" ("createdBy");

-- Tax registration: company registrations that print on documents
CREATE TABLE IF NOT EXISTS "taxRegistration" (
  "id" TEXT NOT NULL DEFAULT id(),
  "companyId" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL REFERENCES "country"("alpha2"),
  "state" TEXT,
  "registrationNumber" TEXT NOT NULL,
  "effectiveDate" DATE,
  "endDate" DATE,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  "customFields" JSONB,
  PRIMARY KEY ("id", "companyId"),
  FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "taxRegistration_companyId_idx" ON "taxRegistration" ("companyId");
CREATE INDEX IF NOT EXISTS "taxRegistration_createdBy_idx" ON "taxRegistration" ("createdBy");

-- Immutable tax subledger (written by posting functions; PR-C)
CREATE TABLE IF NOT EXISTS "taxLedger" (
  "id" TEXT NOT NULL DEFAULT id('txl'),
  "companyId" TEXT NOT NULL,
  "source" "taxLedgerSource" NOT NULL,
  "documentType" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "documentLineId" TEXT,
  "journalId" TEXT,
  "postingDate" DATE NOT NULL,
  "taxCodeId" TEXT,
  "taxCodeComponentId" TEXT,
  "componentName" TEXT,
  "taxAuthorityId" TEXT,
  "customerId" TEXT,
  "supplierId" TEXT,
  "rate" NUMERIC NOT NULL DEFAULT 0,
  "taxableAmount" NUMERIC NOT NULL DEFAULT 0,
  "taxAmount" NUMERIC NOT NULL DEFAULT 0,
  "exemptAmount" NUMERIC NOT NULL DEFAULT 0,
  "taxExemptionReason" "taxExemptionReason",
  "exemptionCertificateNumber" TEXT,
  "currencyCode" TEXT,
  "exchangeRate" NUMERIC,
  "taxReturnId" TEXT,
  "needsEngineReconciliation" BOOLEAN NOT NULL DEFAULT FALSE,
  "postedToInputAccount" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdBy" TEXT NOT NULL REFERENCES "user"("id"),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedBy" TEXT REFERENCES "user"("id"),
  "updatedAt" TIMESTAMP WITH TIME ZONE,
  PRIMARY KEY ("id", "companyId"),
  FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE,
  FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId"),
  FOREIGN KEY ("taxAuthorityId", "companyId") REFERENCES "taxAuthority"("id", "companyId"),
  FOREIGN KEY ("customerId", "companyId") REFERENCES "customer"("id", "companyId"),
  FOREIGN KEY ("supplierId", "companyId") REFERENCES "supplier"("id", "companyId")
);
CREATE INDEX IF NOT EXISTS "taxLedger_companyId_postingDate_idx" ON "taxLedger" ("companyId", "postingDate");
CREATE INDEX IF NOT EXISTS "taxLedger_companyId_documentId_idx" ON "taxLedger" ("companyId", "documentId");
CREATE INDEX IF NOT EXISTS "taxLedger_companyId_taxAuthorityId_idx" ON "taxLedger" ("companyId", "taxAuthorityId");
CREATE INDEX IF NOT EXISTS "taxLedger_companyId_taxReturnId_idx" ON "taxLedger" ("companyId", "taxReturnId");
CREATE INDEX IF NOT EXISTS "taxLedger_createdBy_idx" ON "taxLedger" ("createdBy");
```

   Notes baked in: `taxLedger` carries `updatedBy` even though append-only (lessons.md: audit-injection requires it); `documentType` is TEXT per spec (NOT the `journalLineDocumentType` enum — lessons.md warns the journal/ledger enums differ); bare `NUMERIC` everywhere (house rule: never a precision spec); `rate` check 0..1.

3. RLS — for each of the five tables, `ALTER TABLE "public"."<t>" ENABLE ROW LEVEL SECURITY;` then exactly four policies copied from `20260317233050_cost-centers.sql` L20-48, each preceded by `DROP POLICY IF EXISTS`: `SELECT` via `get_companies_with_employee_role()`, `INSERT`/`UPDATE`/`DELETE` via `get_companies_with_employee_permission('accounting_create' | 'accounting_update' | 'accounting_delete')`, helper results cast `::text[]`. `taxLedger` gets the same four (writes actually happen via service-role Kysely in PR-C; the INSERT policy is defined for completeness per the spec).
4. Register custom fields: first `grep -rn "INSERT INTO \"customFieldTable\"" packages/database/supabase/migrations/ | tail -5` and check the `module` enum contains `'Accounting'` (`grep -n "CREATE TYPE \"module\"" packages/database/supabase/migrations/*.sql` + later `ALTER TYPE "module" ADD VALUE`). If `'Accounting'` exists, add:
   ```sql
   INSERT INTO "customFieldTable" ("table", "name", "module")
   VALUES ('taxCode', 'Tax Code', 'Accounting'), ('taxAuthority', 'Tax Authority', 'Accounting'), ('taxRegistration', 'Tax Registration', 'Accounting')
   ON CONFLICT ("table") DO NOTHING;
   ```
   If `'Accounting'` is NOT a `module` enum value, omit the registrations entirely (the `customFields` columns stay; registration can follow later) and note it in the PR body.

**Verify:**
```bash
ls packages/database/supabase/migrations/ | tail -3
# Expected: the new file sorts after 20260720094011_model-original-size.sql, HHMMSS not 000000
pnpm db:migrate
# Expected: applies cleanly; run it TWICE — second run must also succeed (idempotency)
```

**Out of scope:** `taxReturn` / `taxReturnLayout` / `taxReturnLayoutLine` / `taxReturnStatus` enum (Phase 2). Seeding any tax codes/authorities. Any trigger. Do NOT rebuild the database — only `pnpm db:migrate` against the running local stack.

## Task 2: Add tax columns to existing tables + view exposure

**Depends on:** Task 1 (same migration file — append to it)
**Files:**
- Modify: the Task-1 migration file — append column adds + conditional view recreations

**Steps:**

1. Append the column additions (idempotent):

```sql
ALTER TABLE "item" ADD COLUMN IF NOT EXISTS "taxable" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "customer" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "customerLocation" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "supplier" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "companySettings" ADD COLUMN IF NOT EXISTS "shippingIsTaxable" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "quoteLine" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "salesOrderLine" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "salesInvoiceLine" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "purchaseOrderLine" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "purchaseInvoiceLine" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "memo" ADD COLUMN IF NOT EXISTS "taxCodeId" TEXT;
ALTER TABLE "memo" ADD COLUMN IF NOT EXISTS "taxAmount" NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE "accountDefault" ADD COLUMN IF NOT EXISTS "taxSettlementAccount" TEXT;
```

2. Add composite FKs `("taxCodeId","companyId") REFERENCES "taxCode"("id","companyId")` (each in a `DO $$ … duplicate_object` guard, named `<table>_taxCodeId_fkey`) for: `customer`, `supplier`, `quoteLine`, `salesOrderLine`, `salesInvoiceLine`, `purchaseOrderLine`, `purchaseInvoiceLine`, `memo`. For `customerLocation`: first check it has a `companyId` column (`grep -n "customerLocation" packages/database/supabase/migrations/20230123004612_suppliers-and-customers.sql` and later migrations). **If `customerLocation` has no `companyId`, STOP and report — do not invent a single-column FK** (taxCode's PK is composite; app-level validation would be the fallback, but that's a decision for review). Add `accountDefault.taxSettlementAccount` FK to `account("id")` mirroring the constraint shape of `accountDefault_salesTaxPayableAccount_fkey` in `20260228023426_company-groups.sql:459-464`. Same for `taxCodeComponent.salesTaxAccountId` / `purchaseTaxAccountId` (add in Task 1's table or here — one place only).
3. Index every new FK column: `CREATE INDEX IF NOT EXISTS "<table>_taxCodeId_idx" ON "<table>" ("taxCodeId")` for all nine tables.
4. View exposure. For each view below, open the file containing its NEWEST definition and check whether it projects the base table with a bare `<alias>.*`:
   - `customers`, `suppliers` → `20260521124731_supplier-customer-readable-id.sql`
   - `quoteLines` → `20260513120000_line-item-sort-order.sql`
   - `salesOrderLines`, `salesInvoiceLines`, `purchaseInvoiceLines` → `20260524143827_fixed-assets.sql`
   - `purchaseOrderLines` → `20260529120000_purchase-order-line-supplier-part.sql`
   If a view already selects `alias.*` from its base table, the new `taxCodeId` column flows through — no recreation. If it enumerates columns, fork the FULL newest definition verbatim into this migration (first `grep -l '"<viewName>"' packages/database/supabase/migrations/*.sql | sort` to confirm no newer definition exists — lessons.md sibling-branch rule), add the `"taxCodeId"` (and for `customers`/`suppliers` also nothing else) projection, and recreate with `DROP VIEW IF EXISTS` + `CREATE OR REPLACE VIEW … WITH(SECURITY_INVOKER=true)`, preserving any `::numeric(10,2)` typmod casts (the `purchaseInvoices` typmod trap in `20260604120000`).
5. Do NOT touch `salesInvoices` / `purchaseInvoices` totals views or the AR/AP RPCs — totals math is unchanged in Phase 1 (line `taxPercent` remains the single source for totals).

**Verify:**
```bash
pnpm db:migrate   # run twice — idempotent
psql "$DATABASE_URL" -c '\d "taxCode"' -c '\d "customerLocation"' | head -50
# Expected: taxCodeId columns present with composite FKs; customerLocation resolved per step 2
psql "$DATABASE_URL" -c 'SELECT "taxCodeId" FROM "quoteLines" LIMIT 0;'
# Expected: no error (column reaches the view)
```

**Out of scope:** Backfill of any kind (spec: no backfill). Changing `customer.taxPercent` / `supplier.taxPercent`. The `salesInvoices`/`purchaseInvoices` totals views. Generated purchase-line columns.

## Task 3: Regenerate DB types

**Depends on:** Tasks 1–2
**Files:**
- Modify (generated): `packages/database/src/types.ts`, `packages/database/supabase/functions/lib/types.ts`

**Steps:**
1. `pnpm run generate:types`
2. Never hand-edit the generated output.

**Verify:**
```bash
grep -c "taxLedger" packages/database/src/types.ts
# Expected: > 0
pnpm exec turbo run typecheck --filter=@carbon/database
# Expected: exit 0
```

**Out of scope:** Fixing app typecheck errors here (they belong to later tasks).

## Task 4: Tax validators + const enums in accounting.models.ts

**Depends on:** Task 3
**Files:**
- Modify: `apps/erp/app/modules/accounting/accounting.models.ts` — append validators
- Copy from (precedent): `paymentTermValidator` in the same file (L375-401) for shape; `dimensionValidator` (L594-603) for parent+children

**Steps:**
1. Add const tuples: `taxCalculationTypes = ["Normal", "Reverse Charge"] as const`, `taxReportingCategories = ["Standard", "Reduced", "Zero-Rated", "Exempt", "Reverse Charge", "Export", "Out of Scope"] as const`.
2. Add `taxAuthorityValidator`: `{ id: zfd.text(z.string().optional()), name: z.string().min(1, ...), supplierId: zfd.text(z.string().optional()) }`.
3. Add `taxCodeComponentValidator` (used for JSON-parsed rows, not FormData): `z.object({ id: z.string().optional(), name: z.string().min(1), taxAuthorityId: z.string().optional().nullable(), rate: z.number().min(0).max(1), sequence: z.number().int().min(1).default(1), isCompound: z.boolean().default(false), isRecoverable: z.boolean().default(false), salesTaxAccountId: z.string().optional().nullable(), purchaseTaxAccountId: z.string().optional().nullable(), effectiveDate: z.string().optional().nullable(), expirationDate: z.string().optional().nullable() }).refine(…expiration > effective when both set…)`.
4. Add `taxCodeValidator`: `{ id: zfd.text(z.string().optional()), name: z.string().min(1), description: zfd.text(z.string().optional()), calculationType: z.enum(taxCalculationTypes).default("Normal"), reportingCategory: z.enum(taxReportingCategories).default("Standard"), invoiceMessage: zfd.text(z.string().optional()), countryCode: zfd.text(z.string().optional()), state: zfd.text(z.string().optional()), components: zfd.text(z.string()) }` — `components` is the JSON-serialized child rows (StorageRule `RuleBuilder` pattern); the route action parses it and validates with `z.array(taxCodeComponentValidator).min(1)`.
5. Add `taxRegistrationValidator`: `{ id: zfd.text(z.string().optional()), countryCode: z.string().min(1), state: zfd.text(z.string().optional()), registrationNumber: z.string().min(1), effectiveDate: zfd.text(z.string().optional()), endDate: zfd.text(z.string().optional()) }`.
6. Add derived types to `apps/erp/app/modules/accounting/types.ts` following the `PaymentTerm` pattern (L377): `TaxCode`, `TaxAuthority`, `TaxRegistration` from the service return types.

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0 (nothing consumes the validators yet)
```

**Out of scope:** Line-validator changes (`quoteLineValidator` etc. — PR-B).

## Task 5: Tax CRUD service functions in accounting.service.ts

**Depends on:** Tasks 3–4
**Files:**
- Modify: `apps/erp/app/modules/accounting/accounting.service.ts`
- Copy from (precedent): `getPaymentTerms`/`upsertPaymentTerm`/`deletePaymentTerm` (L2008/L2135/L362) for singles; `upsertDimension` (L2286-2360) for the parent+children reconcile

**Steps:**
1. Add, following the exact naming/shape conventions (client first arg, `{data, error}` return, never throw, `.eq("companyId", companyId)` on every query, `sanitize()` on updates, `setGenericQueryFilters` with default sort `name` asc):
   - `getTaxAuthority(client, id)`, `getTaxAuthorities(client, companyId, args)`, `getTaxAuthoritiesList(client, companyId)`, `upsertTaxAuthority(client, taxAuthority)`, `deleteTaxAuthority(client, id)` (hard `.delete()` — deletion fails on FK if components reference it, which is the desired guard).
   - `getTaxCode(client, id)` — selects the code plus its components via a second query `client.from("taxCodeComponent").select("*").eq("taxCodeId", id).order("sequence")`; return both.
   - `getTaxCodes(client, companyId, args)` (filter `.eq("active", true)`), `getTaxCodesList(client, companyId)` (`.select("id, name").eq("active", true)`).
   - `upsertTaxCode(client, taxCode, components)` — parent upsert first, then reconcile `taxCodeComponent` rows against the incoming array exactly like `upsertDimension`: delete ids no longer present, update matched ids, insert new ones (stamp `companyId`, `createdBy`/`updatedBy`).
   - `deleteTaxCode(client, id)` — soft delete `.update({ active: false })` (accounting-module convention; posted documents may reference the code forever).
   - `getTaxRegistration(client, id)`, `getTaxRegistrations(client, companyId, args)`, `upsertTaxRegistration(client, taxRegistration)`, `deleteTaxRegistration(client, id)` (hard delete — nothing references it).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0
```

**Out of scope:** `resolveLineTaxes`, `suggestTaxCode`, `getTaxLiability` (Tasks 16, 14, 29).

## Task 6: Compound-aware effective-rate math in accounting.utils.ts (+ tests)

**Depends on:** Task 3
**Files:**
- Modify: `apps/erp/app/modules/accounting/accounting.utils.ts` — add pure functions
- Modify: `apps/erp/app/modules/accounting/accounting.utils.test.ts` — add cases
- Copy from (precedent): existing pure-function + test pairs in those two files

**Steps:**
1. Add a structural input type (NOT the generated Row type — keeps it dependency-free and mirrors what PR-C's Deno twin needs):
   ```ts
   export type EffectiveTaxComponent = {
     id: string; name: string; taxAuthorityId: string | null;
     rate: number; sequence: number; isCompound: boolean; isRecoverable: boolean;
     salesTaxAccountId: string | null; purchaseTaxAccountId: string | null;
     effectiveDate: string | null; expirationDate: string | null;
   };
   ```
2. `export function filterEffectiveComponents(components: EffectiveTaxComponent[], date: string): EffectiveTaxComponent[]` — keeps rows where `(effectiveDate ?? -∞) <= date <= (expirationDate ?? +∞)` — **both bounds INCLUSIVE**, normalizing each side to its first 10 chars (ISO day) before lexicographic compare; sorted by `sequence`. Rationale: the spec acceptance criterion pairs `expirationDate = 2026-06-30` with a successor effective `2026-07-01` and requires June 30 → old rate, July 1 → new; an exclusive upper bound would leave June 30 with no component at all. IMPLEMENTED and must stay identical to the Deno twin `packages/database/supabase/functions/shared/resolve-taxes.ts`.
3. `export function computeComponentTaxes(taxableBase: number, components: EffectiveTaxComponent[]): { componentId: string; base: number; tax: number }[]` — non-compound components apply `rate` to `taxableBase`; a component with `isCompound: true` applies its rate to `taxableBase + Σ(tax of all prior-sequence components)`. No rounding here (rounding happens once per journal amount at posting).
4. `export function computeEffectiveTaxPercent(taxableBase: number, components: EffectiveTaxComponent[]): number` — `Σ tax / taxableBase` guarded for base 0 (then `Σ` of simple rates with compound expansion computed against base 1).
5. Tests (Canadian fixtures — the driving use case): QC = GST 5% + QST 9.975% non-compound on 100 → 5.00 + 9.975, effective 0.14975; legacy compound-PST example (5% + 7% compound) on 100 → 5.00 + 7.35, effective 0.1235; effective-date boundary: component expiring `2026-06-30` + successor 8.5% effective `2026-07-01` → date `2026-06-30` picks 8.25%, `2026-07-01` picks 8.5% (spec acceptance criterion); empty components → 0.

**Verify:**
```bash
cd apps/erp && pnpm exec vitest run app/modules/accounting/accounting.utils.test.ts
# Expected: all new cases pass
```

**Out of scope:** Currency rounding (posting-time concern, PR-C). The Deno twin (Task 22).

## Task 7: path.to entries + tax-authorities routes (4 files)

**Depends on:** Tasks 4–5 (and Task 10's components, written together)
**Files:**
- Modify: `apps/erp/app/utils/path.ts` — add alphabetically-sorted entries: `taxAuthorities`, `taxAuthority(id)`, `newTaxAuthority`, `deleteTaxAuthority(id)`, and the Task-8/9 siblings (`taxCodes`, `taxCode(id)`, `newTaxCode`, `deleteTaxCode(id)`, `taxRegistrations`, `taxRegistration(id)`, `newTaxRegistration`, `deleteTaxRegistration(id)`, `taxLiability`) — all under `${x}/accounting/tax-…`
- Create: `apps/erp/app/routes/x+/accounting+/tax-authorities.tsx`, `tax-authorities.new.tsx`, `tax-authorities.$taxAuthorityId.tsx`, `tax-authorities.delete.$taxAuthorityId.tsx`
- Copy from (precedent): `apps/erp/app/routes/x+/accounting+/payment-terms.tsx`, `payment-terms.new.tsx`, `payment-terms.$paymentTermId.tsx`, `payment-terms.delete.$paymentTermId.tsx` — copy each file and adapt names/validators/services

**Steps:**
1. Mirror the payment-terms four-file structure exactly: `handle.breadcrumb`, `getGenericQueryFilters`, loader permissions `{ view: "accounting", role: "employee" }` (list) / `{ create | update | delete: "accounting" }` (mutations), `assertIsPost`, `validator(taxAuthorityValidator).validate(formData)`, modal-vs-page branch on `formData.get("type") === "modal"`, `throw redirect` on page-edit success, `ConfirmDelete` modal for delete, `setCustomFields(formData)` if custom fields were registered in Task 1.
2. List route renders `<TaxAuthoritiesTable data count />` + `<Outlet />` (component from Task 10).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0
```

**Out of scope:** nav wiring (Task 11).

## Task 8: tax-codes routes (4 files) with inline components editor

**Depends on:** Tasks 4–6
**Files:**
- Create: `apps/erp/app/routes/x+/accounting+/tax-codes.tsx`, `tax-codes.new.tsx`, `tax-codes.$taxCodeId.tsx`, `tax-codes.delete.$taxCodeId.tsx`
- Copy from (precedent): the payment-terms route set (structure); `apps/erp/app/routes/x+/accounting+/dimensions.new.tsx` (destructuring child rows into a separate `upsert` arg)

**Steps:**
1. Same four-file pattern. In `new`/`$taxCodeId` actions: after `validator(taxCodeValidator).validate(formData)`, `JSON.parse(validation.data.components)` and validate with `z.array(taxCodeComponentValidator).min(1).safeParse(...)`; on failure return `validationError`. Then `upsertTaxCode(client, { ...rest, companyId, createdBy|updatedBy: userId }, parsedComponents)`.
2. `$taxCodeId` loader calls `getTaxCode` (code + components) and passes both as `initialValues` (components re-serialized to JSON for the form's hidden field).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0
```

**Out of scope:** Address-match suggestion behavior (Task 14 — the `countryCode`/`state` fields are plain selects/inputs here).

## Task 9: tax-registrations routes (4 files)

**Depends on:** Tasks 4–5
**Files:**
- Create: `apps/erp/app/routes/x+/accounting+/tax-registrations.tsx`, `tax-registrations.new.tsx`, `tax-registrations.$taxRegistrationId.tsx`, `tax-registrations.delete.$taxRegistrationId.tsx`
- Copy from (precedent): payment-terms route set

**Steps:**
1. Same four-file pattern with `taxRegistrationValidator` / registration services.
2. In the list route loader, additionally fetch `getTaxCodes(client, companyId, …)` and compute the two cross-warning sets (spec): active codes whose `countryCode`/`state` have no active registration, and registrations with no matching code. Pass to the table component which renders them as a dismissible `Alert` above the table (use the existing `Alert` component from `@carbon/react` — grep `packages/react/src` for `Alert` usage precedent before writing).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0
```

**Out of scope:** Avalara nexus drift (Phase 3).

## Task 10: ui/Tax components (tables + drawer forms)

**Depends on:** Tasks 4–6
**Files:**
- Create: `apps/erp/app/modules/accounting/ui/Tax/TaxAuthoritiesTable.tsx`, `TaxAuthorityForm.tsx`, `TaxCodesTable.tsx`, `TaxCodeForm.tsx`, `TaxRegistrationsTable.tsx`, `TaxRegistrationForm.tsx`, `index.ts`
- Copy from (precedent): `apps/erp/app/modules/accounting/ui/PaymentTerms/PaymentTermsTable.tsx` + `PaymentTermForm.tsx` (table + ModalDrawer form pair); `apps/erp/app/modules/storage-rules/ui/StorageRuleForm.tsx` + `RuleBuilder.tsx`/`ConditionRow.tsx` (child-rows editor serialized to a `<Hidden>` JSON field); `apps/erp/app/modules/accounting/ui/JournalEntries/JournalEntryForm.tsx` (useState rows + generated client ids)

**Steps:**
1. Tables: memoized components with `useCustomColumns`, `renderContextMenu` gated on `permissions.can("update"|"delete", "accounting")`, `primaryAction` New button gated on `create`. CSV export is automatic via `<Table>` — give every JSX-header column a `meta.exportValue`.
2. `TaxAuthorityForm` / `TaxRegistrationForm`: plain ModalDrawer forms (`ValidatedForm validator={…} fetcher`, `<Hidden name="id" />`, `<Hidden name="type" value={type} />`, `<CustomFormFields table="…" />` if registered). Supplier select on authority form via the existing `Supplier` field from `~/components/Form`. Country select: grep `~/components/Form` for the existing country selector component (used by address forms) and reuse it for `countryCode`.
3. `TaxCodeForm`: ModalDrawer with head fields (name, description, calculationType select, reportingCategory select, invoiceMessage textarea, countryCode + state match fields) plus a components editor: local `useState<ComponentRow[]>` rows rendered as a compact grid (name, authority select, rate percent input, sequence, isCompound switch, isRecoverable switch, sales/purchase account selects via the existing GL `Account` field component in `~/components/Form`, effective/expiration date pickers), add/remove row buttons, whole array serialized into `<Hidden name="components" value={JSON.stringify(rows)} />` on every change (RuleBuilder pattern).
4. Effective-rate preview: below the rows, compute `computeEffectiveTaxPercent(1, filterEffectiveComponents(rows, today))` from Task 6 and render "Effective rate today: 14.975%".
5. All user-facing strings through Lingui (`t`/`msg`) per house i18n pattern (copy how PaymentTermForm does it).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp && pnpm run lint
# Expected: exit 0 / no new lint errors
```

**Out of scope:** Per-code Xero TaxType select (Phase 3).

## Task 11: "Tax" nav group in useAccountingSubmodules

**Depends on:** Tasks 7–9
**Files:**
- Modify: `apps/erp/app/modules/accounting/ui/useAccountingSubmodules.tsx` — add a `Tax` group between `Fixed Assets` (L89) and `Configure` (L106)

**Steps:**
1. Add group `{ name: t`Tax`, routes: [ Tax Codes → path.to.taxCodes, Tax Authorities → path.to.taxAuthorities, Tax Registrations → path.to.taxRegistrations ] }` with `role: "employee"` and icons chosen from the `react-icons/lu` set already imported in the file (e.g. `LuPercent`, `LuLandmark`, `LuFileBadge`). (The `tax-liability` report link is added in Task 29, under the existing `Reports` group.)
2. Do NOT add the routes to `accountingOnlyRoutes` — tax config must be reachable before `accountingEnabled` is on (codes are needed for determination even when GL posting is off).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0; manual check in Task 15 confirms sidebar + command palette
```

**Out of scope:** MES nav.

## Task 12: item.taxable switch in Properties panels + bulk update route

**Depends on:** Task 3
**Files:**
- Modify: `apps/erp/app/routes/x+/items+/update.tsx` — new `case "taxable"` (copy the `case "requiresInspection"` branch at L326-335 verbatim, swapping the column)
- Modify: `apps/erp/app/modules/items/ui/Parts/PartProperties.tsx` — `field` union at L163-177 gains `"taxable"`; add a `Boolean` switch copying the `requiresInspection` block at L766-775 (label "Taxable", `zfd.checkbox()` inline validator, `onUpdate("taxable", v ? "on" : "off")`)
- Modify: same switch in the four siblings: `apps/erp/app/modules/items/ui/Materials/MaterialProperties.tsx`, `ui/Tools/ToolProperties.tsx`, `ui/Consumables/ConsumableProperties.tsx`, `ui/Services/ServiceProperties.tsx`

**Steps:** as above — this is a mechanical copy of the `requiresInspection` pattern in six files.

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0. Browser check in Task 15: toggle Taxable on a part, reload, value persists.
```

**Out of scope:** Any consumption of `item.taxable` (PR-B).

## Task 13: Tax code assignment selects on CustomerTaxForm / SupplierTaxForm / location drawers

**Depends on:** Tasks 3, 5, 17's api route is NOT needed — use a loader-fed select here
**Files:**
- Modify: `apps/erp/app/modules/sales/ui/Customer/CustomerTaxForm.tsx` — add a Tax Code combobox (options = `getTaxCodesList`) above the `taxExempt` switch (L100)
- Modify: `apps/erp/app/routes/x+/customer+/$customerId.tax.tsx` — loader fetches `getTaxCodesList` + customer's current `taxCodeId`; action persists `taxCodeId` onto `customer` (extend `updateCustomerTax` in `apps/erp/app/modules/sales/sales.service.ts:3006` to also `.update({ taxCodeId })` on `customer`, or add a sibling `updateCustomerTaxCode` — pick ONE, mirror it on the supplier side)
- Modify: `apps/erp/app/modules/sales/sales.models.ts` — `customerTaxValidator` (L83-101) gains `taxCodeId: zfd.text(z.string().optional())`
- Modify: `apps/erp/app/modules/purchasing/ui/Supplier/SupplierTaxForm.tsx`, `apps/erp/app/routes/x+/supplier+/$supplierId.tax.tsx`, `purchasing.models.ts` `supplierTaxValidator` (L362) — mirror
- Modify: `apps/erp/app/modules/sales/ui/Customer/CustomerLocationForm.tsx` + `apps/erp/app/routes/x+/customer+/$customerId.locations.$customerLocationId.tsx` and `…locations.new.tsx` — add the override select; `customerLocationValidator` (`sales.models.ts:61`) gains `taxCodeId`. **CRITICAL:** the location action destructures `{ id, addressId, name, ...address }` and sends the rest to the `address` table — `taxCodeId` MUST be destructured out explicitly and routed to `customerLocation`, or it will be written into `address` and fail
- Modify: supplier-location mirror: `apps/erp/app/modules/purchasing/ui/Supplier/SupplierLocationForm.tsx`, routes `x+/supplier+/$supplierId.locations.$supplierLocationId.tsx` / `.new`, validator `purchasing.models.ts:397`, services `insertSupplierLocation`/`updateSupplierLocation`

**Steps:** as listed per file. The combobox uses the plain `Select`/`Combobox` from `~/components/Form` fed by loader data (no new api route needed at this slice).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0. Browser check in Task 15: assign a code to a customer and to one of its
# locations; reload both forms — values persist; psql confirms customerLocation.taxCodeId set.
```

**Out of scope:** Using the assignment in any calculation (PR-B). The bulk "Assign tax code" table action (Task 30).

## Task 14: suggestTaxCode service + address-match suggestion UI

**Depends on:** Tasks 5, 13
**Files:**
- Modify: `apps/erp/app/modules/accounting/accounting.service.ts` — add `suggestTaxCode(client, companyId, { countryCode, state })`: `.from("taxCode").select("id, name").eq("companyId", companyId).eq("active", true).eq("countryCode", countryCode)` then prefer exact `state` match (`.eq("state", state)` first; if zero rows, retry with `.is("state", null)`)
- Create: `apps/erp/app/routes/api+/accounting.suggest-tax-code.ts` — GET with `countryCode`/`state` search params, `requirePermissions { view: "accounting" }`, returns the suggestion list (copy the shape of an existing `api+/accounting.*.ts` route, e.g. `accounting.currencies.ts`)
- Modify: `CustomerLocationForm.tsx` / `SupplierLocationForm.tsx` / `CustomerTaxForm.tsx` / `SupplierTaxForm.tsx` — when the form's address (or the party's primary location address) has a country, `useFetcher` the api route and, if a suggestion exists and differs from the current value, render an inline dismissible hint: "This address is in {state}, {country} — apply {code name}?" with an Apply button that sets the select value

**Steps:** as above. The location's address country/state come from the `AddressAutocomplete` values already present in the form; for the party-level forms fetch the primary location's address in the route loader.

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0. Browser check in Task 15: create a code with countryCode=CA state=QC;
# edit a customer location with a QC address → the hint appears; Apply sets the select.
```

**Out of scope:** Document-time address inference (explicitly forbidden by the spec).

## Task 15: PR-A gate — typecheck, lint, browser verification, PR

**Depends on:** Tasks 1–14
**Steps:**
1. `pnpm exec turbo run typecheck --filter=erp --filter=@carbon/database` and `pnpm run lint` — green.
2. Run `/translate` if the i18n gate flags missing `.po` strings for the new UI text.
3. Browser verification via the `/auth` + `/test` skills against the local dev stack: create authority "Revenu Québec"; create code "QC – TPS+TVQ" with components TPS 5% (sequence 1) + TVQ 9.975% (sequence 2, non-compound) → effective-rate preview shows 14.975%; create registration CA/QC; assign the code to a customer + a location; toggle Taxable off on an item; confirm zero behavior change on an untouched quote→invoice flow (line taxPercent still defaults from `customer.taxPercent`).
4. Commit via `/check-and-commit`; open PR `feat: multi-jurisdiction tax Phase 1a — schema + tax configuration` with "Tracking spec: .ai/specs/2026-07-03-multi-jurisdiction-tax.md", what-was-tested notes, and the Task-1/2 escape-hatch outcomes (module enum, customerLocation.companyId, which views needed recreation).

**Out of scope:** merging without review.

---

# PR-B — Determination (behavior only when codes are assigned)

## Task 16: resolveLineTaxes determination core (pure fn + service + tests)

**Depends on:** PR-A merged
**Files:**
- Modify: `apps/erp/app/modules/accounting/accounting.utils.ts` — add pure `resolveTaxesFromInputs`
- Modify: `apps/erp/app/modules/accounting/accounting.utils.test.ts` — cases
- Modify: `apps/erp/app/modules/accounting/accounting.service.ts` — add `resolveLineTaxes`

**Steps:**
1. Pure core (testable, no I/O):
   ```ts
   export type ResolveTaxesInputs = {
     source: "sales" | "purchase";
     partyTaxExempt: boolean;
     partyExemptionReason: string | null;
     partyExemptionCertificateNumber: string | null;
     itemTaxable: boolean | null;          // null = no item on the line (e.g. comment/service w/o item)
     locationTaxCodeId: string | null;     // ship-to override
     partyTaxCodeId: string | null;
     componentsByCode: Record<string, EffectiveTaxComponent[]>;  // pre-fetched, pre-date-filtered
     legacyTaxPercent: number;             // customer.taxPercent fallback
   };
   export type ResolvedLineTaxes = {
     taxCodeId: string | null;
     taxPercent: number;
     components: EffectiveTaxComponent[];
     exempt: boolean;
     exemptionReason: string | null;
     exemptionCertificateNumber: string | null;
   };
   export function resolveTaxesFromInputs(i: ResolveTaxesInputs): ResolvedLineTaxes
   ```
   Algorithm exactly per spec: (1) sales-side `partyTaxExempt` → `{ taxCodeId: null, taxPercent: 0, exempt: true, reason, cert }`; (2) `itemTaxable === false` → zero tax, `exempt: true`, no reason; (3) code = `locationTaxCodeId ?? partyTaxCodeId`; if found → `taxPercent = computeEffectiveTaxPercent(...)` from its effective components; (4) no code → `{ taxCodeId: null, taxPercent: legacyTaxPercent }` (today's behavior).
2. Service wrapper `resolveLineTaxes(client, companyId, args: { source; customerId?; supplierId?; customerLocationId?; itemId?; date: string })` — fetches `customerTax`/`supplierTax` (exempt flags), `item.taxable`, location + party `taxCodeId`s, the codes' components (one `.in("taxCodeId", [...])` query), date-filters via `filterEffectiveComponents(components, args.date)`, then delegates to the pure core. Returns `{ data: ResolvedLineTaxes, error }`, never throws. Purchase side note: `supplierTax.taxExempt` does NOT short-circuit (exemption semantics are sales-side per spec step 1; supplier invoices are authoritative) — the purchase path only resolves `supplierLocation`-less `supplier.taxCodeId`.
3. Tests for the pure core: exempt customer beats everything; non-taxable item beats codes; location code beats customer code; no code falls back to `legacyTaxPercent`; QC two-component math; date filtering already covered by Task 6.

**Verify:**
```bash
cd apps/erp && pnpm exec vitest run app/modules/accounting/accounting.utils.test.ts
pnpm exec turbo run typecheck --filter=erp
# Expected: green
```

**Out of scope:** Posting-time recomputation (Task 22). Avalara dispatch (Phase 3).

## Task 17: TaxCode form selector component + api route

**Depends on:** Task 16
**Files:**
- Create: `apps/erp/app/routes/api+/accounting.tax-codes.ts` — list route returning `getTaxCodesList`, copy `apps/erp/app/routes/api+/accounting.currencies.ts` structure + permissions
- Create: `apps/erp/app/components/Form/TaxCode.tsx` — combobox field fetching that api route; copy the closest existing api-backed selector in `apps/erp/app/components/Form/` (grep for a component using `useFetcher` against an `api+/accounting.*` route — `Currency` or `Account` are candidates; copy whichever fetches a list by companyId)
- Modify: `apps/erp/app/components/Form/index.ts` — export `TaxCode`
- Create: `apps/erp/app/routes/api+/accounting.resolve-taxes.ts` — GET with `source`, `customerId`/`supplierId`, `customerLocationId`, `itemId`, `date` params; `requirePermissions` with `view: "sales"` OR `view: "purchasing"` per `source`; calls `resolveLineTaxes`; returns the resolved object (powers client-side recalculation)

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0
```

**Out of scope:** wiring into forms (Tasks 18–19).

## Task 18: Wire determination into sales line create/edit paths

**Depends on:** Tasks 16–17
**Files:**
- Modify: `apps/erp/app/modules/sales/sales.models.ts` — `quoteLineValidator` (taxPercent at L350) and `salesOrderLineValidator` (L773) gain `taxCodeId: zfd.text(z.string().optional())`
- Modify: `apps/erp/app/modules/invoicing/invoicing.models.ts` — sales invoice line validator (taxPercent at L261) gains `taxCodeId`
- Modify (server stamping on create): the new-line route actions — `apps/erp/app/routes/x+/quote+/$quoteId.new.tsx`, `x+/sales-order+/$orderId.new.tsx`, `x+/sales-invoice+/$invoiceId.new.tsx` — after validation and before the `upsert*Line` call, invoke `resolveLineTaxes(client, companyId, { source: "sales", customerId, customerLocationId: <document ship-to location id if set>, itemId, date: <document date> })` and stamp `taxCodeId` + `taxPercent` onto the insert payload **unless the submitted form carried an explicit `taxCodeId`** (override wins; when an override code is present, recompute `taxPercent` server-side from that code via `getTaxCode` + Task-6 math — never trust the client's percent when a code is set)
- Modify (edit paths): `x+/quote+/$quoteId.$lineId.details.tsx` and `x+/sales-order+/$orderId.$lineId.details.tsx` and `x+/sales-invoice+/$invoiceId.$lineId.details.tsx` actions — same rule: if `taxCodeId` present in the payload, recompute `taxPercent` from it server-side
- Modify (forms): `apps/erp/app/modules/sales/ui/Quotes/QuoteLineForm.tsx` (taxPercent input at L495), `ui/SalesOrder/SalesOrderLineForm.tsx` (L831, L1005), `apps/erp/app/modules/invoicing/ui/SalesInvoice/SalesInvoiceLineForm.tsx` (L692, L877) — add `<TaxCode name="taxCodeId" />` next to the existing tax percent input; when a code is selected, fetch `api/accounting.resolve-taxes`… no — compute the percent client-side for display from the api route `accounting.tax-codes` payload is insufficient; instead disable the manual `taxPercent` input whenever `taxCodeId` is set and show the resolved percent as read-only text (the server recomputes authoritatively on submit)
- Modify (client default copies — leave value flow intact but note): `QuoteExplorer.tsx:102`, `SalesOrderExplorer.tsx:148`, `x+/sales-order+/$orderId.new.tsx:107` keep copying `customer.taxPercent` as the *displayed* default; the server-side stamp in the action overrides it when determination resolves a code. Do not remove these copies (zero-config behavior must stay byte-identical).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0. Browser (Task 21): customer with QC code + a location with an ON 13% code:
# new SO line for ship-to=ON location → taxPercent 0.13, taxCodeId = ON code; ship-to unset →
# 0.14975; taxExempt customer → 0; item.taxable=false → 0; customer with NO code → old
# customer.taxPercent behavior unchanged.
```

**Out of scope:** `x+/quote+/$quoteId.drag.tsx` (hardcoded 0 today — pre-existing inconsistency, leave as-is), posting, memo form.

## Task 19: Wire determination into purchase line create/edit paths

**Depends on:** Tasks 16–17
**Files:**
- Modify: `apps/erp/app/modules/purchasing/purchasing.models.ts` — purchase order line validator gains `taxCodeId`; same for purchase invoice line validator in `invoicing.models.ts`
- Modify: `apps/erp/app/modules/purchasing/ui/PurchaseOrder/PurchaseOrderLineForm.tsx` — add `<TaxCode name="taxCodeId" />`; when set, compute `supplierTaxAmount = subtotal × resolvedPercent` in the existing client-side spots that already do `supplierTaxAmount: subtotal * itemData.taxPercent` (L183, L238) and disable the manual tax fields (`name="taxPercent"` inputs at L873, L1124)
- Modify: `apps/erp/app/modules/invoicing/ui/PurchaseInvoice/PurchaseInvoiceLineForm.tsx` — mirror (its `getLineTaxPercent` pattern at L135/L227)
- Modify (server stamping): the PO/PI line route actions that call `upsertPurchaseOrderLine` (`purchasing.service.ts:1742`) / `upsertPurchaseInvoiceLine` (`invoicing.service.ts:715`) — when `taxCodeId` is present, recompute `supplierTaxAmount = (quantity × supplierUnitPrice + supplierShippingCost) × percent` server-side from the code's effective components at the document date; write `taxCodeId` + `supplierTaxAmount`; never write `taxPercent`/`taxAmount` (generated columns)
- Modify (supplier default): purchase line creation defaults `taxCodeId` from `supplier.taxCodeId` via `resolveLineTaxes({ source: "purchase", supplierId, itemId, date })`

**Steps:** as per files. Do NOT touch `apps/erp/app/routes/x+/purchasing+/planning.update.tsx:390-392` (its `/100` bug is pre-existing and out of scope — flag it in the PR body as a separate-issue note).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0. Browser (Task 21): supplier with a 20% single-component code → new PO line
# qty 10 × $10 → supplierTaxAmount 20.00, generated taxPercent ≈ 0.2. Supplier with no code →
# tax fields behave exactly as today.
```

**Out of scope:** planning.update.tsx bug fix; posting.

## Task 20: Recalculate-taxes actions on ship-to change

**Depends on:** Tasks 16, 18
**Files:**
- Create: `apps/erp/app/routes/x+/sales-order+/$orderId.recalculate-taxes.tsx` (and siblings `x+/quote+/$quoteId.recalculate-taxes.tsx`, `x+/sales-invoice+/$invoiceId.recalculate-taxes.tsx`)
- Copy from (precedent): `apps/erp/app/routes/x+/sales-order+/$orderId.exchange-rate.tsx` (header-change → re-derive lines action shape); path helpers alongside the existing `recalculate` entries in `apps/erp/app/utils/path.ts` (cf. L1761)
- Modify: the document header forms/components where ship-to (`customerLocationId`) is edited — after a successful ship-to change, show a toast/inline affordance "Ship-to changed — recalculate taxes?" whose button posts to the new route (grep the sales-order header for where `customerLocationId` is submitted to find the exact component; it is the payment/shipping settings area of the order header)

**Steps:**
1. Action: `requirePermissions { update: "sales" }` (or `"invoicing"` for the invoice variant); load all document lines; for each line WITHOUT a manual override… every line gets re-resolved: call `resolveLineTaxes` per line (batch the config fetches) and `.update({ taxCodeId, taxPercent })` each line whose resolved values differ. Lines whose `taxCodeId` was manually set to a code different from both location and party defaults are still overwritten — document the behavior in the PR body (spec: "recalculate taxes" affordance is explicit and user-invoked; the audit trail records the change).
2. Only sales documents get the affordance in Phase 1 (purchase ship-to doesn't drive determination).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Expected: exit 0. Browser (Task 21): SO with 2 lines at QC rate; change ship-to to the ON
# location; click recalculate → both lines now 0.13 with the ON code.
```

**Out of scope:** Automatic silent recalculation on ship-to change (spec forbids document-time magic).

## Task 21: PR-B gate — typecheck, tests, browser verification, PR

**Depends on:** Tasks 16–20
**Steps:**
1. `pnpm exec turbo run typecheck --filter=erp`, `pnpm run lint`, `cd apps/erp && pnpm exec vitest run app/modules/accounting` — green.
2. Browser verification (`/auth` + `/test`) of every scenario listed in Tasks 18–20's Verify blocks, plus the zero-config invariant: a company with no tax config behaves identically (line defaults still from `customer.taxPercent`).
3. Confirm audit rows: override a line's tax code, then open the document's audit drawer — an UPDATE entry with the `taxCodeId` diff exists (trigger pipeline, no app code).
4. `/check-and-commit`; PR `feat: multi-jurisdiction tax Phase 1b — determination` with spec link + tested notes.

---

# PR-C — Posting + taxLedger (GATED on upstream #1030/#1165 — see coordination note)

## Task 22: Shared posting-time tax resolver (functions/shared/resolve-taxes.ts + deno tests)

**Depends on:** PR-A merged (types)
**Files:**
- Create: `packages/database/supabase/functions/shared/resolve-taxes.ts`
- Create: `packages/database/supabase/functions/shared/resolve-taxes.test.ts`
- Copy from (precedent): `packages/database/supabase/functions/shared/short-close.ts` (structural input types, no `lib/types.ts` import, module docstring) + `short-close.test.ts` (Deno.test shape)

**Steps:**
1. Port Task 6's pure math to Deno: `EffectiveTaxComponent` structural type, `filterEffectiveComponents(components, date)`, `computeComponentTaxes(base, components)` (compound-aware), plus `roundCurrency(amount, precision = 2)` — **half-up at currency precision, applied once per component per line** (spec rounding rule). Keep the two implementations line-for-line parallel; header comment in each pointing at its twin.
2. `splitLineTax(args: { taxableBase: number; taxCodeId: string | null; components: EffectiveTaxComponent[]; legacyTaxPercent: number; date: string }): { componentTaxes: { componentId; name; taxAuthorityId; rate; base; tax; isRecoverable; salesTaxAccountId; purchaseTaxAccountId }[]; totalTax: number }` — with a code: per-component split; without: single pseudo-component (`componentId: null`) at `legacyTaxPercent` (the OQ-1 legacy path that posts to `accountDefault.salesTaxPayableAccount`).
3. Deno tests: QC 5% + 9.975% on 100 → 5.00 + 9.98 (half-up), total 14.98; compound 5% + 7%-compound on 100 → 5.00 + 7.35; legacy 8.25% on 100 → single 8.25; zero-tax → empty split, totalTax 0; date-boundary case from Task 6.

**Verify:**
```bash
cd packages/database/supabase/functions && deno test shared/resolve-taxes.test.ts
# Expected: all pass
deno check shared/resolve-taxes.ts 2>&1 | grep -c "resolve-taxes.ts:"
# Expected: 0 own-file errors (lessons.md delta rule)
```

**Out of scope:** any edit to posting functions (Tasks 23–25).

## Task 23: Corrected sales posting + taxLedger writes in post-sales-invoice

**Depends on:** Task 22; upstream gate
**Files:**
- Modify: `packages/database/supabase/functions/post-sales-invoice/index.ts`
- Copy from (precedent): `packages/database/supabase/functions/post-memo/index.ts` (thin driver over a pure builder; class-correct signs via `credit`/`debit` from `../lib/utils.ts`)

**Steps:**
1. Fetch tax config up front (outside the transaction, next to the `accountDefault` fetch): the distinct `taxCodeId`s on the invoice lines, their codes + components, and the invoice's `customerTax` row (exemption snapshot fields). Fetch `salesTaxPayableAccount` from the already-loaded `accountDefault` (postingGroup) — resolve accounts **by id** only.
2. Revenue split (the current L321-349 region — or, if upstream #1165's `shared/sales-invoice-amounts.ts` has landed by now, inside that helper): keep `totalLineCost` (gross) for the **AR debit** — AR stays gross — but change the **Sales credit** to the pre-tax figure and add per-component **output-tax credits**:
   - per line: `componentTaxes = splitLineTax({ taxableBase: preTaxLineCost, taxCodeId, components, legacyTaxPercent: invoiceLine.taxPercent, date: postingDate })`
   - Sales account credit: `credit("revenue", (preTaxLineCost + nonTaxableAddOnCost + lineWeightedShippingCost) * invoiceExchangeRate)` — i.e. exactly today's amount minus the tax portion
   - per component: `credit("liability", componentTax.tax * invoiceExchangeRate)` to `component.salesTaxAccountId ?? accountDefault.salesTaxPayableAccount`, `description: "Sales Tax — " + componentName`, same `journalLineReference`, `documentType: "Invoice"`, `documentId: invoiceId`
   - **For every push to `journalLineInserts`, push a matching entry to `journalLineDimensionsMeta`** (L280-287 — the arrays are index-aligned; a missed push silently shifts every downstream dimension).
   - Do NOT reorder existing pushes: the COGS back-patch (L1040-1084) matches positionally (`i + 1`) — insert tax lines AFTER the revenue/AR pair of each line, never between the COGS/inventory pair.
3. `taxLedger` writes inside the existing Kysely transaction (after the journal insert so `journalId` is known): one row per line per component (and one `exemptAmount` row per exempt/non-taxable/zero-rated line): snapshot `componentName`, `taxAuthorityId`, `rate`, `taxableAmount`/`taxAmount` in base currency (× `invoiceExchangeRate`), `exemptAmount`, `taxExemptionReason` + `exemptionCertificateNumber` from `customerTax` when exempt, `currencyCode`, `exchangeRate`, `customerId`, `postingDate`, `source: 'Sales'`, `documentType: 'Sales Invoice'`, `createdBy: userId`. Legacy (`taxCodeId` null, `taxPercent > 0`) lines write one row with null code/component ids.
4. VOID path (L1282-1370): journal reversal is automatic (it mirrors existing `journalLine` rows by documentId — new tax lines carry `documentType: "Invoice"`/`documentId` so they're swept up). Add explicit `taxLedger` reversal: select the document's taxLedger rows, insert negated copies (`taxAmount`, `taxableAmount`, `exemptAmount` × −1), `createdBy: userId`, same snapshots, posting date = void date.
5. Shipping taxability hook (activated by Task 26): when `companySettings.shippingIsTaxable` is true, the header `shippingCost` allocation (`lineWeightedShippingCost`) is already inside `preTaxLineCost`-adjacent math — include the weighted shipping in each line's `taxableBase`; when false (default), exclude it exactly as today. Gate strictly on the setting.
6. Zero-config guarantee: when every line has `taxPercent === 0` and no `taxCodeId`, the emitted `journalLineInserts` must be **byte-identical** to today's (no empty tax lines, no taxLedger rows for zero-tax non-exempt lines — only exempt-customer/non-taxable-item lines write `exemptAmount` rows, and only when a `customerTax.taxExempt` or `item.taxable=false` condition actually fired).

**Verify:**
```bash
cd packages/database/supabase/functions
git show HEAD:post-sales-invoice/index.ts > post-sales-invoice/index.orig.ts
deno check post-sales-invoice/index.orig.ts 2>&1 | grep -c "index.orig.ts:"   # baseline N
deno check post-sales-invoice/index.ts 2>&1 | grep -c "index.ts:"             # must be <= N
rm post-sales-invoice/index.orig.ts
deno test shared/resolve-taxes.test.ts
# Browser (Task 27): post a QC invoice (100 @ 14.975%) with accounting enabled →
# journalEntries view shows AR 114.98 Dr, Revenue 100.00 Cr, 2210-or-component accounts
# 5.00 + 9.98 Cr, totalDebits == totalCredits; two taxLedger rows with correct authorities.
```

**Out of scope:** the FX divide/multiply asymmetry (owned by upstream #1030 — do not "fix"); COGS logic; `update-purchased-prices`.

## Task 24: Corrected purchase posting (recoverable / reverse charge) in post-purchase-invoice

**Depends on:** Task 22; upstream gate
**Files:**
- Modify: `packages/database/supabase/functions/post-purchase-invoice/index.ts`

**Steps:**
1. Fetch line tax codes + components + `accountDefault.purchaseTaxPayableAccount` / `reverseChargeSalesTaxPayableAccount` up front. Compute per-line `componentTaxes` from `splitLineTax` (taxable base = `quantity × unitPrice + shippingCost`, i.e. the line ex-tax; note purchase `taxAmount` is already base currency — reconcile: recompute component taxes from the base and use the recomputed values for the split, asserting `|Σ component tax − invoiceLine.taxAmount| < 0.02` per line; on larger drift, fall back to proportionally scaling component amounts so the total equals the stored `taxAmount` (the supplier's invoice is authoritative for the total; components only split it).
2. Behavior matrix (spec table):
   - **No code, or all components `isRecoverable = false`, `calculationType = 'Normal'`**: byte-identical to today — `taxAmount` stays inside `totalLineCost` (L802-806), inside `costLedger.cost` (L910), and inside the AP credit.
   - **Recoverable components (Normal)**: subtract the recoverable portion of tax from `totalLineCost` BEFORE it flows to the debit legs and `costLedger.cost` / `invoiceLineUnitCostInInventoryUnit` (cost posts net of recoverable tax); add per-component `debit("asset", recoverableTax × fx)` to `component.purchaseTaxAccountId ?? accountDefault.purchaseTaxPayableAccount`; AP credit unchanged (gross — supplier charged the tax). Set `taxLedger.postedToInputAccount = true` on those rows.
   - **Reverse Charge + recoverable** (EU acquisition): supplier charged no tax (`supplierTaxAmount = 0` expected — compute the notional tax from the code's components on the ex-tax base): paired entries `debit("asset", notionalTax)` to input-tax account + `credit("liability", notionalTax)` to `accountDefault.reverseChargeSalesTaxPayableAccount`; AP stays net; cost unchanged.
   - **Reverse Charge + non-recoverable** (US use tax): `debit` side goes into the line cost (capitalize: add notional tax to `totalLineCost`/`costLedger.cost`) + `credit("liability", notionalTax)` to `reverseChargeSalesTaxPayableAccount` (or component account); AP stays net.
3. `taxLedger` rows per line per component inside the transaction (source `'Purchase'`, `documentType: 'Purchase Invoice'`, `supplierId`, `postedToInputAccount` per matrix); VOID path mirrors Task 23 step 4 (this function's void copies `accrual` — keep that).
4. Zero-config guarantee: with no `taxCodeId` anywhere, every emitted journal line, `costLedger` row, and `itemLedger` row must be byte-identical to today.

**Verify:**
```bash
cd packages/database/supabase/functions
# deno check delta gate as in Task 23 (baseline vs HEAD)
# Browser (Task 27): PI with a 20% recoverable code, qty 10 × $10: journal = AP 120 Cr,
# inventory/GRNI 100 Dr, input tax 20 Dr; costLedger.cost = 100 (net). Same PI with
# isRecoverable=false → identical to a no-code PI with supplierTaxAmount 20 (cost 120).
# Reverse-charge recoverable → paired 20 Dr/20 Cr netting zero, AP 100.
```

**Out of scope:** PPV/GRNI logic; the divide-vs-multiply FX asymmetry (upstream #1030); short-close & variance allocation paths (they consume `totalLineCost` — verify they receive the same adjusted figure but do not restructure them).

## Task 25: Memo tax split in post-memo + golden-master tests

**Depends on:** Task 22
**Files:**
- Modify: `packages/database/supabase/functions/post-memo/build-memo-journal.ts` — `BuildMemoJournalInput` gains `taxAmountBase: number` (base currency, default 0) and `taxAccounts: { componentAccountId: string | null; amount: number }[]` (pre-split by the driver); output legs: AR/AP leg unchanged (gross `amountBase`), reason-account leg becomes `amountBase − taxAmountBase` (net), plus one tax leg per component with direction-aware sign (Credit memo vs sales: tax account **debited** — liability unwound; mirror for the other three direction/party combinations, derived exactly like the existing reason-leg sign logic)
- Modify: `packages/database/supabase/functions/post-memo/index.ts` — fetch `memo.taxCodeId`/`taxAmount` + components; split `taxAmount` across components proportionally by rate via `splitLineTax`; write signed `taxLedger` rows in the transaction (negative `taxAmount` for Credit-against-sales); VOID reverses them
- Modify: `packages/database/supabase/functions/post-memo/post-memo.test.ts` — extend the golden-master: every direction/party combo with tax must balance (`signedDebitTotal ≈ 0`); a no-code memo produces byte-identical legs to the current fixtures (assert against the existing expected outputs unchanged)
- Modify (app side): `apps/erp/app/modules/invoicing/ui/Memo/MemoForm.tsx` + `memoValidator` (`invoicing.models.ts:330-349`) + `apps/erp/app/routes/x+/credits+/new.tsx` — add `<TaxCode name="taxCodeId" />` and a computed read-only tax display: `taxAmount = amount × r/(1+r)` from the resolved code (party's assigned code as default), editable before posting per spec; `upsertMemo` (`invoicing.service.ts:1825`) passes the two new columns

**Verify:**
```bash
cd packages/database/supabase/functions/post-memo && deno test .
# Expected: existing golden-master cases UNCHANGED and passing; new taxed cases balance.
```

**Out of scope:** the AR/AP RPCs (`get_ar_tie_out` etc.) — `memo.amount` stays gross, tie-out contract untouched.

## Task 26: shippingIsTaxable setting (toggle UI + posting behavior)

**Depends on:** Task 23
**Files:**
- Modify: `apps/erp/app/modules/settings/settings.service.ts` — add `updateShippingIsTaxableSetting` copying `updateAccountingEnabledSetting` (L870) verbatim with the new column
- Modify: `apps/erp/app/routes/x+/settings+/accounting.tsx` — add a Switch card with its own `intent`, copying the accounting-enabled toggle pattern in the same file
- Modify: `post-sales-invoice/index.ts` — the Task-23 step-5 hook reads the setting (already fetched at L52-64 — extend that select)

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Browser (Task 27): toggle on → taxed order's shipping is taxed at the document's resolved
# code; toggle off → posting identical to pre-PR-C for the same fixture.
```

**Out of scope:** quote/order display math for shipping tax (views unchanged in Phase 1).

## Task 27: PR-C gate — legacy-invariance tests, deno check deltas, browser verification, PR

**Depends on:** Tasks 22–26
**Steps:**
1. All Deno tests: `cd packages/database/supabase/functions && deno test shared/resolve-taxes.test.ts post-memo/ shared/` — green; `deno check` own-file deltas ≤ baseline for both invoice functions.
2. Document the manual test command in the PR body (these tests are NOT in turbo/CI — reviewer must know how to run them).
3. Browser verification (`/auth` + `/test`) of the Task 23/24/25/26 Verify scenarios plus: VOID a posted taxed invoice → journal reversed AND `taxLedger` nets to zero for the document (`SELECT SUM("taxAmount") … WHERE "documentId" = …` = 0); an untouched zero-config company posts a plain invoice with journals identical to a pre-branch capture (capture the journal rows for the same fixture on `main` first, diff after).
4. Trial-balance check: `journalEntries` view shows `totalDebits == totalCredits` for every new entry (unbalanced entries silently block period close).
5. `/check-and-commit`; PR `feat: multi-jurisdiction tax Phase 1c — corrected posting + tax ledger`, body states: OQ-1 legacy behavior change applied (release-note flag), FX asymmetry deliberately untouched, rebase notes vs upstream #1165/#1030.

---

# PR-D — Surfaces (PDF, liability report, sunset UX)

## Task 28: PDF tax breakdown block + registration/invoiceMessage printing

**Depends on:** PR-A + Task 16 (live component math for drafts)
**Files:**
- Modify: `packages/documents/src/template/schema.ts` — `summaryOptionsSchema` (L82-84) gains `showTaxBreakdown: z.boolean().default(true)`; `DEFAULT_SUMMARY_OPTIONS` (L78-80) updated
- Modify: `packages/documents/src/pdf/blocks/types.ts` — `SalesInvoiceData` gains `taxBreakdown?: { authorityName: string | null; componentName: string; rate: number; taxableAmount: number; taxAmount: number }[]` and `taxMessages?: string[]` and `sellerRegistrationNumber?: string | null`
- Modify: `packages/documents/src/pdf/blocks/SummaryBlock.tsx` — when `options.showTaxBreakdown` and `taxBreakdown?.length`, replace the single Taxes row (L108-128) with one row per component (`{componentName} ({formatTaxPercent(rate)})` … amount), keeping the `w-5/6`/`w-1/6` column split and the ROW style constant pattern from `blocks/quote/SummaryBlock.tsx`; render `taxMessages` (distinct `invoiceMessage`s of resolved codes) as small text under the totals; total row unchanged
- Modify: `packages/documents/src/pdf/blocks/vars.ts` + `packages/documents/src/template/merge.ts` — add merge token `company.taxRegistrationNumber` (both files must stay in sync per the file comment)
- Modify: `apps/erp/app/routes/file+/sales-invoice+/$id[.]pdf.tsx` loader — fetch line tax codes + components (`getTaxCode`s for the lines' distinct `taxCodeId`s) and the company's `taxRegistration` matching `company.countryCode` (fallback `company.taxId` untouched); compute `taxBreakdown` by grouping per component across lines using the Task-6 math (draft invoices compute live from current components per spec; posted invoices too in Phase 1 — the PDF is display, the ledger is truth); thread the three new props
- Modify: `apps/erp/app/modules/settings/documentPreview.server.ts` (salesInvoice case, L110-142) — same threading (else the template-editor preview diverges)
- Modify: `packages/documents/src/pdf/samples.ts` — `SAMPLE_SALES_INVOICE` gains sample breakdown rows (TPS 5% / TVQ 9.975%) so the editor preview renders
- Modify: `apps/erp/app/components/DocumentTemplateEditor/BlockConfig.tsx` — `SummaryConfig` (L361-383) gains the `showTaxBreakdown` toggle

**Steps:** as per files. Lines with no `taxCodeId` but `taxPercent > 0` contribute a single "Tax ({percent})" pseudo-row so legacy invoices keep a correct (single-line) breakdown. If every line is code-less, the block renders exactly today's single Taxes row (`showTaxBreakdown` default true is safe — breakdown only appears when components exist).

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=@carbon/documents --filter=erp
pnpm --filter @carbon/documents test
# Browser: open a QC invoice PDF → TPS and TVQ rows with amounts; registration number in
# footer; invoiceMessage clause printed. Template editor preview renders the sample breakdown.
# A legacy taxPercent-only invoice PDF renders byte-identical totals with the single tax row.
```

**Out of scope:** Quote/PO PDFs; sales-order PDF port (note as follow-up in PR body); new block types (Ask First).

## Task 29: Tax liability report (service + route + table + CSV)

**Depends on:** PR-C merged (taxLedger rows exist)
**Files:**
- Modify: `apps/erp/app/modules/accounting/accounting.service.ts` — add `getTaxLiability(client, companyId, { startDate, endDate, taxAuthorityId? })`: select from `taxLedger` `.gte("postingDate", startDate).lte("postingDate", endDate).eq("companyId", companyId)`, optional authority filter; group in TS by `taxAuthorityId` → `componentName`: `{ taxableAmount, exemptAmount, taxCollected (source=Sales, sum taxAmount), inputTax (source=Purchase AND postedToInputAccount, sum taxAmount), netDue = taxCollected − inputTax }`
- Create: `apps/erp/app/routes/x+/accounting+/tax-liability.tsx`
- Copy from (precedent): `apps/erp/app/routes/x+/accounting+/trial-balance.tsx` (loader shape, `shouldRevalidate = revalidateIgnoringOffset`, permissions `{ view: "accounting", role: "employee" }`) + `apps/erp/app/components/PeriodSelector.tsx` `variant="range"` for the date filter
- Create: `apps/erp/app/modules/accounting/ui/Tax/TaxLiabilityTable.tsx` — grouped `<Table>` (CSV export free; every column gets `meta.exportValue`)
- Modify: `apps/erp/app/modules/accounting/ui/useAccountingSubmodules.tsx` — add "Tax Liability" under the existing `Reports` group; `path.to.taxLiability` already added in Task 7

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Browser: after posting the Task-27 fixtures, the report for the period shows Revenu Québec
# rows (TPS: base 100 / tax 5.00; TVQ: base 100 / tax 9.98) and netDue ties to the GL
# movement of the tax payable accounts for the same range (document the cross-check in the
# PR body per the spec acceptance criterion). Download CSV → rows match the table.
```

**Out of scope:** Returns/settlement (Phase 2); the `taxReturnId` column stays unread.

## Task 30: customer/supplier taxPercent sunset UX

**Depends on:** PR-A merged
**Files:**
- Modify: `apps/erp/app/modules/sales/ui/Customer/CustomerForm.tsx` (taxPercent field at L193) and the supplier equivalent (grep `taxPercent` in `apps/erp/app/modules/purchasing/ui/Supplier/SupplierForm.tsx`) — loader-provided flag `companyHasTaxCodes` (a cheap `getTaxCodesList(...).length > 0` in the parent route loaders); when true, replace the `taxPercent` input with a read-only display + inline banner: "This company uses tax codes. Flat tax percents are a legacy fallback — assign a tax code on the Tax tab." linking to the party's tax route
- Modify: the customer/supplier route loaders feeding those forms — fetch the flag

**Steps:** display-only change: the value is retained (it remains the no-code fallback per OQ 4) and the field hides, never deletes. **The spec's bulk "Assign tax code" table action: check whether `CustomersTable` (`apps/erp/app/modules/sales/ui/Customer/`) has any existing bulk-selection action precedent (grep `renderActions` / `selectedRows` in the table components). If a precedent exists, add a bulk action posting `{ customerIds[], taxCodeId }` to a new route `x+/customer+/bulk-tax-code.tsx` that updates `customer.taxCodeId` for the selection. If NO bulk-action precedent exists in the tables, STOP on this sub-item and report — ship the banner without the bulk action rather than inventing a new table capability.**

**Verify:**
```bash
pnpm exec turbo run typecheck --filter=erp
# Browser: company with zero codes → taxPercent fields render as today; create one code →
# fields hide behind the banner; banner link lands on the party tax tab.
```

**Out of scope:** deleting/backfilling `taxPercent` data.

## Task 31: PR-D gate — full acceptance-criteria browser verification, PR

**Depends on:** Tasks 28–30
**Steps:**
1. `pnpm exec turbo run typecheck --filter=erp --filter=@carbon/documents`, `pnpm run lint`, `cd apps/erp && pnpm exec vitest run app/modules/accounting`, `pnpm --filter @carbon/documents test` — green; `/translate` for new strings.
2. Walk the spec's Phase-1 acceptance criteria end-to-end in the browser (`/auth` + `/test`) — the TX–Austin two-component scenario, location-override scenario, exemption + certificate snapshot, recoverable VAT purchase, reverse charge, credit memo, shipping taxability both states, effective-date rate change, VOID netting, liability-report GL tie-out, and the zero-config byte-identical invariant. Record results in `.ai/runs/2026-<date>-multi-jurisdiction-tax-phase1.md`.
3. `/check-and-commit`; PR `feat: multi-jurisdiction tax Phase 1d — PDF tax blocks, liability report, taxPercent sunset` closing the Phase-1 scope, with "Closes #1036" on the upstream PR only when all four slices are merged there.
4. Move the spec to `.ai/specs/implemented/` only after ALL four PRs merge AND the acceptance criteria pass (ask first per specs AGENTS.md).
