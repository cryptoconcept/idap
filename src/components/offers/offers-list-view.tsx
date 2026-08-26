import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { OfferStatusBadge } from "@/components/offers/offer-status-badge";
import type { OfferDTO } from "@/services/offer.service";
import type { OfferStatus } from "@/lib/constants";

/** `updatedAt` is an ISO string on the DTO, and can be absent on a row from
 * before the field existed — render a dash rather than an "Invalid Date". */
function formatUpdated(offer: OfferDTO): string {
  if (!offer.updatedAt) return "—";
  return new Date(offer.updatedAt).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** `validUntil` is an ISO string, or absent for an offer with no end date. */
function formatValidUntil(offer: OfferDTO): string {
  if (!offer.validUntil) return "No end date";
  return new Date(offer.validUntil).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** `PERCENTAGE` and `FLAT` are the only two `OfferKind`s — see `OFFER_KINDS`. */
function formatDiscount(offer: OfferDTO): string {
  return offer.kind === "PERCENTAGE"
    ? `${offer.value}% off`
    : `₹${offer.value.toLocaleString("en-IN")} off`;
}

/**
 * No bulk selection here, unlike `FeeStructuresListView` — an offer has no
 * line items to bulk-price, so there is nothing analogous to `/fees/bulk`,
 * and this stays a server component like `ScholarshipsListView`.
 */
export function OffersListView({ offers }: { offers: OfferDTO[] }) {
  return (
    <>
      <PageHeader
        title="Offers"
        description="Offers your website and partner sites read from the public API."
        actions={
          <Button asChild size="sm">
            <Link href="/offers/new">
              <Plus className="size-4" />
              Add an offer
            </Link>
          </Button>
        }
      />

      {offers.length === 0 ? (
        <EmptyState
          title="No offers yet"
          description="Publish an offer and any website reading your public API picks it up."
          actionLabel="Add an offer"
          actionHref="/offers/new"
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Applies to</th>
                <th className="px-4 py-2 font-medium">Discount</th>
                <th className="px-4 py-2 font-medium">Valid until</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((offer) => (
                <tr key={offer.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/offers/${offer.id}`} className="font-medium hover:underline">
                      {offer.title}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">{offer.classOrCourse ?? "All classes and courses"}</td>
                  <td className="px-4 py-2.5">{formatDiscount(offer)}</td>
                  <td className="px-4 py-2.5">{formatValidUntil(offer)}</td>
                  <td className="px-4 py-2.5">
                    <OfferStatusBadge status={offer.status as OfferStatus} />
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                    {formatUpdated(offer)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
