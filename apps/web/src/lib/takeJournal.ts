// The take journal: a reading being recorded is written to this phone slice by slice (MediaRecorder hands one
// every second), so a take survives Android killing the app mid-story. Before, the whole take lived only in
// memory until «تمام شد» — a killed app lost a grandparent's reading with no message (review 2026-11-04).
//
// One take at a time. `begin` starts a fresh one (dropping any older one), `chunk` adds a slice, `progress`
// keeps the page marks current, `end` forgets the take once it is safely saved the normal way. On the next
// start `recover` rebuilds an unfinished take and the app saves + uploads it like any other recording.
//
// Recording must never break because of this: every write is queued in the background, every failure is
// swallowed. A phone where IndexedDB is blocked simply records the way it did before.

import type { PageMark } from "./pageMarks.js";
import type { RecordingDraft } from "../domain/appFlow.js";

export interface TakeMeta {
  takeId: string;
  slug: string;
  /** the children it is read for (state.recording.forChildIds) */
  childIds: string[];
  /** the reader's name as the family knows it (meLabel) */
  reader: string;
  household: string | null;
  mimeType: string;
  /** when the take started (epoch ms) */
  startedAt: number;
  /** which page was on screen at which second, so far */
  marks: PageMark[];
  /** the 0-based page on screen at the last update */
  page: number;
}

/** Where a take's slices are kept (IndexedDB on the phone; an in-memory double in tests). */
export interface TakeStore {
  putMeta(m: TakeMeta): Promise<void>;
  getMeta(): Promise<TakeMeta | null>;
  putChunk(takeId: string, index: number, blob: Blob): Promise<void>;
  /** the take's slices, in order */
  getChunks(takeId: string): Promise<Blob[]>;
  /** forget everything */
  clear(): Promise<void>;
}

export interface TakeJournal {
  begin(meta: Omit<TakeMeta, "marks" | "page">): void;
  chunk(blob: Blob): void;
  progress(marks: PageMark[], page: number): void;
  /** forget the take (it was saved). With an id: only if that is still the take on record. */
  end(takeId?: string): Promise<void>;
  /** an unfinished take from an earlier run, rebuilt; null when there is none (or it can't be read) */
  recover(): Promise<{ meta: TakeMeta; blob: Blob } | null>;
  /** wait for the queued writes */
  flush(): Promise<void>;
}

export function createTakeJournal(store: TakeStore): TakeJournal {
  let chain: Promise<unknown> = Promise.resolve();
  let current: TakeMeta | null = null;
  let index = 0;
  // one write after another, in order; a failed write never stops the next one
  const run = <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
    const p = chain.then(f).catch(() => fallback);
    chain = p;
    return p;
  };
  return {
    begin(m) {
      const meta: TakeMeta = { ...m, marks: [], page: 0 };
      current = meta;
      index = 0;
      void run(async () => { await store.clear(); await store.putMeta(meta); }, undefined);
    },
    chunk(blob) {
      const m = current;
      if (!m || !blob || blob.size === 0) return;
      const i = index++;
      void run(() => store.putChunk(m.takeId, i, blob), undefined);
    },
    progress(marks, page) {
      const m = current;
      if (!m) return;
      const next: TakeMeta = { ...m, marks: marks.map((x) => ({ ...x })), page };
      current = next;
      void run(() => store.putMeta(next), undefined);
    },
    end(takeId) {
      if (!takeId || current?.takeId === takeId) current = null;
      return run(async () => {
        if (takeId) {
          const m = await store.getMeta();
          if (m && m.takeId !== takeId) return;
        }
        await store.clear();
      }, undefined);
    },
    recover() {
      return run(async () => {
        const meta = await store.getMeta();
        if (!meta) return null;
        const chunks = await store.getChunks(meta.takeId);
        if (!chunks.length) { if (current?.takeId !== meta.takeId) await store.clear(); return null; }
        return { meta, blob: new Blob(chunks, { type: meta.mimeType }) };
      }, null);
    },
    flush() {
      return run(async () => undefined, undefined);
    },
  };
}

/** The in-memory double (tests). Behaves like the IndexedDB store, survives a "restart" (a second journal). */
export function memoryTakeStore(): TakeStore {
  let meta: TakeMeta | null = null;
  const chunks = new Map<string, Blob>();
  const key = (id: string, i: number) => `${id}:${String(i).padStart(6, "0")}`;
  return {
    putMeta: async (m) => { meta = { ...m }; },
    getMeta: async () => (meta ? { ...meta } : null),
    putChunk: async (id, i, b) => { chunks.set(key(id, i), b); },
    getChunks: async (id) => [...chunks.keys()].filter((k) => k.startsWith(`${id}:`)).sort().map((k) => chunks.get(k)!),
    clear: async () => { meta = null; chunks.clear(); },
  };
}

// ---- IndexedDB (its own small database, so the videos database never needs a version change) ----
export const TAKE_DB = "azizan-take";
const META = "meta";
const CHUNKS = "chunks";

export function idbTakeStore(): TakeStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (!dbp) {
      dbp = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(TAKE_DB, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
          if (!d.objectStoreNames.contains(CHUNKS)) d.createObjectStore(CHUNKS);
        };
        req.onsuccess = () => {
          const d = req.result;
          // the database is being deleted (account deletion): let it go, open again next time
          d.onversionchange = () => { d.close(); dbp = null; };
          resolve(d);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("blocked"));
      });
      dbp.catch(() => { dbp = null; });
    }
    return dbp;
  };
  const tx = <T>(stores: string[], mode: IDBTransactionMode, work: (t: IDBTransaction) => IDBRequest | void): Promise<T> =>
    db().then((d) => new Promise<T>((resolve, reject) => {
      const t = d.transaction(stores, mode);
      const req = work(t);
      t.oncomplete = () => resolve((req ? req.result : undefined) as T);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  const key = (id: string, i: number) => `${id}:${String(i).padStart(6, "0")}`;
  return {
    putMeta: (m) => tx<void>([META], "readwrite", (t) => { t.objectStore(META).put(m, "take"); }),
    getMeta: async () => (await tx<TakeMeta | undefined>([META], "readonly", (t) => t.objectStore(META).get("take"))) ?? null,
    putChunk: (id, i, b) => tx<void>([CHUNKS], "readwrite", (t) => { t.objectStore(CHUNKS).put(b, key(id, i)); }),
    getChunks: async (id) =>
      (await tx<Blob[]>([CHUNKS], "readonly", (t) => t.objectStore(CHUNKS).getAll(IDBKeyRange.bound(`${id}:`, `${id}:￿`)))) ?? [],
    clear: () => tx<void>([META, CHUNKS], "readwrite", (t) => { t.objectStore(META).clear(); t.objectStore(CHUNKS).clear(); }),
  };
}

/** The app's one journal (IndexedDB). Created lazily so a phone without IndexedDB only loses the safety net. */
let shared: TakeJournal | null = null;
export function takeJournal(): TakeJournal {
  if (!shared) {
    const ok = typeof indexedDB !== "undefined";
    shared = createTakeJournal(ok ? idbTakeStore() : memoryTakeStore());
  }
  return shared;
}

export interface RescueDeps {
  /** the open recording draft (state.recording), if any */
  draft: RecordingDraft | null;
  /** the children on this phone */
  childIds: string[];
  /** save to the phone's video store (videoStore.putVideo); true = it is on disk */
  saveLocal(videoId: string, blob: Blob): Promise<boolean>;
  saveMarks(videoId: string, marks: PageMark[]): void;
  /** the resilient cloud upload (uploadQueue.uploadOrQueue); true = it reached the cloud on this try */
  upload(item: { videoId: string; childId: string; slug: string; reader: string }, blob: Blob): Promise<boolean>;
  /** SAVE_CLIP: keep it as a sitting of the open draft */
  keepAsSitting(videoId: string, resumePage: number): void;
  /** MERGE_SHELF: put it on these children's shelves */
  putOnShelf(recordings: Array<{ id: string; childId: string; slug: string; reader: string }>): void;
  /** one plain line to the reader */
  tell(msg: string): void;
}

/** On start: an unfinished take from an earlier run is saved and uploaded the way a normal one is — kept on the
 *  phone first (then the upload rides the queue in the background), or, when the phone can't keep it, only once
 *  the cloud has it. Only then is it claimed and the journal forgotten. True = a take was rescued. Never throws. */
export async function rescueTake(journal: TakeJournal, d: RescueDeps): Promise<boolean> {
  // one rescue at a time (React runs a start-up effect twice in development; two would save the take twice)
  if (rescuing.has(journal)) return false;
  rescuing.add(journal);
  try {
    const got = await journal.recover();
    if (!got) return false;
    const { meta, blob } = got;
    const videoId = meta.takeId; // the same id every try, so a retry never doubles it (the upload queue is keyed by it)
    const plan = recoveryPlan(meta, d.draft, d.childIds);
    const childId = plan.kind === "clip" ? (d.draft?.forChildIds[0] ?? meta.childIds[0] ?? null) : plan.uploadChildId;
    const item = childId ? { videoId, childId, slug: meta.slug, reader: meta.reader } : null;
    d.saveMarks(videoId, meta.marks);
    const saved = await d.saveLocal(videoId, blob).catch(() => false);
    const uploaded = saved ? false : item ? await d.upload(item, blob).catch(() => false) : false;
    if (!saved && !uploaded) return false; // no safe copy anywhere: keep the journal, try again next start
    if (plan.kind === "clip") d.keepAsSitting(videoId, plan.resumePage);
    else d.putOnShelf(plan.childIds.map((c) => ({ id: videoId, childId: c, slug: meta.slug, reader: meta.reader })));
    await journal.end(meta.takeId);
    d.tell(RECOVERED_MSG);
    if (saved && item) void d.upload(item, blob).catch(() => false);
    return true;
  } catch {
    return false;
  } finally {
    rescuing.delete(journal);
  }
}
const rescuing = new WeakSet<TakeJournal>();

// ---- where a rescued take goes (pure) ----
export const RECOVERED_MSG = "قصه‌ای که نیمه‌کاره موند رو نگه داشتیم.";

export type RecoveryPlan =
  /** the same story is still the open draft: keep it as a sitting, «ادامه بده» continues from resumePage (0-based) */
  | { kind: "clip"; resumePage: number }
  /** no draft for it: it goes on the shelf of these children (those still on this phone), uploaded for uploadChildId */
  | { kind: "reading"; childIds: string[]; uploadChildId: string | null };

export function recoveryPlan(meta: TakeMeta, draft: RecordingDraft | null, knownChildIds: string[]): RecoveryPlan {
  // exactly what leaving the screen mid-recording does (Record.leave → SAVE_CLIP): resume on the NEXT page
  if (draft && draft.storySlug === meta.slug) return { kind: "clip", resumePage: meta.page + 1 };
  const known = new Set(knownChildIds);
  const onPhone = meta.childIds.filter((c) => known.has(c));
  // A recovered reading must never be saved-but-hidden. For a grandparent reading for a grandchild the child is a
  // known «reader» entry, so it lands on that child's shelf as usual. If NONE of the read-for children are on this
  // phone any more, fall back to the children it WAS read for (meta.childIds), so the plan still names a shelf
  // rather than an empty one (owner, 2026-11-09). A truly-removed child is still dropped by MERGE_SHELF's own guard.
  const childIds = onPhone.length ? onPhone : meta.childIds;
  return { kind: "reading", childIds, uploadChildId: childIds[0] ?? null };
}
