import type { BookingConnector, CallScope, IncompleteReason } from "./http-connector.js";
import type { ContainerRecord } from "./schemas.js";
import type { SecurityContext } from "../security-context.js";

/** A record last updated longer ago than this is reported as stale. */
export const DEFAULT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ContainerSummary {
  retrieved: ContainerRecord[];
  expected: number;
  pagesFetched: number;
  complete: boolean;
  /** Sum over *all* containers. `null` unless the listing is complete: a partial sum is not a total. */
  totalWeightKg: number | null;
  /** Sum over what was retrieved — a lower bound when the listing is incomplete. */
  retrievedWeightKg: number;
  incomplete?: IncompleteReason;
}

export type LookupOutcome =
  | { kind: "not_found"; bookingNo: string }
  | {
      kind: "found";
      bookingNo: string;
      status: string;
      documentCutoff: string;
      updatedAt: string;
      asOf: string;
      /** Computed here from validated timestamps and the business clock — not left for the model to work out. */
      cutoffPassed: boolean;
      freshness: "fresh" | "stale";
      ageDays: number;
      computedAt: string;
      containers: ContainerSummary;
    };

const sumWeights = (items: readonly ContainerRecord[]): number => items.reduce((total, item) => total + item.weightKg, 0);

/**
 * The numeric and date conclusions the assistant may state, computed over validated data. The model
 * is told to quote these values, not to derive them: sums and date comparisons in prose are where a
 * language model is least reliable, and a partial listing must never yield a total.
 */
export function buildLookupOutcome(
  booking: { bookingNo: string; status: string; documentCutoff: string; updatedAt: string; containerNos: readonly string[] },
  asOf: string,
  listing: { items: readonly ContainerRecord[]; pagesFetched: number; complete: boolean; incomplete?: IncompleteReason },
  now: Date,
  freshnessMs: number = DEFAULT_FRESHNESS_MS,
): LookupOutcome {
  const ageMs = now.getTime() - Date.parse(booking.updatedAt);
  const retrievedWeightKg = sumWeights(listing.items);
  return {
    kind: "found",
    bookingNo: booking.bookingNo,
    status: booking.status,
    documentCutoff: booking.documentCutoff,
    updatedAt: booking.updatedAt,
    asOf,
    cutoffPassed: now.getTime() >= Date.parse(booking.documentCutoff),
    freshness: ageMs > freshnessMs ? "stale" : "fresh",
    ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
    computedAt: now.toISOString(),
    containers: {
      retrieved: [...listing.items],
      expected: booking.containerNos.length,
      pagesFetched: listing.pagesFetched,
      complete: listing.complete,
      totalWeightKg: listing.complete ? retrievedWeightKg : null,
      retrievedWeightKg,
      ...(listing.incomplete === undefined ? {} : { incomplete: listing.incomplete }),
    },
  };
}

export interface LookupServiceOptions {
  connector: BookingConnector;
  clock: () => Date;
  freshnessMs?: number;
}

/**
 * Looks one booking up through the connector. A failure to get the booking record itself is thrown
 * (`ConnectorFailure`); a failure while listing containers is *not* — the booking is still known, so
 * the outcome is `found` with an incomplete container summary and the reason.
 */
export class BookingLookupService {
  public constructor(private readonly options: LookupServiceOptions) {}

  public async lookup(scope: CallScope, context: SecurityContext, bookingNo: string): Promise<LookupOutcome> {
    const record = await this.options.connector.getBooking(scope, context, bookingNo);
    if (!record.found) return { kind: "not_found", bookingNo };
    const listing = await this.options.connector.listContainers(scope, context, bookingNo, record.booking.containerNos);
    return buildLookupOutcome(record.booking, record.asOf, listing, this.options.clock(), this.options.freshnessMs);
  }
}
