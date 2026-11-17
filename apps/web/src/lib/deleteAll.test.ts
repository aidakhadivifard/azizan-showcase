import { describe, it, expect, vi } from "vitest";
import { deleteAllEverywhere, deleteMyAccount } from "./deleteAll.js";

// Review 2026-11-15, item 7: «حذفِ همه‌چیز» wiped the phone even when the server had NOT deleted. deleteHousehold
// answers "ok" | "forbidden" | "failed" — all truthy strings — so `if (!(await deleteHousehold()))` never stopped
// anything. And the stories on the new طاقچه (v2) were never deleted at all. Once the phone is wiped, its keys are
// gone, and nobody can delete those videos any more. Rule: the phone is wiped ONLY after BOTH servers said yes.
const steps = (over: Partial<Parameters<typeof deleteAllEverywhere>[0]> = {}) => ({
  deleteShelfModel: vi.fn(async () => true),
  deleteOldFamily: vi.fn(async () => "ok" as const),
  wipePhone: vi.fn(async () => {}),
  ...over,
});

describe("deleteAllEverywhere", () => {
  it("both servers say yes → the phone is wiped, and it reports ok", async () => {
    const s = steps();
    expect(await deleteAllEverywhere(s)).toBe(true);
    expect(s.deleteShelfModel).toHaveBeenCalled();
    expect(s.deleteOldFamily).toHaveBeenCalled();
    expect(s.wipePhone).toHaveBeenCalled();
  });

  it.each(["failed", "forbidden"] as const)("old family storage answers %s → the phone is NOT wiped (it can be tried again)", async (answer) => {
    const s = steps({ deleteOldFamily: vi.fn(async () => answer) });
    expect(await deleteAllEverywhere(s)).toBe(false);
    expect(s.wipePhone).not.toHaveBeenCalled();
  });

  it("the new طاقچه could not be deleted → the phone is NOT wiped, and the old family is not touched yet", async () => {
    const s = steps({ deleteShelfModel: vi.fn(async () => false) });
    expect(await deleteAllEverywhere(s)).toBe(false);
    expect(s.deleteOldFamily).not.toHaveBeenCalled();
    expect(s.wipePhone).not.toHaveBeenCalled();
  });

  it("the copy kept for «وصلِ ایمیل» goes too — after the videos; if it cannot, the phone is not wiped", async () => {
    const order: string[] = [];
    const s = steps({
      deleteShelfModel: vi.fn(async () => { order.push("v2"); return true; }),
      deleteOldFamily: vi.fn(async () => { order.push("old"); return "ok" as const; }),
      forgetRecovery: vi.fn(async () => { order.push("email"); return false; }),
    });
    expect(await deleteAllEverywhere(s)).toBe(false);
    expect(order).toEqual(["v2", "old", "email"]);
    expect(s.wipePhone).not.toHaveBeenCalled();
  });

  it("a step that throws (offline) is a no, never a wipe", async () => {
    const s = steps({ deleteOldFamily: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    expect(await deleteAllEverywhere(s)).toBe(false);
    expect(s.wipePhone).not.toHaveBeenCalled();
  });
});

// Owner, 2026-11-16: «فقط چیزهای خودش پاک شه». Someone who is not the family's first سرپرست — the هم‌خانه, an
// invited reader, someone with no child — deletes their ACCOUNT. Before, the هم‌خانه's «حذفِ همه‌چیز» deleted his
// readings on the طاقچه, was then refused by the old family storage, said «چیزی پاک نشد» and never emptied the
// phone — every time; and a reader had no button at all (the stores require one).
describe("deleteMyAccount — only what is mine, then the phone", () => {
  const mine = (over: Partial<Parameters<typeof deleteMyAccount>[0]> = {}) => ({
    deleteMyShelfModel: vi.fn(async () => true),
    deleteMyOldRecordings: vi.fn(async () => true),
    wipePhone: vi.fn(async () => {}),
    ...over,
  });

  it("deletes my part on both servers, then empties the phone — and never asks to delete the family", async () => {
    const st = mine({ forgetRecovery: vi.fn(async () => true) });
    expect(await deleteMyAccount(st)).toBe(true);
    expect(st.deleteMyShelfModel).toHaveBeenCalledOnce();
    expect(st.deleteMyOldRecordings).toHaveBeenCalledOnce();
    expect(st.forgetRecovery).toHaveBeenCalledOnce();
    expect(st.wipePhone).toHaveBeenCalledOnce();
  });

  it("the phone is NOT emptied when a server did not confirm (its keys are what can still delete)", async () => {
    for (const over of [{ deleteMyShelfModel: vi.fn(async () => false) }, { deleteMyOldRecordings: vi.fn(async () => false) }, { deleteMyShelfModel: vi.fn(async () => { throw new Error("offline"); }) }]) {
      const st = mine(over);
      expect(await deleteMyAccount(st)).toBe(false);
      expect(st.wipePhone).not.toHaveBeenCalled();
    }
  });
});
