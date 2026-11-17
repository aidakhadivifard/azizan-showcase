// Which page was on screen at which second of a recording. Written while recording
// (every page turn), read back at playback so the child sees the right picture and
// words while the teller is reading them. Kept on this phone, keyed by the video id.

export interface PageMark {
  /** seconds since the recording started */
  t: number;
  /** 0-based page index */
  page: number;
}

const key = (videoId: string) => `azizan.marks.${videoId}`;

export function saveMarks(videoId: string, marks: PageMark[]): void {
  try {
    localStorage.setItem(key(videoId), JSON.stringify(marks));
  } catch {
    /* private mode / quota — playback falls back to evenly spaced pages */
  }
}

export function loadMarks(videoId: string): PageMark[] | null {
  try {
    const raw = localStorage.getItem(key(videoId));
    const m = raw ? (JSON.parse(raw) as PageMark[]) : null;
    return Array.isArray(m) && m.length ? m : null;
  } catch {
    return null;
  }
}

/** When the page on screen at `t` started and ends (the next page turn, or the end of the
 *  video) — used to follow the sentences inside a page (domain/beats). */
export function pageWindow(t: number, marks: PageMark[] | null, totalPages: number, duration: number, startPage = 0): { start: number; end: number } {
  const page = pageAt(t, marks, totalPages, duration, startPage);
  const end = Number.isFinite(duration) && duration > 0 ? duration : t + 1;
  if (marks?.length) {
    let start = 0, next = end;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i]!.t <= t) { start = marks[i]!.t; next = marks[i + 1]?.t ?? end; }
      else break;
    }
    return { start, end: next };
  }
  // no marks: this sitting's pages (from `startPage` to the last) share its length evenly
  const first = Math.min(Math.max(0, startPage), Math.max(0, totalPages - 1));
  const n = totalPages - first;
  if (n <= 1) return { start: 0, end };
  const per = end / n;
  return { start: (page - first) * per, end: (page - first + 1) * per };
}

/** The page to show at `t` seconds: the last mark at or before `t`. Without marks
 *  (older recordings, another phone), pages are spread evenly over the video. */
/** The page a sitting begins on. A story read in several sittings has one clip per sitting; a sitting WITH marks
 *  says its own pages, but one without (an old, moved or rescued clip) used to spread the WHOLE book over itself —
 *  while page 4 was read the child saw page 1 (review 2026-11-16). It carries on after the sitting before it; with
 *  no marks there either, the book is shared out between the sittings. */
export function sittingStartPage(marks: Array<PageMark[] | null | undefined>, clip: number, totalPages: number): number {
  if (clip <= 0 || totalPages <= 1) return 0;
  const last = totalPages - 1;
  const prev = marks[clip - 1];
  if (prev?.length) return Math.min(last, prev[prev.length - 1]!.page + 1);
  return Math.min(last, Math.floor((clip * totalPages) / Math.max(1, marks.length)));
}

/** `startPage`: for a sitting without marks, the page it begins on (sittingStartPage). */
export function pageAt(t: number, marks: PageMark[] | null, totalPages: number, duration: number, startPage = 0): number {
  if (marks?.length) {
    let page = marks[0]!.page;
    for (const m of marks) {
      if (m.t <= t) page = m.page;
      else break;
    }
    return Math.min(Math.max(page, 0), totalPages - 1);
  }
  const first = Math.min(Math.max(0, startPage), Math.max(0, totalPages - 1));
  const n = totalPages - first;
  if (!duration || !Number.isFinite(duration) || n <= 1) return first;
  return Math.min(totalPages - 1, first + Math.floor((t / duration) * n));
}
