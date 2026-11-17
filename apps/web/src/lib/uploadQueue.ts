// A persistent, idempotent upload queue (owner, 2026-11-02: nothing a reader records may ever be lost). A
// recording is saved to this phone first (videoStore); its cloud upload goes through here, which retries with
// backoff — in the same session, when the connection comes back (`online`), on a timer, AND across app restarts
// (the queue lives in localStorage). The video bytes stay in IndexedDB; the queue holds only the small metadata,
// so even a force-quit mid-upload recovers on the next open. An item is removed only once the server confirmed it.

import { getVideoBlob } from "./videoStore.js";
import { loadMarks } from "./pageMarks.js";
import { uploadRecording, isForgotten } from "./sync.js";
import { diag } from "./diag.js";

export interface QueueItem {
  videoId: string;
  childId: string;
  slug: string;
  reader: string;
  /** a sitting of a several-sitting reading: the reading's first clip id (sent as `group`) */
  group?: string;
  attempts: number;
  nextAt: number; // earliest time to try again (ms)
}

// --- pure queue maths (unit-tested) ------------------------------------------------------------------------
/** Backoff before the next try: 5s, 15s, 1m, 5m, then 15m forever — a recording is never given up on. */
export function backoffMs(attempts: number): number {
  const steps = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000];
  return steps[Math.min(attempts, steps.length - 1)]!;
}

/** Add an item if its video isn't already queued (idempotent by videoId). */
export function addItem(q: QueueItem[], item: Omit<QueueItem, "attempts" | "nextAt">, now: number): QueueItem[] {
  if (q.some((x) => x.videoId === item.videoId)) return q;
  return [...q, { ...item, attempts: 0, nextAt: now }];
}

/** The items whose next-try time has arrived. */
export function dueItems(q: QueueItem[], now: number): QueueItem[] {
  return q.filter((x) => x.nextAt <= now);
}

export function removeItem(q: QueueItem[], videoId: string): QueueItem[] {
  return q.filter((x) => x.videoId !== videoId);
}

/** After a failed try: one more attempt counted, and the next try pushed out by the backoff. */
export function failItem(q: QueueItem[], videoId: string, now: number): QueueItem[] {
  return q.map((x) => (x.videoId === videoId ? { ...x, attempts: x.attempts + 1, nextAt: now + backoffMs(x.attempts) } : x));
}

// --- persistence -------------------------------------------------------------------------------------------
const KEY = "azizan.uploadQueue";
function load(): QueueItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as QueueItem[];
    return Array.isArray(v) ? v.filter((x) => x && typeof x.videoId === "string") : [];
  } catch {
    return [];
  }
}
function save(q: QueueItem[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(q.slice(0, 200))); } catch { /* storage off */ }
}

/** Take a recording out of the queue (it was discarded or deleted before it reached the cloud). */
export function unqueue(videoId: string): void {
  save(removeItem(load(), videoId));
}

/** How many recordings are still waiting to reach the cloud (for a future "در حال ارسال" badge). */
export function pendingUploadCount(): number {
  return load().length;
}

// --- the one worker that actually uploads ------------------------------------------------------------------
/** Try to upload one item now. `blob` lets the caller pass the just-recorded bytes directly (so the first try
 *  works even if the local save failed); the background retrier reads from IndexedDB instead. Returns true when
 *  the server confirmed it (then it's removed). A missing blob can never succeed, so it's dropped, not looped. */
// one upload per video at a time: the first try and a background drain used to send the same video at once,
// doubling a reader's mobile data (review 2026-11-04). A second caller waits for the try already running.
const inFlight = new Map<string, Promise<boolean>>();
function tryOne(item: Pick<QueueItem, "videoId" | "childId" | "slug" | "reader" | "group">, blob?: Blob): Promise<boolean> {
  const running = inFlight.get(item.videoId);
  if (running) return running;
  const p = tryOneNow(item, blob).finally(() => inFlight.delete(item.videoId));
  inFlight.set(item.videoId, p);
  return p;
}
/** A copy unreadable this many times in a row is really gone (≈ 2 hours of backoff), not a passing storage error. */
export const MAX_MISSING_TRIES = 12;
async function tryOneNow(item: Pick<QueueItem, "videoId" | "childId" | "slug" | "reader" | "group">, blob?: Blob): Promise<boolean> {
  // a take the reader threw away (or deleted) is never sent up again (review 2026-11-04)
  if (isForgotten(item.videoId)) { unqueue(item.videoId); return false; }
  const b = blob ?? (await getVideoBlob(item.videoId));
  if (!b) {
    // IndexedDB can fail for a moment (low storage, a busy WebView): retry with backoff, give up only much later
    const cur = load().find((x) => x.videoId === item.videoId);
    if (cur && cur.attempts + 1 >= MAX_MISSING_TRIES) { save(removeItem(load(), item.videoId)); diag("upq", `no-blob gave up ${item.slug}`); }
    else save(failItem(load(), item.videoId, Date.now()));
    return false;
  }
  let ok = false;
  try { ok = await uploadRecording(item.videoId, b, { childId: item.childId, slug: item.slug, reader: item.reader, ...(item.group ? { group: item.group } : {}) }, loadMarks(item.videoId)); } catch { ok = false; }
  if (ok) save(removeItem(load(), item.videoId));
  else save(failItem(load(), item.videoId, Date.now()));
  return ok;
}

let draining = false;
/** Try every item whose time has come, oldest first. Guarded against overlapping runs. */
export async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (const item of dueItems(load(), Date.now())) {
      try { await tryOne(item); } catch { save(failItem(load(), item.videoId, Date.now())); }
    }
  } finally {
    draining = false;
  }
}

/** Save a recording to the cloud, retrying forever if needed. `blob` is the just-recorded bytes, used for the
 *  first try so it works even when the local (IndexedDB) save failed. Returns true if it reached the cloud on
 *  THIS first try (so the caller can say «ارسال شد» right away); false means it's safely queued for retry. */
export async function uploadOrQueue(item: Omit<QueueItem, "attempts" | "nextAt">, blob?: Blob): Promise<boolean> {
  save(addItem(load(), item, Date.now()));
  return tryOne(item, blob);
}

/** Seed the queue with uploads this phone still owes (from the shelf diff on boot), then drain. */
export function seedQueue(items: Array<Omit<QueueItem, "attempts" | "nextAt">>): void {
  let q = load();
  const now = Date.now();
  for (const it of items) q = addItem(q, it, now);
  save(q);
}

let started = false;
/** Start the background retrier: drain now, again whenever the connection returns, and on a slow timer while
 *  anything is still waiting. Safe to call more than once. */
export function startUploadQueue(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const kick = () => void drainQueue();
  try { window.addEventListener("online", kick); } catch { /* ssr/tests */ }
  try { document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); }); } catch { /* ok */ }
  setInterval(() => { if (pendingUploadCount() > 0) kick(); }, 30_000);
  kick();
}
