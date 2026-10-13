import { ConnectorFailure } from "./errors.js";

export interface BookingRecord {
  bookingNo: string;
  status: string;
  documentCutoff: string;
  updatedAt: string;
  /** Non-empty and unique: the booking's own account of which containers belong to it. A listing is complete only if it matches this set. */
  containerNos: string[];
}

export interface ContainerRecord {
  containerNo: string;
  weightKg: number;
}

export interface ContainerPage {
  items: ContainerRecord[];
  nextCursor: string | null;
}

/** Clock skew tolerated between us and the API when checking that a timestamp is not in the future. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_ITEMS_PER_PAGE = 100;
export const MAX_CONTAINERS_PER_BOOKING = 500;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const bad = (message: string): never => {
  throw new ConnectorFailure("malformed_response", message);
};

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad(`${where} is not an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string, max = 80): string {
  if (typeof value !== "string" || value === "" || value.length > max) return bad(`${where} is not a non-empty string of at most ${max} characters`);
  return value;
}

/** `notAfter` rejects a timestamp from the future (a record cannot have been updated tomorrow); a deadline may legitimately be later. */
function timestamp(value: unknown, where: string, notAfter: Date | undefined): string {
  const raw = text(value, where, 40);
  if (!ISO_UTC.test(raw) || Number.isNaN(Date.parse(raw))) return bad(`${where} is not an ISO-8601 UTC timestamp`);
  if (notAfter !== undefined && Date.parse(raw) > notAfter.getTime() + MAX_CLOCK_SKEW_MS) return bad(`${where} is in the future`);
  return raw;
}

function containerNumbers(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTAINERS_PER_BOOKING) return bad(`${where} is not a non-empty array of at most ${MAX_CONTAINERS_PER_BOOKING} container numbers`);
  const seen = new Set<string>();
  return value.map((entry: unknown, index) => {
    const containerNo = text(entry, `${where}[${index}]`, 20);
    if (seen.has(containerNo)) bad(`${where} repeats container ${containerNo}`);
    seen.add(containerNo);
    return containerNo;
  });
}

/**
 * Hand-written validators, not casts: an API response is untrusted input, and the numbers and dates
 * the assistant reasons about are computed from these validated values, never from raw JSON.
 * Unknown extra fields are ignored and never passed on.
 */
export function parseBookingResponse(body: unknown, requestedBookingNo: string, now: Date): { booking: BookingRecord; asOf: string } {
  const root = object(body, "response");
  const data = object(root.data, "response.data");
  const bookingNo = text(data.bookingNo, "data.bookingNo");
  // A response for a different booking than the one asked for is a cross-wired answer, not data.
  if (bookingNo !== requestedBookingNo) bad("response is for a different booking than requested");
  return {
    booking: {
      bookingNo,
      status: text(data.status, "data.status", 40),
      documentCutoff: timestamp(data.documentCutoff, "data.documentCutoff", undefined),
      updatedAt: timestamp(data.updatedAt, "data.updatedAt", now),
      containerNos: containerNumbers(data.containerNos, "data.containerNos"),
    },
    asOf: timestamp(root.asOf, "asOf", now),
  };
}

export function parseContainersResponse(body: unknown, now: Date): { page: ContainerPage; asOf: string } {
  const root = object(body, "response");
  const data = object(root.data, "response.data");
  if (!Array.isArray(data.items)) bad("data.items is not an array");
  const rawItems = data.items as unknown[];
  if (rawItems.length > MAX_ITEMS_PER_PAGE) bad("data.items is larger than the page limit");
  const seen = new Set<string>();
  const items = rawItems.map((raw, index): ContainerRecord => {
    const item = object(raw, `data.items[${index}]`);
    const containerNo = text(item.containerNo, `data.items[${index}].containerNo`, 20);
    if (seen.has(containerNo)) bad(`data.items repeats container ${containerNo}`);
    seen.add(containerNo);
    const weightKg = item.weightKg;
    if (typeof weightKg !== "number" || !Number.isFinite(weightKg) || weightKg < 0) bad(`data.items[${index}].weightKg is not a non-negative number`);
    return { containerNo, weightKg: weightKg as number };
  });
  const { nextCursor } = data;
  if (nextCursor !== null && (typeof nextCursor !== "string" || nextCursor === "" || nextCursor.length > 64)) bad("data.nextCursor is neither null nor a short string");
  return { page: { items, nextCursor: nextCursor as string | null }, asOf: timestamp(root.asOf, "asOf", now) };
}
