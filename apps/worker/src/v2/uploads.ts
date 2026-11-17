// A sitting's video, sent in parts (CLAUDE.md: «Every upload is chunked and resumable. Not an optimisation.»).
// The shelf model first shipped with ONE request per sitting: on a weak line it broke near the end and started
// again from the first byte (review 2026-11-15, item 4). Same design as the old household API (sync.ts
// /api/upload), on R2's multipart upload:
//   POST /readings/:id/clips/:n/start {size, type, marks?} → {partSize, done:[k…]}  (or {have:true}: already whole)
//   PUT  /readings/:id/clips/:n/parts/:k   body = part k (1-based); every part but the last is exactly partSize
//   POST /readings/:id/clips/:n/complete → the parts become clip n of the reading
// What has arrived is remembered in up/<reading>/<n>.json, so a phone that lost the line — or was closed — asks
// again and sends only what is missing. R2 itself drops an unfinished upload after 7 days; deleting the reading
// drops it at once (ops.ts deleteReading → dropUploads).
import { updateJson } from "../cas.js";
import { parseMarks, type PageMark } from "../marks.js";
import type { Store } from "./store.js";
import type { Phone, Reading } from "./types.js";
import { charge, checkBytes } from "./quota.js";
import { fail, json, readBody, safeVideoType } from "./util.js";

export const UPLOAD_PART = 5 * 1024 * 1024; // R2's smallest part; every part but the last must be this size
/** half an hour of phone video at our bitrate — parts lift the one-request ceiling a single PUT had */
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

interface UploadState {
  uploadId: string;
  size: number;
  type: string;
  marks?: PageMark[];
  parts: Array<{ n: number; etag: string }>;
}
const stateKey = (readingId: string, n: number) => `up/${readingId}/${n}.json`;
const clipKey = (readingId: string, n: number) => `v/${readingId}/${n}`;

async function readState(bucket: R2Bucket, key: string): Promise<UploadState | null> {
  const o = await bucket.get(key);
  if (!o) return null;
  try { return (await o.json()) as UploadState; } catch { return null; }
}

/** `step` = "start" | "parts" | "complete" (the path after /clips/:n). */
export async function clipUpload(req: Request, store: Store, me: Phone, r: Reading, n: number, maxClips: number, step: string, partNo: string | undefined): Promise<Response> {
  if (r.author !== me.id) return fail(403, "not yours");
  const bucket = store.bucket;
  const key = stateKey(r.id, n);

  if (step === "start" && req.method === "POST") {
    if (n > r.clips.length || n >= maxClips) return fail(409, "clips must be uploaded in order");
    const body = await readBody(req);
    const size = Number(body.size);
    if (!Number.isInteger(size) || size <= 0) return fail(400, "bad size");
    if (size > MAX_UPLOAD_BYTES) return fail(413, "too large");
    const cur = await readState(bucket, key);
    // a NEW upload must fit this phone's limits (v2/quota.ts); one already under way, or already whole, goes on
    if (!(cur && cur.size === size) && !(!cur && r.clips[n] && r.clips[n]!.size === size)) {
      checkBytes(me, size, r.clips[n]?.key.startsWith("v/") ? r.clips[n]!.size || 0 : 0);
    }
    // this very sitting is already here, whole (the reply to «complete» never reached the phone): nothing to send
    if (!cur && r.clips[n] && r.clips[n]!.size === size) return json({ ok: true, partSize: UPLOAD_PART, done: [], have: true });
    if (cur && cur.size === size) return json({ ok: true, partSize: UPLOAD_PART, done: cur.parts.map((x) => x.n).sort((a, b) => a - b) });
    if (cur) { try { await bucket.resumeMultipartUpload(clipKey(r.id, n), cur.uploadId).abort(); } catch { /* gone */ } }
    const type = safeVideoType(typeof body.type === "string" ? body.type : null);
    const marks = parseMarks(body.marks ? JSON.stringify(body.marks) : null) ?? undefined;
    const mp = await bucket.createMultipartUpload(clipKey(r.id, n), { httpMetadata: { contentType: type } });
    const state: UploadState = { uploadId: mp.uploadId, size, type, ...(marks ? { marks } : {}), parts: [] };
    await bucket.put(key, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, partSize: UPLOAD_PART, done: [] });
  }

  if (step === "parts" && req.method === "PUT") {
    if (!partNo || !/^[0-9]{1,4}$/.test(partNo)) return fail(400, "bad part");
    const k = Number(partNo);
    const st = await readState(bucket, key);
    if (!st) return fail(404, "no upload");
    const count = Math.ceil(st.size / UPLOAD_PART);
    if (k < 1 || k > count) return fail(400, "bad part");
    const bytes = await req.arrayBuffer();
    const want = k < count ? UPLOAD_PART : st.size - UPLOAD_PART * (count - 1);
    if (bytes.byteLength !== want) return json({ error: "bad part size", want }, 400);
    const got = await bucket.resumeMultipartUpload(clipKey(r.id, n), st.uploadId).uploadPart(k, bytes);
    await updateJson<UploadState>(bucket, key, st, (d) => ({ ...d, parts: [...(d.parts ?? []).filter((x) => x.n !== k), { n: k, etag: got.etag }] }));
    return json({ ok: true });
  }

  if (step === "complete" && req.method === "POST") {
    const st = await readState(bucket, key);
    if (!st) {
      // asked twice (the first answer was lost on the way): the clip is already part of the reading
      if (r.clips[n]) return json({ ok: true, clips: r.clips.length });
      return fail(404, "no upload");
    }
    const count = Math.ceil(st.size / UPLOAD_PART);
    const have = new Set(st.parts.map((x) => x.n));
    const missing = Array.from({ length: count }, (_, i) => i + 1).filter((k) => !have.has(k));
    if (missing.length) return json({ error: "parts missing", missing }, 409);
    await bucket.resumeMultipartUpload(clipKey(r.id, n), st.uploadId).complete(
      [...st.parts].sort((a, b) => a.n - b.n).map((x) => ({ partNumber: x.n, etag: x.etag })),
    );
    const clip = { key: clipKey(r.id, n), type: st.type, size: st.size, ...(st.marks ? { marks: st.marks } : {}), at: Date.now() };
    const replaced = r.clips[n]?.key.startsWith("v/") ? r.clips[n]!.size || 0 : 0;
    const next = await store.changeReading(r.id, (cur) => {
      const clips = [...cur.clips];
      if (n > clips.length) return null; // raced past us; the phone sends its sittings in order
      clips[n] = clip;
      return { ...cur, clips };
    });
    await bucket.delete(key);
    if (!next) {
      await bucket.delete(clipKey(r.id, n)); // the reading was deleted while uploading
      return fail(404, "no reading");
    }
    await charge(store, me.id, { bytes: st.size, freed: replaced });
    return json({ ok: true, clips: next.clips.length });
  }
  return fail(404, "not found");
}

/** Deleting a reading deletes what was still on its way up (real deletion: no part waits a week for R2 to expire it). */
export async function dropUploads(bucket: R2Bucket, readingId: string): Promise<void> {
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const l = await bucket.list({ prefix: `up/${readingId}/`, cursor });
    for (const o of l.objects) {
      const st = await readState(bucket, o.key);
      const n = o.key.slice(`up/${readingId}/`.length).replace(/\.json$/, "");
      if (st?.uploadId) { try { await bucket.resumeMultipartUpload(`v/${readingId}/${n}`, st.uploadId).abort(); } catch { /* gone */ } }
      await bucket.delete(o.key);
    }
    if (!l.truncated) break;
    cursor = l.cursor;
  }
}
