import {
  Alert,
  AlertDescription,
  AlertTitle,
  IconButton,
  MenuIcon,
  MenuItem
} from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useCallback, useMemo, useState } from "react";
import {
  LuCalendar,
  LuFileBadge,
  LuGlobe,
  LuMapPin,
  LuPencil,
  LuTrash,
  LuTriangleAlert,
  LuX
} from "react-icons/lu";
import { useNavigate } from "react-router";
import { Hyperlink, New, Table } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import { useDateFormatter, usePermissions, useUrlParams } from "~/hooks";
import { useCustomColumns } from "~/hooks/useCustomColumns";
import { path } from "~/utils/path";
import type { TaxRegistration } from "../../types";

export type TaxRegistrationWarnings = {
  /** Active tax codes whose country/state has no matching registration. */
  codesWithoutRegistration: string[];
  /** Registrations whose country/state has no matching active tax code. */
  registrationsWithoutCode: string[];
};

type TaxRegistrationsTableProps = {
  data: TaxRegistration[];
  count: number;
  warnings: TaxRegistrationWarnings;
};

const TaxRegistrationsTable = memo(
  ({ data, count, warnings }: TaxRegistrationsTableProps) => {
    const { t } = useLingui();
    const [params] = useUrlParams();
    const navigate = useNavigate();
    const permissions = usePermissions();
    const { formatDate } = useDateFormatter();
    const customColumns = useCustomColumns<TaxRegistration>("taxRegistration");
    const [dismissed, setDismissed] = useState(false);

    const hasWarnings =
      warnings.codesWithoutRegistration.length > 0 ||
      warnings.registrationsWithoutCode.length > 0;

    const columns = useMemo<ColumnDef<TaxRegistration>[]>(() => {
      const defaultColumns: ColumnDef<TaxRegistration>[] = [
        {
          accessorKey: "registrationNumber",
          header: t`Registration Number`,
          cell: ({ row }) => (
            <Hyperlink to={`${row.original.id}?${params.toString()}`}>
              {row.original.registrationNumber}
            </Hyperlink>
          ),
          meta: {
            icon: <LuFileBadge />
          }
        },
        {
          accessorKey: "countryCode",
          header: t`Country`,
          cell: (item) => <Enumerable value={item.getValue<string>()} />,
          meta: {
            icon: <LuGlobe />
          }
        },
        {
          accessorKey: "state",
          header: t`State / Province`,
          cell: (item) => item.getValue<string | null>(),
          meta: {
            icon: <LuMapPin />
          }
        },
        {
          accessorKey: "effectiveDate",
          header: t`Effective Date`,
          cell: (item) => formatDate(item.getValue<string | null>()),
          meta: {
            icon: <LuCalendar />
          }
        },
        {
          accessorKey: "endDate",
          header: t`End Date`,
          cell: (item) => formatDate(item.getValue<string | null>()),
          meta: {
            icon: <LuCalendar />
          }
        }
      ];
      return [...defaultColumns, ...customColumns];
    }, [params, customColumns, formatDate, t]);

    const renderContextMenu = useCallback(
      (row: TaxRegistration) => {
        return (
          <>
            <MenuItem
              disabled={!permissions.can("update", "accounting")}
              onClick={() => {
                navigate(
                  `${path.to.taxRegistration(row.id)}?${params.toString()}`
                );
              }}
            >
              <MenuIcon icon={<LuPencil />} />
              <Trans>Edit Tax Registration</Trans>
            </MenuItem>
            <MenuItem
              disabled={!permissions.can("delete", "accounting")}
              onClick={() => {
                navigate(
                  `${path.to.deleteTaxRegistration(row.id)}?${params.toString()}`
                );
              }}
            >
              <MenuIcon icon={<LuTrash />} />
              <Trans>Delete Tax Registration</Trans>
            </MenuItem>
          </>
        );
      },
      [navigate, params, permissions]
    );

    return (
      <div className="flex flex-col w-full h-full">
        {hasWarnings && !dismissed && (
          <div className="w-full px-0 md:px-4 lg:px-6 pt-4">
            <Alert variant="warning" className="relative">
              <LuTriangleAlert />
              <AlertTitle>
                <Trans>Tax registration coverage</Trans>
              </AlertTitle>
              <AlertDescription>
                {warnings.codesWithoutRegistration.length > 0 && (
                  <p>
                    <Trans>
                      These tax codes have no matching registration:
                    </Trans>{" "}
                    {warnings.codesWithoutRegistration.join(", ")}
                  </p>
                )}
                {warnings.registrationsWithoutCode.length > 0 && (
                  <p>
                    <Trans>
                      These registrations have no matching active tax code:
                    </Trans>{" "}
                    {warnings.registrationsWithoutCode.join(", ")}
                  </p>
                )}
              </AlertDescription>
              <IconButton
                aria-label={t`Dismiss`}
                className="absolute top-1 right-1"
                icon={<LuX />}
                onClick={() => setDismissed(true)}
                size="sm"
                variant="ghost"
              />
            </Alert>
          </div>
        )}
        <div className="flex-1 min-h-0">
          <Table<TaxRegistration>
            data={data}
            columns={columns}
            count={count}
            primaryAction={
              permissions.can("create", "accounting") && (
                <New
                  label={t`Tax Registration`}
                  to={`new?${params.toString()}`}
                />
              )
            }
            renderContextMenu={renderContextMenu}
            title={t`Tax Registrations`}
          />
        </div>
      </div>
    );
  }
);

TaxRegistrationsTable.displayName = "TaxRegistrationsTable";
export default TaxRegistrationsTable;
