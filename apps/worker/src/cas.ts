// Compare-and-swap for the shared JSON documents in R2 (the shelf, the events list, push subscriptions, who
// joined, reader faces, tombstones…). Every one of them used to be read → changed → written back, so two
// requests at once (two readers finishing a story, a sticker and a play in the same second) kept the LAST write
// and silently dropped the other (review P1-04, owner 2026-11-01). Here a write succeeds only if the object is
// still the one we read (R2 `onlyIf: { etagMatches }`), otherwise we re-read and apply the change again.
// Family scale means a retry is rare; the loop is bounded so a stuck object can never hang a request.

export type Mutate<T> = (current: T) => T | null; // null → nothing to write (the read value is returned)

/** The slice of R2Bucket this needs — small on purpose, so a test can hand in a fake. */
export interface CasBucket {
  get(key: string): Promise<{ etag: string; json(): Promise<unknown> } | null>;
  put(
    key: string,
    value: string,
    options?: { onlyIf?: { etagMatches?: string } | Headers; httpMetadata?: { contentType?: string } },
  ): Promise<unknown | null>;
}

export class CasExhausted extends Error {
  constructor(key: string, tries: number) {
    super(`cas: "${key}" kept changing (${tries} tries)`);
  }
}

/**
 * Atomically update the JSON at `key`. `fallback` is the value when the object doesn't exist yet. Returns the
 * value that is now stored (or the current one when `mutate` returned null).
 */
export async function updateJson<T>(bucket: CasBucket, key: string, fallback: T, mutate: Mutate<T>, tries = 6): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const obj = await bucket.get(key);
    let current = fallback;
    if (obj) {
      try {
        current = (await obj.json()) as T;
      } catch {
        current = fallback; // an unreadable object is replaced, not propagated
      }
    }
    const next = mutate(current);
    if (next === null) return current;
    // existing object: only if nobody wrote since we read it; new object: only if nobody created it meanwhile
    const onlyIf = obj ? { etagMatches: obj.etag } : new Headers({ "If-None-Match": "*" });
    const stored = await bucket.put(key, JSON.stringify(next), { onlyIf, httpMetadata: { contentType: "application/json" } });
    if (stored !== null) return next;
    // lost the race — loop re-reads the newer object and re-applies `mutate` on top of it
  }
  throw new CasExhausted(key, tries);
}
