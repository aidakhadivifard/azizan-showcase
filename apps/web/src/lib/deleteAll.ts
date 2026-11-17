// «حذفِ همه‌ی ضبط‌ها و اطلاعات» (CLAUDE.md: deletion is real deletion). This phone holds the only keys that can
// delete its family's videos on the server, so it is wiped LAST, and only when every server said yes. Before
// (review 2026-11-15, item 7) a refused or failed delete still wiped the phone — the answer was a string, always
// truthy — and the stories on the new طاقچه were never asked to go at all: the videos stayed, the keys were lost.

export interface DeleteAllSteps {
  /** the family's keys kept for «وصلِ ایمیل» (lib/recovery) — true when gone or never linked */
  forgetRecovery?: () => Promise<boolean>;
  /** the new طاقچه (v2): this phone's readings with their videos, the shelves it alone owns, the phone itself */
  deleteShelfModel: () => Promise<boolean>;
  /** the old family storage: every video, voice note and index of the household */
  deleteOldFamily: () => Promise<"ok" | "forbidden" | "failed">;
  /** clear this phone (videos, settings) — only after both said yes */
  wipePhone: () => Promise<void>;
}

/** True only when everything was deleted on the servers and the phone was then wiped. */
export async function deleteAllEverywhere(s: DeleteAllSteps): Promise<boolean> {
  try {
    if (!(await s.deleteShelfModel())) return false;
    if ((await s.deleteOldFamily()) !== "ok") return false;
    // last: until the videos are gone, the email copy is the way back to delete them from another phone
    if (s.forgetRecovery && !(await s.forgetRecovery())) return false;
  } catch {
    return false;
  }
  await s.wipePhone();
  return true;
}

// «حذفِ حسابِ من» — for someone who is NOT the family's first سرپرست (the هم‌خانه, an invited reader, a reader with
// no child): only what is theirs. The family and everyone else's recordings stay (owner, 2026-11-16: «فقط چیزهای
// خودش پاک شه»). Same rule as above: the phone is emptied LAST, and only when every server said yes.
export interface DeleteMineSteps {
  forgetRecovery?: () => Promise<boolean>;
  /** the طاقچه: the readings I read (with their videos), my طاقچه‌ها, links, tokens, and the phone itself */
  deleteMyShelfModel: () => Promise<boolean>;
  /** the old family storage: the recordings this phone made */
  deleteMyOldRecordings: () => Promise<boolean>;
  wipePhone: () => Promise<void>;
}
export async function deleteMyAccount(s: DeleteMineSteps): Promise<boolean> {
  try {
    if (!(await s.deleteMyOldRecordings())) return false;
    if (!(await s.deleteMyShelfModel())) return false;
    if (s.forgetRecovery && !(await s.forgetRecovery())) return false;
  } catch {
    return false;
  }
  await s.wipePhone();
  return true;
}
