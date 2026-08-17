import { MenuIcon, MenuItem } from "@carbon/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ColumnDef } from "@tanstack/react-table";
import { memo, useCallback, useMemo } from "react";
import { LuLandmark, LuPencil, LuTrash, LuTruck } from "react-icons/lu";
import { useNavigate } from "react-router";
import { Hyperlink, New, SupplierAvatar, Table } from "~/components";
import { Enumerable } from "~/components/Enumerable";
import { usePermissions, useUrlParams } from "~/hooks";
import { useCustomColumns } from "~/hooks/useCustomColumns";
import { useSuppliers } from "~/stores";
import { path } from "~/utils/path";
import type { TaxAuthority } from "../../types";

type TaxAuthoritiesTableProps = {
  data: TaxAuthority[];
  count: number;
};

const TaxAuthoritiesTable = memo(
  ({ data, count }: TaxAuthoritiesTableProps) => {
    const { t } = useLingui();
    const [params] = useUrlParams();
    const navigate = useNavigate();
    const permissions = usePermissions();
    const customColumns = useCustomColumns<TaxAuthority>("taxAuthority");
    const [suppliers] = useSuppliers();

    const columns = useMemo<ColumnDef<TaxAuthority>[]>(() => {
      const defaultColumns: ColumnDef<TaxAuthority>[] = [
        {
          accessorKey: "name",
          header: t`Name`,
          cell: ({ row }) => (
            <Hyperlink to={`${row.original.id}?${params.toString()}`}>
              <Enumerable value={row.original.name} />
            </Hyperlink>
          ),
          meta: {
            icon: <LuLandmark />
          }
        },
        {
          accessorKey: "supplierId",
          header: t`Supplier`,
          cell: ({ row }) =>
            row.original.supplierId ? (
              <SupplierAvatar supplierId={row.original.supplierId} />
            ) : null,
          meta: {
            filter: {
              type: "static",
              options: suppliers.map((supplier) => ({
                value: supplier.id,
                label: supplier.name
              }))
            },
            icon: <LuTruck />
          }
        }
      ];
      return [...defaultColumns, ...customColumns];
    }, [params, customColumns, suppliers, t]);

    const renderContextMenu = useCallback(
      (row: TaxAuthority) => {
        return (
          <>
            <MenuItem
              disabled={!permissions.can("update", "accounting")}
              onClick={() => {
                navigate(
                  `${path.to.taxAuthority(row.id)}?${params.toString()}`
                );
              }}
            >
              <MenuIcon icon={<LuPencil />} />
              <Trans>Edit Tax Authority</Trans>
            </MenuItem>
            <MenuItem
              disabled={!permissions.can("delete", "accounting")}
              onClick={() => {
                navigate(
                  `${path.to.deleteTaxAuthority(row.id)}?${params.toString()}`
                );
              }}
            >
              <MenuIcon icon={<LuTrash />} />
              <Trans>Delete Tax Authority</Trans>
            </MenuItem>
          </>
        );
      },
      [navigate, params, permissions]
    );

    return (
      <Table<TaxAuthority>
        data={data}
        columns={columns}
        count={count}
        primaryAction={
          permissions.can("create", "accounting") && (
            <New label={t`Tax Authority`} to={`new?${params.toString()}`} />
          )
        }
        renderContextMenu={renderContextMenu}
        title={t`Tax Authorities`}
      />
    );
  }
);

TaxAuthoritiesTable.displayName = "TaxAuthoritiesTable";
export default TaxAuthoritiesTable;
