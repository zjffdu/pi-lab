/**
 * Last-line detector for cross-tenant data. `markers` are strings that identify another
 * tenant's records (`TenantBookingStore.foreignMarkers`). A hit means scoping already failed
 * upstream — this guard reports it, it never repairs it and is never the isolation mechanism.
 */
export function findForeignMarkers(text: string, markers: readonly string[]): string[] {
  return markers.filter((marker) => text.includes(marker));
}
