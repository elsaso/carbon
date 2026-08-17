-- Multi-jurisdiction tax — Phase 1 schema
--
-- Spec: .ai/specs/2026-07-03-multi-jurisdiction-tax.md
-- Plan: .ai/plans/2026-08-16-multi-jurisdiction-tax-phase1.md (Task 1)
--
-- Introduces the configuration model (tax codes composed of per-jurisdiction
-- components, authorities, registrations) and the immutable tax subledger.
-- This migration is pure schema: nothing reads these tables yet, so applying it
-- is a no-op for existing behavior.
--
-- Deviation from the spec sketch: the spec wrote `countryId INTEGER REFERENCES
-- country(id)`, but `country`'s integer `id` was dropped in
-- 20240928155702_country-codes.sql and the PK is now `alpha2` CHAR(2). Address
-- match fields are therefore `countryCode TEXT REFERENCES country(alpha2)`,
-- matching how `address."countryCode"` already stores country.

-- =============================================================================
-- Enums
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "taxCalculationType" AS ENUM ('Normal', 'Reverse Charge');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "taxReportingCategory" AS ENUM (
    'Standard',
    'Reduced',
    'Zero-Rated',
    'Exempt',
    'Reverse Charge',
    'Export',
    'Out of Scope'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "taxLedgerSource" AS ENUM ('Sales', 'Purchase');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- taxAuthority — who you remit to (CRA, Revenu Québec, Texas Comptroller)
-- =============================================================================

CREATE TABLE IF NOT EXISTS "taxAuthority" (
    "id" TEXT NOT NULL DEFAULT id(),
    "companyId" TEXT NOT NULL,

    "name" TEXT NOT NULL,
    -- Optional link so remittance can ride the existing AP rails (Phase 2)
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'taxAuthority_companyId_name_key' AND conrelid = '"taxAuthority"'::regclass
  ) THEN
    ALTER TABLE "taxAuthority" ADD CONSTRAINT "taxAuthority_companyId_name_key" UNIQUE ("companyId", "name");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "taxAuthority_companyId_idx" ON "taxAuthority" ("companyId");
CREATE INDEX IF NOT EXISTS "taxAuthority_supplierId_idx" ON "taxAuthority" ("supplierId");
CREATE INDEX IF NOT EXISTS "taxAuthority_createdBy_idx" ON "taxAuthority" ("createdBy");

-- =============================================================================
-- taxCode — a named treatment ("QC – TPS+TVQ", "UK Standard 20%")
-- =============================================================================

CREATE TABLE IF NOT EXISTS "taxCode" (
    "id" TEXT NOT NULL DEFAULT id(),
    "companyId" TEXT NOT NULL,

    "name" TEXT NOT NULL,
    "description" TEXT,
    "calculationType" "taxCalculationType" NOT NULL DEFAULT 'Normal',
    "reportingCategory" "taxReportingCategory" NOT NULL DEFAULT 'Standard',
    -- VAT clause printed on documents ("Reverse charge — VAT to be accounted
    -- for by the recipient")
    "invoiceMessage" TEXT,
    -- Address-match keys. These drive SUGGESTIONS at assignment time only --
    -- documents never infer tax from an address.
    "countryCode" TEXT REFERENCES "country"("alpha2") ON DELETE SET NULL ON UPDATE CASCADE,
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'taxCode_companyId_name_key' AND conrelid = '"taxCode"'::regclass
  ) THEN
    ALTER TABLE "taxCode" ADD CONSTRAINT "taxCode_companyId_name_key" UNIQUE ("companyId", "name");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "taxCode_companyId_idx" ON "taxCode" ("companyId");
CREATE INDEX IF NOT EXISTS "taxCode_companyId_countryCode_state_idx" ON "taxCode" ("companyId", "countryCode", "state");
CREATE INDEX IF NOT EXISTS "taxCode_countryCode_idx" ON "taxCode" ("countryCode");
CREATE INDEX IF NOT EXISTS "taxCode_createdBy_idx" ON "taxCode" ("createdBy");

-- =============================================================================
-- taxCodeComponent — 1..n jurisdictions per code
--
-- Canada GST+PST = two components (PST optionally compound). Texas = state +
-- county + city. UK VAT = one. Rate changes are modeled by expiring the old row
-- and adding a successor, so posted documents keep their historical rate.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "taxCodeComponent" (
    "id" TEXT NOT NULL DEFAULT id(),
    "companyId" TEXT NOT NULL,

    "taxCodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxAuthorityId" TEXT,
    "rate" NUMERIC NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    -- Tax-on-tax: applied to the base plus prior components in sequence order
    "isCompound" BOOLEAN NOT NULL DEFAULT FALSE,
    -- Purchase side: FALSE capitalizes tax into cost (today's behavior, correct
    -- for US purchase tax); TRUE posts it to an input-tax asset (VAT).
    "isRecoverable" BOOLEAN NOT NULL DEFAULT FALSE,
    -- Per-component GL accounts; fall back to accountDefault when null
    "salesTaxAccountId" TEXT REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "purchaseTaxAccountId" TEXT REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
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
    CONSTRAINT "taxCodeComponent_dates_check" CHECK (
      "expirationDate" IS NULL OR "effectiveDate" IS NULL OR "expirationDate" > "effectiveDate"
    )
);

CREATE INDEX IF NOT EXISTS "taxCodeComponent_companyId_idx" ON "taxCodeComponent" ("companyId");
CREATE INDEX IF NOT EXISTS "taxCodeComponent_taxCodeId_idx" ON "taxCodeComponent" ("taxCodeId", "companyId");
CREATE INDEX IF NOT EXISTS "taxCodeComponent_taxAuthorityId_idx" ON "taxCodeComponent" ("taxAuthorityId");
CREATE INDEX IF NOT EXISTS "taxCodeComponent_salesTaxAccountId_idx" ON "taxCodeComponent" ("salesTaxAccountId");
CREATE INDEX IF NOT EXISTS "taxCodeComponent_purchaseTaxAccountId_idx" ON "taxCodeComponent" ("purchaseTaxAccountId");
CREATE INDEX IF NOT EXISTS "taxCodeComponent_createdBy_idx" ON "taxCodeComponent" ("createdBy");

-- =============================================================================
-- taxRegistration — company registrations; print on sales documents
-- =============================================================================

CREATE TABLE IF NOT EXISTS "taxRegistration" (
    "id" TEXT NOT NULL DEFAULT id(),
    "companyId" TEXT NOT NULL,

    "countryCode" TEXT NOT NULL REFERENCES "country"("alpha2") ON DELETE RESTRICT ON UPDATE CASCADE,
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
CREATE INDEX IF NOT EXISTS "taxRegistration_countryCode_idx" ON "taxRegistration" ("countryCode");
CREATE INDEX IF NOT EXISTS "taxRegistration_createdBy_idx" ON "taxRegistration" ("createdBy");

-- =============================================================================
-- taxLedger — the immutable tax subledger (BC "VAT Entry" / SAP BSET pattern)
--
-- Written by the posting functions in PR-C; all tax reporting reads it. Rows
-- snapshot the code/component/authority names and rate so later config edits
-- can never change what a posted document reported. Amounts are base currency.
-- Exempt, non-taxable-item, and zero-rated lines write rows too (returns need
-- exempt bases). Drafts never hit the ledger -- they compute live.
--
-- Append-only in practice: corrections are new reversing rows (VOID), never
-- UPDATEs. "updatedBy" exists but stays NULL -- it is required by the shared
-- audit-injection path, which stamps it on every write.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "taxLedger" (
    "id" TEXT NOT NULL DEFAULT id('txl'),
    "companyId" TEXT NOT NULL,

    "source" "taxLedgerSource" NOT NULL,
    -- 'Sales Invoice' | 'Purchase Invoice' | 'Memo'. Deliberately TEXT, not an
    -- enum: journalLine and itemLedger already use two different documentType
    -- enums with near-identical values, and adding a third is a footgun.
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentLineId" TEXT,
    "journalId" TEXT,
    "postingDate" DATE NOT NULL,

    -- Config references (nullable: legacy taxPercent lines carry no code)
    "taxCodeId" TEXT,
    "taxCodeComponentId" TEXT,
    -- Snapshots -- self-contained even if the config is later edited or deleted
    "componentName" TEXT,
    "taxAuthorityId" TEXT,

    "customerId" TEXT,
    "supplierId" TEXT,

    "rate" NUMERIC NOT NULL DEFAULT 0,
    "taxableAmount" NUMERIC NOT NULL DEFAULT 0,
    -- Negative on VOID reversal and on credit memos against sales
    "taxAmount" NUMERIC NOT NULL DEFAULT 0,
    -- Exempt customer, non-taxable item, or zero-rated code
    "exemptAmount" NUMERIC NOT NULL DEFAULT 0,
    "taxExemptionReason" "taxExemptionReason",
    "exemptionCertificateNumber" TEXT,

    "currencyCode" TEXT,
    "exchangeRate" NUMERIC,

    -- Phase 2: stamped when a return is finalized (immutable-by-inclusion)
    "taxReturnId" TEXT,
    -- Phase 3: flags rows posted during an external-engine outage
    "needsEngineReconciliation" BOOLEAN NOT NULL DEFAULT FALSE,
    -- TRUE when the recoverable input-tax leg was posted to an asset account;
    -- the liability report nets these against output tax.
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
CREATE INDEX IF NOT EXISTS "taxLedger_taxCodeId_idx" ON "taxLedger" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "taxLedger_customerId_idx" ON "taxLedger" ("customerId");
CREATE INDEX IF NOT EXISTS "taxLedger_supplierId_idx" ON "taxLedger" ("supplierId");
CREATE INDEX IF NOT EXISTS "taxLedger_createdBy_idx" ON "taxLedger" ("createdBy");

-- =============================================================================
-- RLS — tax configuration is accounting-gated
--
-- taxLedger writes happen through service-role posting functions (which bypass
-- RLS), but the INSERT policy is defined for completeness.
-- =============================================================================

ALTER TABLE "public"."taxAuthority" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SELECT" ON "public"."taxAuthority";
CREATE POLICY "SELECT" ON "public"."taxAuthority"
FOR SELECT USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_role())::text[])
);

DROP POLICY IF EXISTS "INSERT" ON "public"."taxAuthority";
CREATE POLICY "INSERT" ON "public"."taxAuthority"
FOR INSERT WITH CHECK (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_create'))::text[])
);

DROP POLICY IF EXISTS "UPDATE" ON "public"."taxAuthority";
CREATE POLICY "UPDATE" ON "public"."taxAuthority"
FOR UPDATE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_update'))::text[])
);

DROP POLICY IF EXISTS "DELETE" ON "public"."taxAuthority";
CREATE POLICY "DELETE" ON "public"."taxAuthority"
FOR DELETE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_delete'))::text[])
);

ALTER TABLE "public"."taxCode" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SELECT" ON "public"."taxCode";
CREATE POLICY "SELECT" ON "public"."taxCode"
FOR SELECT USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_role())::text[])
);

DROP POLICY IF EXISTS "INSERT" ON "public"."taxCode";
CREATE POLICY "INSERT" ON "public"."taxCode"
FOR INSERT WITH CHECK (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_create'))::text[])
);

DROP POLICY IF EXISTS "UPDATE" ON "public"."taxCode";
CREATE POLICY "UPDATE" ON "public"."taxCode"
FOR UPDATE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_update'))::text[])
);

DROP POLICY IF EXISTS "DELETE" ON "public"."taxCode";
CREATE POLICY "DELETE" ON "public"."taxCode"
FOR DELETE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_delete'))::text[])
);

ALTER TABLE "public"."taxCodeComponent" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SELECT" ON "public"."taxCodeComponent";
CREATE POLICY "SELECT" ON "public"."taxCodeComponent"
FOR SELECT USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_role())::text[])
);

DROP POLICY IF EXISTS "INSERT" ON "public"."taxCodeComponent";
CREATE POLICY "INSERT" ON "public"."taxCodeComponent"
FOR INSERT WITH CHECK (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_create'))::text[])
);

DROP POLICY IF EXISTS "UPDATE" ON "public"."taxCodeComponent";
CREATE POLICY "UPDATE" ON "public"."taxCodeComponent"
FOR UPDATE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_update'))::text[])
);

DROP POLICY IF EXISTS "DELETE" ON "public"."taxCodeComponent";
CREATE POLICY "DELETE" ON "public"."taxCodeComponent"
FOR DELETE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_delete'))::text[])
);

ALTER TABLE "public"."taxRegistration" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SELECT" ON "public"."taxRegistration";
CREATE POLICY "SELECT" ON "public"."taxRegistration"
FOR SELECT USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_role())::text[])
);

DROP POLICY IF EXISTS "INSERT" ON "public"."taxRegistration";
CREATE POLICY "INSERT" ON "public"."taxRegistration"
FOR INSERT WITH CHECK (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_create'))::text[])
);

DROP POLICY IF EXISTS "UPDATE" ON "public"."taxRegistration";
CREATE POLICY "UPDATE" ON "public"."taxRegistration"
FOR UPDATE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_update'))::text[])
);

DROP POLICY IF EXISTS "DELETE" ON "public"."taxRegistration";
CREATE POLICY "DELETE" ON "public"."taxRegistration"
FOR DELETE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_delete'))::text[])
);

ALTER TABLE "public"."taxLedger" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "SELECT" ON "public"."taxLedger";
CREATE POLICY "SELECT" ON "public"."taxLedger"
FOR SELECT USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_role())::text[])
);

DROP POLICY IF EXISTS "INSERT" ON "public"."taxLedger";
CREATE POLICY "INSERT" ON "public"."taxLedger"
FOR INSERT WITH CHECK (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_create'))::text[])
);

DROP POLICY IF EXISTS "UPDATE" ON "public"."taxLedger";
CREATE POLICY "UPDATE" ON "public"."taxLedger"
FOR UPDATE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_update'))::text[])
);

DROP POLICY IF EXISTS "DELETE" ON "public"."taxLedger";
CREATE POLICY "DELETE" ON "public"."taxLedger"
FOR DELETE USING (
  "companyId" = ANY ((SELECT get_companies_with_employee_permission('accounting_delete'))::text[])
);

-- =============================================================================
-- Custom field registration
-- =============================================================================

INSERT INTO "customFieldTable" ("table", "name", "module")
VALUES
  ('taxCode', 'Tax Code', 'Accounting'),
  ('taxAuthority', 'Tax Authority', 'Accounting'),
  ('taxRegistration', 'Tax Registration', 'Accounting')
ON CONFLICT ("table") DO NOTHING;

-- =============================================================================
-- Task 2: Tax columns on existing tables
-- =============================================================================

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

-- =============================================================================
-- Task 2: Foreign keys
-- =============================================================================

-- Every table below carries a NOT NULL "companyId", so the composite FK to
-- "taxCode"("id", "companyId") is enforceable and keeps tax codes tenant-scoped.
-- ("customerLocation"."companyId" was added in 20260625163000_add-companyid-to-backup-tables.sql
--  and is maintained by the set_company_id_from_parent('customer', 'customerId') trigger.)
DO $$ BEGIN
  ALTER TABLE "customer" ADD CONSTRAINT "customer_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "customerLocation" ADD CONSTRAINT "customerLocation_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "supplier" ADD CONSTRAINT "supplier_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "quoteLine" ADD CONSTRAINT "quoteLine_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "salesOrderLine" ADD CONSTRAINT "salesOrderLine_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "salesInvoiceLine" ADD CONSTRAINT "salesInvoiceLine_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "purchaseOrderLine" ADD CONSTRAINT "purchaseOrderLine_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "purchaseInvoiceLine" ADD CONSTRAINT "purchaseInvoiceLine_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "memo" ADD CONSTRAINT "memo_taxCodeId_fkey"
    FOREIGN KEY ("taxCodeId", "companyId") REFERENCES "taxCode"("id", "companyId");
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- Mirrors the shape of "accountDefault_salesTaxPayableAccount_fkey"
-- (20260315000000_reset-chart-of-accounts.sql).
DO $$ BEGIN
  ALTER TABLE "accountDefault" ADD CONSTRAINT "accountDefault_taxSettlementAccount_fkey"
    FOREIGN KEY ("taxSettlementAccount") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- =============================================================================
-- Task 2: Indexes on the new FK columns
-- =============================================================================
CREATE INDEX IF NOT EXISTS "customer_taxCodeId_idx" ON "customer" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "customerLocation_taxCodeId_idx" ON "customerLocation" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "supplier_taxCodeId_idx" ON "supplier" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "quoteLine_taxCodeId_idx" ON "quoteLine" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "salesOrderLine_taxCodeId_idx" ON "salesOrderLine" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "salesInvoiceLine_taxCodeId_idx" ON "salesInvoiceLine" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "purchaseOrderLine_taxCodeId_idx" ON "purchaseOrderLine" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "purchaseInvoiceLine_taxCodeId_idx" ON "purchaseInvoiceLine" ("taxCodeId");
CREATE INDEX IF NOT EXISTS "memo_taxCodeId_idx" ON "memo" ("taxCodeId");

-- =============================================================================
-- Task 2: View exposure
-- =============================================================================
--
-- Postgres expands "<alias>.*" into an explicit column list at view-creation
-- time, so a column added to a base table does NOT appear in an existing view
-- until the view is recreated (see 20260321120000_non-taxable-addon-cost.sql,
-- which recreates "salesOrderLines"/"salesInvoiceLines" for exactly this
-- reason even though both project "sl.*").
--
-- Each definition below is forked verbatim from the NEWEST definition of that
-- view; the only edit is the added "taxCodeId" projection on "customers" and
-- "suppliers" (the line views pick the column up through their existing
-- "<alias>.*" on re-expansion). Purchase-line generated columns
-- ("taxPercent"/"taxAmount") are untouched.

-- Forked from 20260521124731_supplier-customer-readable-id.sql (adds s."taxCodeId")
DROP VIEW IF EXISTS "suppliers";
CREATE OR REPLACE VIEW "suppliers" WITH(SECURITY_INVOKER=true) AS
  SELECT
    s.id,
    s."readableId",
    s.name,
    s."supplierTypeId",
    s."supplierStatus" as "status",
    stx."taxId",
    s."accountManagerId",
    s.logo,
    s.assignee,
    s."companyId",
    s."createdAt",
    s."createdBy",
    s."updatedAt",
    s."updatedBy",
    s."customFields",
    s."currencyCode",
    stx."vatNumber",
    stx."eori",
    s.website,
    (
      SELECT COALESCE(
        jsonb_object_agg(
          eim."integration",
          CASE
            WHEN eim."metadata" IS NOT NULL THEN eim."metadata"
            ELSE to_jsonb(eim."externalId")
          END
        ) FILTER (WHERE eim."externalId" IS NOT NULL OR eim."metadata" IS NOT NULL),
        '{}'::jsonb
      )
      FROM "externalIntegrationMapping" eim
      WHERE eim."entityType" = 'supplier' AND eim."entityId" = s.id
    ) AS "externalId",
    s.tags,
    s."taxPercent",
    s."taxCodeId",
    s."purchasingContactId",
    s.embedding,
    s."defaultCc",
    st.name AS "type",
    po.count AS "orderCount",
    p.count AS "partCount",
    pc."workPhone" AS "phone",
    pc.fax AS "fax"
  FROM "supplier" s
  LEFT JOIN "supplierTax" stx ON stx."supplierId" = s.id
  LEFT JOIN "supplierType" st ON st.id = s."supplierTypeId"
  LEFT JOIN (
    SELECT
      "supplierId",
      COUNT(*) AS "count"
    FROM "purchaseOrder"
    GROUP BY "supplierId"
  ) po ON po."supplierId" = s.id
  LEFT JOIN (
    SELECT
      "supplierId",
      COUNT(*) AS "count"
    FROM "supplierPart"
    GROUP BY "supplierId"
  ) p ON p."supplierId" = s.id
  LEFT JOIN (
    SELECT DISTINCT ON (sc."supplierId")
      sc."supplierId" AS id,
      co."workPhone",
      co."fax"
    FROM "supplierContact" sc
    JOIN "contact" co
      ON co.id = sc."contactId"
    ORDER BY sc."supplierId", sc.id
  ) pc
    ON pc.id = s.id;

-- Forked from 20260521124731_supplier-customer-readable-id.sql (adds c."taxCodeId")
DROP VIEW IF EXISTS "customers";
CREATE OR REPLACE VIEW "customers" WITH(SECURITY_INVOKER=true) AS
  SELECT
    c.id,
    c."readableId",
    c.name,
    c."customerTypeId",
    c."customerStatusId",
    ctx."taxId",
    c."accountManagerId",
    c.logo,
    c.assignee,
    c."taxPercent",
    c."taxCodeId",
    c."tags",
    c.website,
    c."companyId",
    c."createdAt",
    c."createdBy",
    c."updatedAt",
    c."updatedBy",
    c."customFields",
    c."currencyCode",
    c."salesContactId",
    c."defaultCc",
    ctx."vatNumber",
    ctx."eori",
    (
      SELECT COALESCE(
        jsonb_object_agg(
          eim."integration",
          CASE
            WHEN eim."metadata" IS NOT NULL THEN eim."metadata"
            ELSE to_jsonb(eim."externalId")
          END
        ) FILTER (WHERE eim."externalId" IS NOT NULL OR eim."metadata" IS NOT NULL),
        '{}'::jsonb
      )
      FROM "externalIntegrationMapping" eim
      WHERE eim."entityType" = 'customer' AND eim."entityId" = c.id
    ) AS "externalId",
    ct.name AS "type",
    cs.name AS "status",
    so.count AS "orderCount",
    pc."workPhone" AS "phone",
    pc."fax" AS "fax"
  FROM "customer" c
  LEFT JOIN "customerTax" ctx ON ctx."customerId" = c.id
  LEFT JOIN "customerType" ct ON ct.id = c."customerTypeId"
  LEFT JOIN "customerStatus" cs ON cs.id = c."customerStatusId"
  LEFT JOIN (
    SELECT
      "customerId",
      COUNT(*) AS "count"
    FROM "salesOrder"
    GROUP BY "customerId"
  ) so ON so."customerId" = c.id
  LEFT JOIN (
    SELECT DISTINCT ON (cc."customerId")
      cc."customerId",
      co."workPhone",
      co."fax"
    FROM "customerContact" cc
    INNER JOIN "contact" co ON co.id = cc."contactId"
    ORDER BY cc."customerId"
  ) pc ON pc."customerId" = c.id;

-- Forked from 20260513120000_line-item-sort-order.sql (verbatim; "taxCodeId" arrives via ql.*)
DROP VIEW IF EXISTS "quoteLines";
CREATE OR REPLACE VIEW "quoteLines" WITH(SECURITY_INVOKER=true) AS (
  SELECT
    ql.*,
    i."readableIdWithRevision" as "itemReadableId",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      WHEN i."thumbnailPath" IS NULL AND imu."thumbnailPath" IS NOT NULL THEN imu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    COALESCE(mu.id, imu.id) as "modelId",
    COALESCE(mu."autodeskUrn", imu."autodeskUrn") as "autodeskUrn",
    COALESCE(mu."modelPath", imu."modelPath") as "modelPath",
    COALESCE(mu."name", imu."name") as "modelName",
    COALESCE(mu."size", imu."size") as "modelSize",
    ic."unitCost" as "unitCost"
  FROM "quoteLine" ql
  LEFT JOIN "modelUpload" mu ON ql."modelUploadId" = mu."id"
  INNER JOIN "item" i ON i.id = ql."itemId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  LEFT JOIN "modelUpload" imu ON imu.id = i."modelUploadId"
);

-- Forked from 20260524143827_fixed-assets.sql (verbatim; "taxCodeId" arrives via sl.*)
DROP VIEW IF EXISTS "salesOrderLines";
CREATE OR REPLACE VIEW "salesOrderLines" WITH(SECURITY_INVOKER=true) AS (
  SELECT
    sl.*,
    i."readableIdWithRevision" as "itemReadableId",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      WHEN i."thumbnailPath" IS NULL AND imu."thumbnailPath" IS NOT NULL THEN imu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    COALESCE(mu.id, imu.id) as "modelId",
    COALESCE(mu."autodeskUrn", imu."autodeskUrn") as "autodeskUrn",
    COALESCE(mu."modelPath", imu."modelPath") as "modelPath",
    COALESCE(mu."name", imu."name") as "modelName",
    COALESCE(mu."size", imu."size") as "modelSize",
    ic."unitCost" as "unitCost",
    cp."customerPartId",
    cp."customerPartRevision",
    so."orderDate",
    so."customerId",
    so."salesOrderId" as "salesOrderReadableId",
    fa."fixedAssetId" as "assetReadableId",
    fa."name" as "assetName"
  FROM "salesOrderLine" sl
  INNER JOIN "salesOrder" so ON so.id = sl."salesOrderId"
  LEFT JOIN "modelUpload" mu ON sl."modelUploadId" = mu."id"
  LEFT JOIN "item" i ON i.id = sl."itemId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  LEFT JOIN "modelUpload" imu ON imu.id = i."modelUploadId"
  LEFT JOIN "customerPartToItem" cp ON cp."customerId" = so."customerId" AND cp."itemId" = i.id
  LEFT JOIN "fixedAsset" fa ON fa.id = sl."assetId"
);

-- Forked from 20260524143827_fixed-assets.sql (verbatim; "taxCodeId" arrives via sl.*)
DROP VIEW IF EXISTS "salesInvoiceLines";
CREATE OR REPLACE VIEW "salesInvoiceLines" WITH(SECURITY_INVOKER=true) AS (
  SELECT
    sl.*,
    i."readableIdWithRevision" as "itemReadableId",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      WHEN i."thumbnailPath" IS NULL AND imu."thumbnailPath" IS NOT NULL THEN imu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    i.name as "itemName",
    i.description as "itemDescription",
    ic."unitCost" as "unitCost",
    (SELECT cp."customerPartId"
     FROM "customerPartToItem" cp
     WHERE cp."customerId" = si."customerId" AND cp."itemId" = i.id
     LIMIT 1) as "customerPartId",
    fa."fixedAssetId" as "assetReadableId",
    fa."name" as "assetName"
  FROM "salesInvoiceLine" sl
  INNER JOIN "salesInvoice" si ON si.id = sl."invoiceId"
  LEFT JOIN "modelUpload" mu ON sl."modelUploadId" = mu."id"
  LEFT JOIN "item" i ON i.id = sl."itemId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  LEFT JOIN "modelUpload" imu ON imu.id = i."modelUploadId"
  LEFT JOIN "fixedAsset" fa ON fa.id = sl."assetId"
);

-- Forked from 20260529120000_purchase-order-line-supplier-part.sql (verbatim; "taxCodeId" arrives via pl.*)
DROP VIEW IF EXISTS "purchaseOrderLines";
CREATE OR REPLACE VIEW "purchaseOrderLines" WITH(SECURITY_INVOKER=true) AS (
  SELECT DISTINCT ON (pl.id)
    pl.*,
    sp."supplierPartId" as "supplierPartIdFromSupplier",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      WHEN i."thumbnailPath" IS NULL AND imu."thumbnailPath" IS NOT NULL THEN imu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    i.name as "itemName",
    i."readableIdWithRevision" as "itemReadableId",
    i.description as "itemDescription",
    COALESCE(mu.id, imu.id) as "modelId",
    COALESCE(mu."autodeskUrn", imu."autodeskUrn") as "autodeskUrn",
    COALESCE(mu."modelPath", imu."modelPath") as "modelPath",
    COALESCE(mu."name", imu."name") as "modelName",
    COALESCE(mu."size", imu."size") as "modelSize",
    ic."unitCost" as "unitCost",
    jo."description" as "jobOperationDescription",
    a."name" as "accountName",
    fa."fixedAssetId" as "assetReadableId",
    fa."name" as "assetName"
  FROM "purchaseOrderLine" pl
  INNER JOIN "purchaseOrder" so ON so.id = pl."purchaseOrderId"
  LEFT JOIN "modelUpload" mu ON pl."modelUploadId" = mu."id"
  LEFT JOIN "item" i ON i.id = pl."itemId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  LEFT JOIN "modelUpload" imu ON imu.id = i."modelUploadId"
  LEFT JOIN "jobOperation" jo ON jo."id" = pl."jobOperationId"
  LEFT JOIN "account" a ON a.id = pl."accountId"
  LEFT JOIN "fixedAsset" fa ON fa.id = pl."assetId"
  LEFT JOIN "supplierPart" sp ON sp."supplierId" = so."supplierId" AND sp."itemId" = i.id
);

-- Forked from 20260524143827_fixed-assets.sql (verbatim; "taxCodeId" arrives via pl.*)
DROP VIEW IF EXISTS "purchaseInvoiceLines";
CREATE OR REPLACE VIEW "purchaseInvoiceLines" WITH(SECURITY_INVOKER=true) AS (
  SELECT
    pl.*,
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      WHEN i."thumbnailPath" IS NULL AND imu."thumbnailPath" IS NOT NULL THEN imu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    i."readableIdWithRevision" as "itemReadableId",
    i.name as "itemName",
    i.description as "itemDescription",
    ic."unitCost" as "unitCost",
    sp."supplierPartId",
    a."name" as "accountName",
    fa."fixedAssetId" as "assetReadableId",
    fa."name" as "assetName"
  FROM "purchaseInvoiceLine" pl
  INNER JOIN "purchaseInvoice" pi ON pi.id = pl."invoiceId"
  LEFT JOIN "modelUpload" mu ON pl."modelUploadId" = mu."id"
  LEFT JOIN "item" i ON i.id = pl."itemId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  LEFT JOIN "modelUpload" imu ON imu.id = i."modelUploadId"
  LEFT JOIN "supplierPart" sp ON sp."supplierId" = pi."supplierId" AND sp."itemId" = i.id
  LEFT JOIN "account" a ON a.id = pl."accountId"
  LEFT JOIN "fixedAsset" fa ON fa.id = pl."assetId"
);


-- =============================================================================
-- Item detail RPCs — recreated to expose "taxable"
--
-- The "taxable" column added above lands on "item", but the five item Properties
-- panels read their data from these RPCs, which declare an explicit RETURNS
-- TABLE column list. Without "taxable" in that list the Taxable switch writes
-- successfully but always reads back as the DEFAULT TRUE, so toggling it off
-- never survives a reload.
--
-- Bodies are the verbatim newest definitions (part/tool/material/consumable:
-- 20260629142317_item-mpn.sql; service: 20260707022141_service-item-type.sql),
-- with "taxable" appended to both the RETURNS TABLE declaration and the SELECT
-- list alongside "mpn". Nothing else changes.
--
-- DROP first: adding a column to the RETURNS TABLE changes the function's result
-- row type, which CREATE OR REPLACE cannot do (SQLSTATE 42P13). DROP ... IF
-- EXISTS makes this section safe to re-run against a database that already has
-- the new definition.
-- =============================================================================

-- Forked from 20260629142317_item-mpn.sql
DROP FUNCTION IF EXISTS get_part_details(TEXT);
CREATE OR REPLACE FUNCTION get_part_details(item_id TEXT)
RETURNS TABLE (
    "active" BOOLEAN,
    "assignee" TEXT,
    "defaultMethodType" "methodType",
    "sourcingType" "sourcingType",
    "description" TEXT,
    "itemTrackingType" "itemTrackingType",
    "requiresInspection" BOOLEAN,
    "name" TEXT,
    "replenishmentSystem" "itemReplenishmentSystem",
    "unitOfMeasureCode" TEXT,
    "notes" JSONB,
    "thumbnailPath" TEXT,
    "modelId" TEXT,
    "modelPath" TEXT,
    "modelName" TEXT,
    "modelSize" BIGINT,
    "id" TEXT,
    "companyId" TEXT,
    "unitOfMeasure" TEXT,
    "readableId" TEXT,
    "revision" TEXT,
    "readableIdWithRevision" TEXT,
    "revisions" JSON,
    "customFields" JSONB,
    "tags" TEXT[],
    "itemPostingGroupId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP WITH TIME ZONE,
    "mpn" TEXT,
    "taxable" BOOLEAN
) AS $$
DECLARE
  v_readable_id TEXT;
  v_company_id TEXT;
BEGIN
  SELECT i."readableId", i."companyId" INTO v_readable_id, v_company_id
  FROM "item" i
  WHERE i.id = item_id;

  RETURN QUERY
  WITH item_revisions AS (
    SELECT
      json_agg(
        json_build_object(
          'id', i.id,
          'revision', i."revision",
          'methodType', i."defaultMethodType",
          'type', i."type"
        ) ORDER BY
          i."createdAt" DESC
      ) as "revisions"
    FROM "item" i
    WHERE i."readableId" = v_readable_id
    AND i."companyId" = v_company_id
    AND i."type" = 'Part'
  )
  SELECT
    i."active",
    i."assignee",
    i."defaultMethodType",
    i."sourcingType",
    i."description",
    i."itemTrackingType",
    i."requiresInspection",
    i."name",
    i."replenishmentSystem",
    i."unitOfMeasureCode",
    i."notes",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    mu.id as "modelId",
    mu."modelPath",
    mu."name" as "modelName",
    mu."size" as "modelSize",
    i."id",
    i."companyId",
    uom.name as "unitOfMeasure",
    i."readableId",
    i."revision",
    i."readableIdWithRevision",
    ir."revisions",
    p."customFields",
    p."tags",
    ic."itemPostingGroupId",
    i."createdBy",
    i."createdAt",
    i."updatedBy",
    i."updatedAt",
    i."mpn",
    i."taxable"
  FROM "part" p
  LEFT JOIN "item" i ON i."readableId" = p."id" AND i."companyId" = p."companyId"
  LEFT JOIN item_revisions ir ON true
  LEFT JOIN (
    SELECT
      ps."itemId",
      string_agg(ps."supplierPartId", ',') AS "supplierIds"
    FROM "supplierPart" ps
    GROUP BY ps."itemId"
  ) ps ON ps."itemId" = i.id
  LEFT JOIN "modelUpload" mu ON mu.id = i."modelUploadId"
  LEFT JOIN "unitOfMeasure" uom ON uom.code = i."unitOfMeasureCode" AND uom."companyId" = i."companyId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  WHERE i."id" = item_id;
END;
$$ LANGUAGE plpgsql;


-- Forked from 20260629142317_item-mpn.sql
DROP FUNCTION IF EXISTS get_tool_details(TEXT);
CREATE OR REPLACE FUNCTION get_tool_details(item_id TEXT)
RETURNS TABLE (
    "active" BOOLEAN,
    "assignee" TEXT,
    "defaultMethodType" "methodType",
    "sourcingType" "sourcingType",
    "description" TEXT,
    "itemTrackingType" "itemTrackingType",
    "requiresInspection" BOOLEAN,
    "name" TEXT,
    "replenishmentSystem" "itemReplenishmentSystem",
    "unitOfMeasureCode" TEXT,
    "notes" JSONB,
    "thumbnailPath" TEXT,
    "modelId" TEXT,
    "modelPath" TEXT,
    "modelName" TEXT,
    "modelSize" BIGINT,
    "id" TEXT,
    "companyId" TEXT,
    "unitOfMeasure" TEXT,
    "readableId" TEXT,
    "revision" TEXT,
    "readableIdWithRevision" TEXT,
    "revisions" JSON,
    "customFields" JSONB,
    "tags" TEXT[],
    "itemPostingGroupId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP WITH TIME ZONE,
    "mpn" TEXT,
    "taxable" BOOLEAN
) AS $$
DECLARE
  v_readable_id TEXT;
  v_company_id TEXT;
BEGIN
  SELECT i."readableId", i."companyId" INTO v_readable_id, v_company_id
  FROM "item" i
  WHERE i.id = item_id;

  RETURN QUERY
  WITH item_revisions AS (
    SELECT
      json_agg(
        json_build_object(
          'id', i.id,
          'revision', i."revision",
          'methodType', i."defaultMethodType",
          'type', i."type"
        ) ORDER BY
          i."createdAt" DESC
      ) as "revisions"
    FROM "item" i
    WHERE i."readableId" = v_readable_id
    AND i."companyId" = v_company_id
    AND i."type" = 'Tool'
  )
  SELECT
    i."active",
    i."assignee",
    i."defaultMethodType",
    i."sourcingType",
    i."description",
    i."itemTrackingType",
    i."requiresInspection",
    i."name",
    i."replenishmentSystem",
    i."unitOfMeasureCode",
    i."notes",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    mu.id as "modelId",
    mu."modelPath",
    mu."name" as "modelName",
    mu."size" as "modelSize",
    i."id",
    i."companyId",
    uom.name as "unitOfMeasure",
    i."readableId",
    i."revision",
    i."readableIdWithRevision",
    ir."revisions",
    t."customFields",
    t."tags",
    ic."itemPostingGroupId",
    i."createdBy",
    i."createdAt",
    i."updatedBy",
    i."updatedAt",
    i."mpn",
    i."taxable"
  FROM "tool" t
  LEFT JOIN "item" i ON i."readableId" = t."id" AND i."companyId" = t."companyId"
  LEFT JOIN item_revisions ir ON true
  LEFT JOIN (
    SELECT
      ps."itemId",
      string_agg(ps."supplierPartId", ',') AS "supplierIds"
    FROM "supplierPart" ps
    GROUP BY ps."itemId"
  ) ps ON ps."itemId" = i.id
  LEFT JOIN "modelUpload" mu ON mu.id = i."modelUploadId"
  LEFT JOIN "unitOfMeasure" uom ON uom.code = i."unitOfMeasureCode" AND uom."companyId" = i."companyId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  WHERE i."id" = item_id;
END;
$$ LANGUAGE plpgsql;


-- Forked from 20260629142317_item-mpn.sql
DROP FUNCTION IF EXISTS get_material_details(TEXT);
CREATE OR REPLACE FUNCTION get_material_details(item_id TEXT)
RETURNS TABLE (
    "active" BOOLEAN,
    "assignee" TEXT,
    "defaultMethodType" "methodType",
    "description" TEXT,
    "itemTrackingType" "itemTrackingType",
    "requiresInspection" BOOLEAN,
    "name" TEXT,
    "replenishmentSystem" "itemReplenishmentSystem",
    "unitOfMeasureCode" TEXT,
    "notes" JSONB,
    "thumbnailPath" TEXT,
    "modelUploadId" TEXT,
    "modelPath" TEXT,
    "modelName" TEXT,
    "modelSize" BIGINT,
    "id" TEXT,
    "companyId" TEXT,
    "readableId" TEXT,
    "revision" TEXT,
    "readableIdWithRevision" TEXT,
    "supplierIds" TEXT,
    "unitOfMeasure" TEXT,
    "revisions" JSON,
    "materialForm" TEXT,
    "materialSubstance" TEXT,
    "finish" TEXT,
    "grade" TEXT,
    "dimensions" TEXT,
    "materialType" TEXT,
    "materialSubstanceId" TEXT,
    "materialFormId" TEXT,
    "materialTypeId" TEXT,
    "dimensionId" TEXT,
    "gradeId" TEXT,
    "finishId" TEXT,
    "customFields" JSONB,
    "tags" TEXT[],
    "itemPostingGroupId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP WITH TIME ZONE,
    "mpn" TEXT,
    "taxable" BOOLEAN
) AS $$
DECLARE
  v_readable_id TEXT;
  v_company_id TEXT;
BEGIN
  SELECT i."readableId", i."companyId" INTO v_readable_id, v_company_id
  FROM "item" i
  WHERE i.id = item_id;

  RETURN QUERY
  WITH item_revisions AS (
    SELECT
      json_agg(
        json_build_object(
          'id', i.id,
          'revision', i."revision",
          'methodType', i."defaultMethodType",
          'type', i."type"
        ) ORDER BY
          i."createdAt"
      ) as "revisions"
    FROM "item" i
    WHERE i."readableId" = v_readable_id
    AND i."companyId" = v_company_id
    AND i."type" = 'Material'
  )
  SELECT
    i."active",
    i."assignee",
    i."defaultMethodType",
    i."description",
    i."itemTrackingType",
    i."requiresInspection",
    i."name",
    i."replenishmentSystem",
    i."unitOfMeasureCode",
    i."notes",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    mu.id as "modelUploadId",
    mu."modelPath",
    mu."name" as "modelName",
    mu."size" as "modelSize",
    i."id",
    i."companyId",
    i."readableId",
    i."revision",
    i."readableIdWithRevision",
    ps."supplierIds",
    uom.name as "unitOfMeasure",
    ir."revisions",
    mf."name" AS "materialForm",
    ms."name" AS "materialSubstance",
    mfin."name" AS "finish",
    mg."name" AS "grade",
    md."name" AS "dimensions",
    mt."name" AS "materialType",
    m."materialSubstanceId",
    m."materialFormId",
    m."materialTypeId",
    m."dimensionId",
    m."gradeId",
    m."finishId",
    m."customFields",
    m."tags",
    ic."itemPostingGroupId",
    i."createdBy",
    i."createdAt",
    i."updatedBy",
    i."updatedAt",
    i."mpn",
    i."taxable"
  FROM "material" m
    LEFT JOIN "item" i ON i."readableId" = m."id" AND i."companyId" = m."companyId"
    LEFT JOIN item_revisions ir ON true
    LEFT JOIN (
      SELECT
        ps."itemId",
        string_agg(ps."supplierPartId", ',') AS "supplierIds"
      FROM "supplierPart" ps
      GROUP BY ps."itemId"
    ) ps ON ps."itemId" = i.id
    LEFT JOIN "modelUpload" mu ON mu.id = i."modelUploadId"
    LEFT JOIN "unitOfMeasure" uom ON uom.code = i."unitOfMeasureCode" AND uom."companyId" = i."companyId"
    LEFT JOIN "materialForm" mf ON mf."id" = m."materialFormId"
    LEFT JOIN "materialSubstance" ms ON ms."id" = m."materialSubstanceId"
    LEFT JOIN "materialDimension" md ON m."dimensionId" = md."id"
    LEFT JOIN "materialFinish" mfin ON m."finishId" = mfin."id"
    LEFT JOIN "materialGrade" mg ON m."gradeId" = mg."id"
    LEFT JOIN "materialType" mt ON m."materialTypeId" = mt."id"
    LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
    WHERE i."id" = item_id;
END;
$$ LANGUAGE plpgsql STABLE;


-- Forked from 20260629142317_item-mpn.sql
DROP FUNCTION IF EXISTS get_consumable_details(TEXT);
CREATE OR REPLACE FUNCTION get_consumable_details(item_id TEXT)
RETURNS TABLE (
    "active" BOOLEAN,
    "assignee" TEXT,
    "defaultMethodType" "methodType",
    "description" TEXT,
    "itemTrackingType" "itemTrackingType",
    "requiresInspection" BOOLEAN,
    "name" TEXT,
    "replenishmentSystem" "itemReplenishmentSystem",
    "unitOfMeasureCode" TEXT,
    "notes" JSONB,
    "thumbnailPath" TEXT,
    "modelUploadId" TEXT,
    "modelPath" TEXT,
    "modelName" TEXT,
    "modelSize" BIGINT,
    "id" TEXT,
    "companyId" TEXT,
    "readableId" TEXT,
    "revision" TEXT,
    "readableIdWithRevision" TEXT,
    "supplierIds" TEXT,
    "unitOfMeasure" TEXT,
    "revisions" JSON,
    "customFields" JSONB,
    "tags" TEXT[],
    "itemPostingGroupId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP WITH TIME ZONE,
    "mpn" TEXT,
    "taxable" BOOLEAN
) AS $$
DECLARE
  v_readable_id TEXT;
  v_company_id TEXT;
BEGIN
  SELECT i."readableId", i."companyId" INTO v_readable_id, v_company_id
  FROM "item" i
  WHERE i.id = item_id;

  RETURN QUERY
  WITH item_revisions AS (
    SELECT
      json_agg(
        json_build_object(
          'id', i.id,
          'revision', i."revision",
          'methodType', i."defaultMethodType",
          'type', i."type"
        ) ORDER BY
          i."createdAt"
      ) as "revisions"
    FROM "item" i
    WHERE i."readableId" = v_readable_id
    AND i."companyId" = v_company_id
    AND i."type" = 'Consumable'
  )
  SELECT
    i."active",
    i."assignee",
    i."defaultMethodType",
    i."description",
    i."itemTrackingType",
    i."requiresInspection",
    i."name",
    i."replenishmentSystem",
    i."unitOfMeasureCode",
    i."notes",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    mu.id as "modelUploadId",
    mu."modelPath",
    mu."name" as "modelName",
    mu."size" as "modelSize",
    i."id",
    i."companyId",
    i."readableId",
    i."revision",
    i."readableIdWithRevision",
    ps."supplierIds",
    uom.name as "unitOfMeasure",
    ir."revisions",
    c."customFields",
    c."tags",
    ic."itemPostingGroupId",
    i."createdBy",
    i."createdAt",
    i."updatedBy",
    i."updatedAt",
    i."mpn",
    i."taxable"
  FROM "consumable" c
    LEFT JOIN "item" i ON i."readableId" = c."id" AND i."companyId" = c."companyId"
    LEFT JOIN item_revisions ir ON true
    LEFT JOIN (
      SELECT
        ps."itemId",
        string_agg(ps."supplierPartId", ',') AS "supplierIds"
      FROM "supplierPart" ps
      GROUP BY ps."itemId"
    ) ps ON ps."itemId" = i.id
    LEFT JOIN "modelUpload" mu ON mu.id = i."modelUploadId"
    LEFT JOIN "unitOfMeasure" uom ON uom.code = i."unitOfMeasureCode" AND uom."companyId" = i."companyId"
    LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
    WHERE i."id" = item_id;
END;
$$ LANGUAGE plpgsql STABLE;


-- Forked from 20260707022141_service-item-type.sql
DROP FUNCTION IF EXISTS get_service_details(TEXT);
CREATE OR REPLACE FUNCTION get_service_details(item_id TEXT)
RETURNS TABLE (
    "active" BOOLEAN,
    "assignee" TEXT,
    "defaultMethodType" "methodType",
    "sourcingType" "sourcingType",
    "description" TEXT,
    "itemTrackingType" "itemTrackingType",
    "requiresInspection" BOOLEAN,
    "name" TEXT,
    "replenishmentSystem" "itemReplenishmentSystem",
    "unitOfMeasureCode" TEXT,
    "notes" JSONB,
    "thumbnailPath" TEXT,
    "modelId" TEXT,
    "modelPath" TEXT,
    "modelName" TEXT,
    "modelSize" BIGINT,
    "id" TEXT,
    "companyId" TEXT,
    "unitOfMeasure" TEXT,
    "readableId" TEXT,
    "revision" TEXT,
    "readableIdWithRevision" TEXT,
    "revisions" JSON,
    "customFields" JSONB,
    "tags" TEXT[],
    "itemPostingGroupId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP WITH TIME ZONE,
    "mpn" TEXT,
    "taxable" BOOLEAN
) AS $$
DECLARE
  v_readable_id TEXT;
  v_company_id TEXT;
BEGIN
  SELECT i."readableId", i."companyId" INTO v_readable_id, v_company_id
  FROM "item" i
  WHERE i.id = item_id;

  RETURN QUERY
  WITH item_revisions AS (
    SELECT
      json_agg(
        json_build_object(
          'id', i.id,
          'revision', i."revision",
          'methodType', i."defaultMethodType",
          'type', i."type"
        ) ORDER BY
          i."createdAt" DESC
      ) as "revisions"
    FROM "item" i
    WHERE i."readableId" = v_readable_id
    AND i."companyId" = v_company_id
    AND i."type" = 'Service'
  )
  SELECT
    i."active",
    i."assignee",
    i."defaultMethodType",
    i."sourcingType",
    i."description",
    i."itemTrackingType",
    i."requiresInspection",
    i."name",
    i."replenishmentSystem",
    i."unitOfMeasureCode",
    i."notes",
    CASE
      WHEN i."thumbnailPath" IS NULL AND mu."thumbnailPath" IS NOT NULL THEN mu."thumbnailPath"
      ELSE i."thumbnailPath"
    END as "thumbnailPath",
    mu.id as "modelId",
    mu."modelPath",
    mu."name" as "modelName",
    mu."size" as "modelSize",
    i."id",
    i."companyId",
    uom.name as "unitOfMeasure",
    i."readableId",
    i."revision",
    i."readableIdWithRevision",
    ir."revisions",
    s."customFields",
    s."tags",
    ic."itemPostingGroupId",
    i."createdBy",
    i."createdAt",
    i."updatedBy",
    i."updatedAt",
    i."mpn",
    i."taxable"
  FROM "service" s
  LEFT JOIN "item" i ON i."readableId" = s."id" AND i."companyId" = s."companyId"
  LEFT JOIN item_revisions ir ON true
  LEFT JOIN (
    SELECT
      ps."itemId",
      string_agg(ps."supplierPartId", ',') AS "supplierIds"
    FROM "supplierPart" ps
    GROUP BY ps."itemId"
  ) ps ON ps."itemId" = i.id
  LEFT JOIN "modelUpload" mu ON mu.id = i."modelUploadId"
  LEFT JOIN "unitOfMeasure" uom ON uom.code = i."unitOfMeasureCode" AND uom."companyId" = i."companyId"
  LEFT JOIN "itemCost" ic ON ic."itemId" = i.id
  WHERE i."id" = item_id;
END;
$$ LANGUAGE plpgsql;
