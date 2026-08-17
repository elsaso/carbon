import { Alert, AlertDescription, Button, HStack } from "@carbon/react";
import { Trans } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { LuInfo } from "react-icons/lu";
import { useFetcher } from "react-router";
import { useCountries } from "~/components/Form/Country";
import type { suggestTaxCode } from "~/modules/accounting";
import { path } from "~/utils/path";

type Suggestion = NonNullable<
  Awaited<ReturnType<typeof suggestTaxCode>>["data"]
>[number];

/**
 * The advisory "this address looks like {place} — apply {code}?" hint, shared by
 * the customer, customer-location, and supplier tax forms so all three behave
 * identically (plan Task 13).
 *
 * Two rules this component exists to enforce:
 *
 *  - **It never auto-applies.** Tax always resolves from a code someone
 *    explicitly assigned, never from an inferred address. Applying is a click.
 *  - **It only offers when nothing is assigned.** Once a code is on the record,
 *    a suggestion is second-guessing a deliberate choice, so it stays quiet —
 *    including when the assigned code differs from what the address suggests.
 */
export function TaxCodeSuggestion({
  countryCode,
  state,
  taxCodeId,
  onApply
}: {
  countryCode: string | null | undefined;
  state: string | null | undefined;
  /** The code currently assigned to the record; any value silences the hint. */
  taxCodeId: string | null | undefined;
  onApply: (taxCodeId: string) => void;
}) {
  const fetcher = useFetcher<Awaited<ReturnType<typeof suggestTaxCode>>>();
  const countries = useCountries();
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  const { load } = fetcher;
  useEffect(() => {
    if (!countryCode && !state) return;
    load(path.to.api.suggestTaxCode(countryCode ?? null, state ?? null));
  }, [countryCode, state, load]);

  const apply = useCallback(
    (id: string) => {
      onApply(id);
    },
    [onApply]
  );

  // Most specific first — suggestTaxCode already ranks state > country > global.
  const suggestion: Suggestion | null = fetcher.data?.data?.[0] ?? null;

  if (!suggestion || taxCodeId || suggestion.id === dismissedId) return null;

  const countryName =
    countries.find((c) => c.value === countryCode)?.label ?? countryCode;
  const place = [state, countryName].filter(Boolean).join(", ");

  return (
    <Alert variant="info">
      <LuInfo />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <Trans>
            This address is in {place} — apply {suggestion.name}?
          </Trans>
        </span>
        <HStack spacing={2}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => apply(suggestion.id)}
          >
            <Trans>Apply</Trans>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDismissedId(suggestion.id)}
          >
            <Trans>Dismiss</Trans>
          </Button>
        </HStack>
      </AlertDescription>
    </Alert>
  );
}

export default TaxCodeSuggestion;
