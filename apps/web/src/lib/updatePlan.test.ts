import { describe, expect, it } from "vitest";
import { canApplyNow, planUpdate, statusText } from "./updatePlan.js";

// The ROOT fix (owner, 2026-10-30: «هر بار حل می‌کنی ولی ریشه‌ای نه»): every silent-update case goes
// through ONE decision, each case is named, and Settings shows it in words — nothing is silent.
const rel = { version: "1140", url: "https://x/app/web/1140.zip", minNative: 14, checksum: "c".repeat(64) };
const b = (version: string, status: string, id = "b1") => ({ id, version, status });

describe("what this phone should do about the published web build", () => {
  it("nothing published → up to date", () => expect(planUpdate({ running: "1133", native: 14, release: undefined, bundles: [] })).toEqual({ kind: "up-to-date" }));
  it("already running it → up to date", () => expect(planUpdate({ running: "1140", native: 14, release: rel, bundles: [] })).toEqual({ kind: "up-to-date" }));
  it("an older shell is told WHY, not silently skipped", () =>
    expect(planUpdate({ running: "1133", native: 13, release: rel, bundles: [] })).toEqual({ kind: "needs-app", build: 14 }));
  it("downloaded and ready → apply", () =>
    expect(planUpdate({ running: "1133", native: 14, release: rel, bundles: [b("1140", "success")] })).toEqual({ kind: "apply", id: "b1", version: "1140" }));
  it("not downloaded yet (or a broken download) → download", () => {
    expect(planUpdate({ running: "1133", native: 14, release: rel, bundles: [] })).toEqual({ kind: "download", release: rel });
    expect(planUpdate({ running: "1133", native: 14, release: rel, bundles: [b("1140", "error")] })).toEqual({ kind: "download", release: rel });
  });
  it("an older finished download is ignored, the wanted one is fetched", () =>
    expect(planUpdate({ running: "1120", native: 14, release: rel, bundles: [b("1133", "success")] })).toEqual({ kind: "download", release: rel }));
});

// Launch blocker 9 (review 2026-11-16; audit F1 + F4).
describe("a build this phone must not take", () => {
  const dated = { version: "20261116-1500", url: "https://x/app/web/20261116-1500.zip", minNative: 14, checksum: "c".repeat(64) };
  it("a build that failed to start here is never downloaded or applied again", () => {
    expect(planUpdate({ running: "20261110-0900", native: 14, release: dated, bundles: [], bad: "20261116-1500" })).toEqual({ kind: "up-to-date" });
    expect(planUpdate({ running: "20261110-0900", native: 14, release: dated, bundles: [b("20261116-1500", "success")], bad: "20261116-1500" })).toEqual({ kind: "up-to-date" });
  });
  it("…but the NEXT build is taken as usual", () => {
    expect(planUpdate({ running: "20261110-0900", native: 14, release: dated, bundles: [], bad: "20261115-0800" })).toEqual({ kind: "download", release: dated });
  });
  it("an OLDER published build never replaces a newer one that is running (a rolled-back server file)", () => {
    expect(planUpdate({ running: "20261120-1000", native: 14, release: dated, bundles: [] })).toEqual({ kind: "up-to-date" });
  });
  it("a build with an unreadable version name is still decided the old way", () => {
    expect(planUpdate({ running: "dev", native: 14, release: dated, bundles: [] })).toEqual({ kind: "download", release: dated });
  });
});

describe("applying without a restart is safe only off the camera and the player", () => {
  it.each(["home", "shelf", "people", "me", "story", "library"])("%s → now", (s) => expect(canApplyNow(s, false)).toBe(true));
  it.each(["record", "review"])("%s → wait", (s) => expect(canApplyNow(s, false)).toBe(false));
  it("a story playing → wait", () => expect(canApplyNow("home", true)).toBe(false));
});

describe("Settings says it in words", () => {
  it("each state has a plain Persian line", () => {
    // owner, 2026-11-02: «نسخهٔ برنامه … · آخرین بررسی ساعت …»
    expect(statusText({ kind: "up-to-date" }, "20261030-1218")).toBe("نسخهٔ برنامه ۲۰۲۶۱۰۳۰-۱۲۱۸");
    expect(statusText({ kind: "up-to-date", at: "۱۳:۰۰" }, "20261030-1218")).toBe("نسخهٔ برنامه ۲۰۲۶۱۰۳۰-۱۲۱۸ · آخرین بررسی ساعت ۱۳:۰۰");
    expect(statusText({ kind: "needs-app", build: 15 })).toBe("آپدیت تازه نسخه‌ی ۱٫۱۵ اپ رو می‌خواد — از بالا دریافتش کن");
    expect(statusText({ kind: "download", release: rel })).toBe("در حال گرفتنِ آپدیت ۱۱۴۰…");
    expect(statusText({ kind: "apply", id: "b1", version: "1140" })).toBe("آپدیت ۱۱۴۰ آماده‌ست");
    expect(statusText({ kind: "failed", why: "offline" })).toBe("آپدیت نرسید (offline) — دفعه‌ی بعد دوباره امتحان می‌شه");
  });
});

describe("the download shows its progress (owner, 2026-10-30: it was closed before it finished)", () => {
  it("percent in the status line", () => {
    expect(statusText({ kind: "download", release: rel, percent: 42 })).toBe("در حال گرفتنِ آپدیت ۱۱۴۰… ۴۲٪");
    expect(statusText({ kind: "download", release: rel, percent: 0 })).toBe("در حال گرفتنِ آپدیت ۱۱۴۰… ۰٪");
  });
});

import { offerApply } from "./updatePlan.js";
describe("the «نسخه‌ی تازه آماده‌ست — به‌روزرسانی» card, like every app (owner, 2026-10-30)", () => {
  const ready = { kind: "apply" as const, id: "b1", version: "1203" };
  it("shows when an update is ready and the person is on a calm screen", () => expect(offerApply(ready, "home", false, null)).toBe(true));
  it("never over the camera or a playing story", () => {
    expect(offerApply(ready, "record", false, null)).toBe(false);
    expect(offerApply(ready, "home", true, null)).toBe(false);
  });
  it("«بعداً» is respected for that version only", () => {
    expect(offerApply(ready, "home", false, "1203")).toBe(false);
    expect(offerApply(ready, "home", false, "1146")).toBe(true);
  });
  it("nothing to offer otherwise", () => expect(offerApply({ kind: "up-to-date" }, "home", false, null)).toBe(false));
});

describe("the checksum the plugin insists on (root cause 2026-10-30: without it the native download throws before any request)", () => {
  const withSum = rel; const noSum = { version: rel.version, url: rel.url, minNative: rel.minNative };
  it("a release without a checksum is a visible failure, never a silent 'download'", () =>
    expect(planUpdate({ running: "1133", native: 14, release: noSum, bundles: [] })).toEqual({ kind: "failed", why: "no checksum" }));
  it("with it, the download goes ahead and carries it", () =>
    expect(planUpdate({ running: "1133", native: 14, release: withSum, bundles: [] })).toEqual({ kind: "download", release: withSum }));
});

describe("before any check has run, the line says so (owner's screenshot showed «به‌روزه» that was only the default)", () => {
  it("unchecked is its own state", () => expect(statusText({ kind: "unchecked" })).toBe("هنوز بررسی نشده"));
  it("a check stamps the time", () => expect(statusText({ kind: "up-to-date", at: "۱۲:۵۴" }, "20261030-1218")).toBe("نسخهٔ برنامه ۲۰۲۶۱۰۳۰-۱۲۱۸ · آخرین بررسی ساعت ۱۲:۵۴"));
});

// owner, 2026-10-30: «وقتی آپدیتم کامل شد و اینستال کردم و رفتم توی اپ، باز یه نوتیف به‌روزرسانی اومد». The APK
// carries the web part of the moment it was built; a newer web part found right after installing is applied quietly
// at the next start — no card in the first session after a new APK.
import { justInstalledNative } from "./updatePlan.js";
describe("no update card right after installing a new APK", () => {
  const ready = { kind: "apply" as const, id: "b1", version: "1203" };
  it("the first session on a new native build does not offer the card", () => {
    expect(offerApply(ready, "home", false, null, true)).toBe(false);
    expect(offerApply(ready, "home", false, null, false)).toBe(true);
  });
  it("a new native build is told apart from the same one opened again", () => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(justInstalledNative(20, ls)).toBe(true);   // first start of build 20
    expect(justInstalledNative(20, ls)).toBe(false);  // opened again
    expect(justInstalledNative(21, ls)).toBe(true);   // the next APK
    expect(justInstalledNative(0, ls)).toBe(false);   // the plain web has no native build
  });
});
