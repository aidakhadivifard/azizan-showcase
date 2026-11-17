import { describe, it, expect } from "vitest";
import { updateJson, CasExhausted, type CasBucket } from "./cas.js";

/** An in-memory R2 stand-in with real conditional-put semantics (etag per version, If-None-Match: *). */
function fakeBucket(initial: Record<string, string> = {}) {
  const store = new Map<string, { body: string; etag: string }>();
  let version = 0;
  for (const [k, v] of Object.entries(initial)) store.set(k, { body: v, etag: `e${++version}` });
  const bucket: CasBucket & { puts: number } = {
    puts: 0,
    async get(key) {
      const o = store.get(key);
      return o ? { etag: o.etag, json: async () => JSON.parse(o.body) } : null;
    },
    async put(key, value, options) {
      bucket.puts++;
      const cur = store.get(key);
      const cond = options?.onlyIf;
      if (cond instanceof Headers) {
        if (cond.get("If-None-Match") === "*" && cur) return null; // exists → create fails
      } else if (cond?.etagMatches !== undefined) {
        if (!cur || cur.etag !== cond.etagMatches) return null; // changed underneath → fails
      }
      store.set(key, { body: value, etag: `e${++version}` });
      return {};
    },
  };
  return { bucket, store };
}

describe("updateJson — nothing written by two requests at once is lost (review P1-04)", () => {
  it("creates the object when it does not exist yet", async () => {
    const { bucket, store } = fakeBucket();
    const out = await updateJson(bucket, "k", { n: 0 }, (c) => ({ n: c.n + 1 }));
    expect(out).toEqual({ n: 1 });
    expect(JSON.parse(store.get("k")!.body)).toEqual({ n: 1 });
  });

  it("applies the change on top of the stored value", async () => {
    const { bucket } = fakeBucket({ k: JSON.stringify({ list: ["a"] }) });
    const out = await updateJson(bucket, "k", { list: [] as string[] }, (c) => ({ list: [...c.list, "b"] }));
    expect(out.list).toEqual(["a", "b"]);
  });

  it("when another writer sneaks in between read and write, it re-reads and keeps BOTH changes", async () => {
    const { bucket, store } = fakeBucket({ k: JSON.stringify({ list: ["a"] }) });
    let sneaked = false;
    const out = await updateJson(bucket, "k", { list: [] as string[] }, (c) => {
      if (!sneaked) {
        // simulate a concurrent request landing right after our read: the stored version moves on
        sneaked = true;
        store.set("k", { body: JSON.stringify({ list: [...c.list, "other"] }), etag: "sneaky" });
      }
      return { list: [...c.list, "mine"] };
    });
    // the first attempt's put fails (etag moved), the second re-reads ["a","other"] and appends "mine"
    expect(out.list).toEqual(["a", "other", "mine"]);
    expect(bucket.puts).toBe(2);
  });

  it("the create-if-absent write fails when someone created the object first, then retries on top of theirs", async () => {
    const { bucket, store } = fakeBucket();
    let sneaked = false;
    const out = await updateJson(bucket, "k", { ids: [] as string[] }, (c) => {
      if (!sneaked) { sneaked = true; store.set("k", { body: JSON.stringify({ ids: ["x"] }), etag: "first" }); }
      return { ids: [...c.ids, "y"] };
    });
    expect(out.ids).toEqual(["x", "y"]);
  });

  it("mutate returning null writes nothing and returns what is stored", async () => {
    const { bucket } = fakeBucket({ k: JSON.stringify({ n: 7 }) });
    const out = await updateJson(bucket, "k", { n: 0 }, () => null);
    expect(out).toEqual({ n: 7 });
    expect(bucket.puts).toBe(0);
  });

  it("an unreadable object is replaced from the fallback instead of crashing", async () => {
    const { bucket } = fakeBucket({ k: "not json{" });
    const out = await updateJson(bucket, "k", { n: 0 }, (c) => ({ n: c.n + 1 }));
    expect(out).toEqual({ n: 1 });
  });

  it("gives up with a clear error if the object never stops changing", async () => {
    const { bucket, store } = fakeBucket({ k: JSON.stringify({ n: 0 }) });
    let v = 0;
    await expect(
      updateJson(bucket, "k", { n: 0 }, (c) => { store.set("k", { body: JSON.stringify(c), etag: `moving${++v}` }); return { n: c.n + 1 }; }, 3),
    ).rejects.toBeInstanceOf(CasExhausted);
  });
});
