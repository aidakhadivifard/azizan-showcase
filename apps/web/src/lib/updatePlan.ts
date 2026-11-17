// ONE decision for silent web updates (owner, 2026-10-30: «هر بار حل می‌کنی ولی ریشه‌ای نه») — every
// case is named, Settings shows it in words, and «اعمال کن» applies it on demand. Pure; the
// plugin calls live in liveUpdate.ts.

export interface WebRelease { version: string; url: string; minNative: number; /** SHA-256 hex of the zip — the plugin refuses to download without it */ checksum?: string }
export interface BundleLike { id: string; version: string; status: string }

export type UpdatePlan =
  | { kind: "unchecked" }
  | { kind: "up-to-date"; at?: string }
  | { kind: "needs-app"; build: number }
  | { kind: "download"; release: WebRelease; percent?: number }
  | { kind: "apply"; id: string; version: string }
  | { kind: "failed"; why: string };

/** our web builds are named by their time, «20261116-1500» — so they can be told older from newer */
const DATED = /^[0-9]{8}-[0-9]{4}$/;

export function planUpdate(s: { running: string; native: number; release: WebRelease | null | undefined; bundles: BundleLike[]; /** a build that failed to start on this phone (lib/bootGuard) */ bad?: string | null }): UpdatePlan {
  const r = s.release;
  if (!r || !r.version || !r.url || r.version === s.running) return { kind: "up-to-date" };
  // a build that never reached the app on this phone is not taken again — the next one is (audit F1)
  if (s.bad && r.version === s.bad) return { kind: "up-to-date" };
  // never backwards: an older published build must not replace a newer one that is running (audit F4)
  if (DATED.test(r.version) && DATED.test(s.running) && r.version < s.running) return { kind: "up-to-date" };
  const min = Number(r.minNative) || 0;
  if (s.native < min) return { kind: "needs-app", build: min };
  const ready = s.bundles.find((b) => b.version === r.version && b.status === "success");
  if (ready) return { kind: "apply", id: ready.id, version: r.version };
  if (!/^[0-9a-f]{64}$/i.test(r.checksum ?? "")) return { kind: "failed", why: "no checksum" };
  return { kind: "download", release: r };
}

/** Switching bundles reloads the page: never mid-recording, never while a story plays. */
export function canApplyNow(screen: string, playing: boolean): boolean {
  return !playing && screen !== "record" && screen !== "review";
}

const FA = "۰۱۲۳۴۵۶۷۸۹";
const fa = (s: string) => s.replace(/[0-9]/g, (d) => FA[Number(d)]!);

export function statusText(p: UpdatePlan, running = ""): string {
  switch (p.kind) {
    case "unchecked": return "هنوز بررسی نشده";
    case "up-to-date": return (running && running !== "dev" ? `نسخهٔ برنامه ${fa(running)}` : "نسخهٔ برنامه") + (p.at ? ` · آخرین بررسی ساعت ${p.at}` : "");
    case "needs-app": return `آپدیت تازه نسخه‌ی ${fa(`1٫${p.build}`)} اپ رو می‌خواد — از بالا دریافتش کن`;
    case "download": return `در حال گرفتنِ آپدیت ${fa(p.release.version)}…${p.percent != null ? ` ${fa(String(p.percent))}٪` : ""}`;
    case "apply": return `آپدیت ${fa(p.version)} آماده‌ست`;
    case "failed": return `آپدیت نرسید (${p.why}) — دفعه‌ی بعد دوباره امتحان می‌شه`;
  }
}

/** Show the «نسخه‌ی تازه آماده‌ست — به‌روزرسانی» card? Only when ready, on a calm screen, not dismissed for
 *  this version, and not in the first session after a new APK — the person JUST updated; the newer web part
 *  applies itself quietly at the next start (owner, 2026-10-30: «باز یه نوتیف به‌روزرسانی اومد… در حالی که
 *  آپدیت کرده بودم»). */
export function offerApply(p: UpdatePlan, screen: string, playing: boolean, dismissedVersion: string | null, freshInstall = false): boolean {
  return p.kind === "apply" && !freshInstall && canApplyNow(screen, playing) && dismissedVersion !== p.version;
}

/** Is this the first start of a new native build (APK)? Remembers the build it saw; 0 (plain web) is never new. */
export function justInstalledNative(build: number, ls: { getItem(k: string): string | null; setItem(k: string, v: string): void }): boolean {
  if (!build) return false;
  const KEY = "azizan.lastNativeBuild";
  let seen: string | null = null;
  try { seen = ls.getItem(KEY); ls.setItem(KEY, String(build)); } catch { return false; }
  return seen !== String(build);
}
