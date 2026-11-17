import { describe, expect, it } from "vitest";
import { createTakeJournal, memoryTakeStore, recoveryPlan, rescueTake, RECOVERED_MSG, type RescueDeps, type TakeStore } from "./takeJournal.js";

const meta = (takeId = "t1") => ({ takeId, slug: "nokhodi", childIds: ["child_1"], reader: "مامان‌بزرگ", household: "h1", mimeType: "video/webm", startedAt: 1000 });
// jsdom's Blob has no .text()
const text = (b: Blob) => new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsText(b); });

// A take used to live only in memory until «تمام شد»; if Android killed the app mid-story it was gone. Now every
// 1-second slice is written as it arrives, and the next start rebuilds the take from them.
describe("take journal — every slice of a reading is kept as it arrives", () => {
  it("rebuilds the whole take, slices in order, with its page marks and type", async () => {
    const j = createTakeJournal(memoryTakeStore());
    j.begin(meta());
    j.chunk(new Blob(["a"]));
    j.chunk(new Blob(["b"]));
    j.progress([{ t: 0, page: 0 }, { t: 4.2, page: 1 }], 1);
    j.chunk(new Blob(["c"]));
    const got = await j.recover();
    expect(got).not.toBeNull();
    expect(await text(got!.blob)).toBe("abc");
    expect(got!.blob.type).toBe("video/webm");
    expect(got!.meta).toMatchObject({ takeId: "t1", slug: "nokhodi", childIds: ["child_1"], reader: "مامان‌بزرگ", household: "h1", startedAt: 1000, page: 1 });
    expect(got!.meta.marks).toEqual([{ t: 0, page: 0 }, { t: 4.2, page: 1 }]);
  });

  it("a take saved the normal way is forgotten (nothing to recover)", async () => {
    const j = createTakeJournal(memoryTakeStore());
    j.begin(meta());
    j.chunk(new Blob(["a"]));
    await j.end();
    expect(await j.recover()).toBeNull();
  });

  it("a slice that arrives after the end does not bring the take back", async () => {
    const j = createTakeJournal(memoryTakeStore());
    j.begin(meta());
    j.chunk(new Blob(["a"]));
    void j.end();
    j.chunk(new Blob(["late"]));
    expect(await j.recover()).toBeNull();
  });

  it("a new take replaces the old one; ending an OLD take id never clears the new take", async () => {
    const j = createTakeJournal(memoryTakeStore());
    j.begin(meta("old"));
    j.chunk(new Blob(["x"]));
    j.begin(meta("new"));
    j.chunk(new Blob(["y"]));
    await j.end("old");
    const got = await j.recover();
    expect(got?.meta.takeId).toBe("new");
    expect(await text(got!.blob)).toBe("y");
  });

  it("empty slices and slices before any take are ignored; a take with no slices is dropped", async () => {
    const store = memoryTakeStore();
    const j = createTakeJournal(store);
    j.chunk(new Blob(["stray"]));
    j.begin(meta());
    j.chunk(new Blob([]));
    expect(await j.recover()).toBeNull();
    expect(await store.getMeta()).not.toBeNull(); // the take being recorded right now is left alone
    const after = createTakeJournal(store); // next start
    expect(await after.recover()).toBeNull();
    expect(await store.getMeta()).toBeNull(); // an empty take from an earlier run is cleared, not offered every start
  });

  it("survives a restart: a second journal on the same store finds the take", async () => {
    const store = memoryTakeStore();
    const a = createTakeJournal(store);
    a.begin(meta());
    a.chunk(new Blob(["a"]));
    a.chunk(new Blob(["b"]));
    await a.flush();
    const b = createTakeJournal(store); // the app was killed and opened again
    expect(await text((await b.recover())!.blob)).toBe("ab");
  });

  it("a broken store (IndexedDB blocked, disk full) never throws into the recording", async () => {
    const boom = () => Promise.reject(new Error("idb"));
    const bad: TakeStore = { putMeta: boom, getMeta: boom, putChunk: boom, getChunks: boom, clear: boom };
    const j = createTakeJournal(bad);
    expect(() => { j.begin(meta()); j.chunk(new Blob(["a"])); j.progress([], 0); }).not.toThrow();
    await expect(j.end()).resolves.toBeUndefined();
    await expect(j.recover()).resolves.toBeNull();
  });
});

describe("rescueTake — on the next start the unfinished take is saved and uploaded like any other", () => {
  const draft = { storySlug: "nokhodi", forChildIds: ["child_1"], page: 1, totalPages: 8, recordedPages: [] };
  async function killedMidStory() {
    const store = memoryTakeStore();
    const j = createTakeJournal(store);
    j.begin(meta("take-9"));
    j.chunk(new Blob(["ab"]));
    j.progress([{ t: 0, page: 0 }, { t: 5, page: 1 }], 1);
    await j.flush();
    return { store, next: createTakeJournal(store) }; // the app was killed; this is the next start
  }
  function deps(over: Partial<RescueDeps> = {}) {
    const calls: string[] = [];
    const d: RescueDeps = {
      draft,
      childIds: ["child_1"],
      saveLocal: async (id) => { calls.push(`local ${id}`); return true; },
      saveMarks: (id, m) => { calls.push(`marks ${id} ${m.length}`); },
      upload: async (item) => { calls.push(`upload ${item.videoId} ${item.childId} ${item.slug} ${item.reader}`); return true; },
      keepAsSitting: (id, page) => { calls.push(`clip ${id} ${page}`); },
      putOnShelf: (rs) => { calls.push(`shelf ${rs.map((r) => r.childId).join(",")}`); },
      tell: (m) => { calls.push(`tell ${m}`); },
      ...over,
    };
    return { d, calls };
  }

  it("the same story is the open draft: kept as a sitting (like leaving mid-reading), uploaded, the reader told", async () => {
    const { next } = await killedMidStory();
    const { d, calls } = deps();
    expect(await rescueTake(next, d)).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // the background upload
    expect(calls).toEqual(["marks take-9 2", "local take-9", "clip take-9 2", `tell ${RECOVERED_MSG}`, "upload take-9 child_1 nokhodi مامان‌بزرگ"]);
    expect(await next.recover()).toBeNull(); // forgotten once safe
  });

  it("no draft for it: it goes on the shelf", async () => {
    const { next } = await killedMidStory();
    const { d, calls } = deps({ draft: null });
    await rescueTake(next, d);
    expect(calls).toContain("shelf child_1");
  });

  it("a grandparent reading for a grandchild recovers onto the grandchild's shelf (owner, 2026-11-09)", async () => {
    // the take was read for «hana»; no open draft; hana is a reader child on this phone → it must reach her shelf
    const store = memoryTakeStore();
    const j = createTakeJournal(store);
    j.begin({ ...meta("take-h"), childIds: ["hana"] });
    j.chunk(new Blob(["ab"]));
    await j.flush();
    const { d, calls } = deps({ draft: null, childIds: ["hana", "self"] });
    expect(await rescueTake(createTakeJournal(store), d)).toBe(true);
    expect(calls).toContain("shelf hana");
    expect(calls).toContain(`tell ${RECOVERED_MSG}`);
  });

  it("the phone could not save it: the cloud is the only copy, so it waits for that upload", async () => {
    const { next } = await killedMidStory();
    const { d, calls } = deps({ saveLocal: async () => false });
    expect(await rescueTake(next, d)).toBe(true);
    expect(calls.indexOf("upload take-9 child_1 nokhodi مامان‌بزرگ")).toBeLessThan(calls.indexOf("clip take-9 2"));
  });

  it("neither the phone nor the cloud took it: nothing is claimed, the take stays for the next start", async () => {
    const { next } = await killedMidStory();
    const { d, calls } = deps({ saveLocal: async () => false, upload: async () => false });
    expect(await rescueTake(next, d)).toBe(false);
    expect(calls.some((c) => c.startsWith("clip") || c.startsWith("tell"))).toBe(false);
    expect(await next.recover()).not.toBeNull();
  });

  it("two rescues at once (a start-up effect run twice) save it only once", async () => {
    const { next } = await killedMidStory();
    const { d, calls } = deps();
    const [a, b] = await Promise.all([rescueTake(next, d), rescueTake(next, d)]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(calls.filter((c) => c.startsWith("local")).length).toBe(1);
  });

  it("nothing unfinished: nothing happens", async () => {
    const { d, calls } = deps();
    expect(await rescueTake(createTakeJournal(memoryTakeStore()), d)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("recoveryPlan — where a rescued take goes", () => {
  const m = { ...meta(), marks: [{ t: 0, page: 0 }, { t: 9, page: 2 }], page: 2 };

  it("the same story is still the draft: kept as a sitting, «ادامه بده» goes on from the next page", () => {
    const draft = { storySlug: "nokhodi", forChildIds: ["child_1"], page: 1, totalPages: 8, recordedPages: [] };
    expect(recoveryPlan(m, draft, ["child_1"])).toEqual({ kind: "clip", resumePage: 3 });
  });

  it("no draft for it: it goes on the shelf of the children it was read for (the ones still on this phone)", () => {
    expect(recoveryPlan({ ...m, childIds: ["child_1", "gone"] }, null, ["child_1"])).toEqual({ kind: "reading", childIds: ["child_1"], uploadChildId: "child_1" });
    const other = { storySlug: "other", forChildIds: ["child_1"], page: 1, totalPages: 8, recordedPages: [] };
    expect(recoveryPlan(m, other, ["child_1"]).kind).toBe("reading");
  });

  it("a grandparent reading for a grandchild: the grandchild is a known «reader» child, so it lands on their shelf", () => {
    // A grandparent reads نخودی for a grandchild who lives on another phone. A crash mid-reading recovers onto that child's shelf.
    expect(recoveryPlan({ ...m, childIds: ["hana"] }, null, ["hana", "self"])).toEqual({ kind: "reading", childIds: ["hana"], uploadChildId: "hana" });
  });

  it("none of the read-for children are on this phone any more: it still names their shelf, never an empty one", () => {
    // the plan falls back to the children it was read for, so a recovered reading is never saved-but-hidden
    expect(recoveryPlan(m, null, [])).toEqual({ kind: "reading", childIds: ["child_1"], uploadChildId: "child_1" });
  });

  it("tells the reader in one plain line", () => {
    expect(RECOVERED_MSG).toBe("قصه‌ای که نیمه‌کاره موند رو نگه داشتیم.");
    expect(RECOVERED_MSG).not.toMatch(/!/);
  });
});
