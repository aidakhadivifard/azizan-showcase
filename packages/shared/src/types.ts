// Domain types shared by the API and the web app.
// The data model this mirrors is docs/04-data-model.md — keep them in sync.

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

/** Drives the playback mode. Under 5: no text, just the reader's face + pictures. */
export type AgeBand = "2-4" | "5-8" | "6-9" | "older";

/** A person's relationship to a child. The only place the roles differ in the UI
 *  is the "me" screen — everywhere else a child is a child. */
export type Role = "guardian" | "reader";

export type RecordingStatus = "in_progress" | "complete" | "abandoned";

/**
 * SEAM 1 — the source of a reading's audio/video.
 *
 * Today only `human_video` exists and it IS the product: a real, known person
 * reading on video. The other members are reserved so that adding AI narration
 * or a consented voice clone later is an *additive* change (a new value + a new
 * branch in the AI seam), never a schema migration or a rewrite.
 *
 * `ai_narration` and `ai_voice_clone` are deferred — see docs/07-decisions.md.
 * `ai_voice_clone` in particular is gated behind explicit consent and is a
 * product/legal decision, not a feature toggle.
 */
export type ReadingSource = "human_video" | "ai_narration" | "ai_voice_clone";

/** Android Chrome records webm; iOS Safari records mp4. Store as recorded,
 *  play back as-is — never assume one. */
export type ClipMimeType = "video/webm" | "video/mp4";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Person {
  id: string;
  /** what the child sees: «عمو رضا» */
  displayName: string;
  /** interface language, independent of any child's content language */
  uiLang: string;
  /** a still frame captured from the first video recording — never uploaded */
  avatarUrl: string | null;
  createdAt: string;
}

export interface Child {
  id: string;
  /** optional — a child can be created without a name */
  name: string | null;
  ageBand: AgeBand;
  /** belongs to the child, not the guardian; never collapse with a person's uiLang */
  contentLang: string;
  createdAt: string;
}

export interface PersonChild {
  personId: string;
  childId: string;
  role: Role;
  /** person id, for readers who arrived by invite */
  invitedBy: string | null;
  createdAt: string;
}

export interface Story {
  id: string;
  /** ascii slug, e.g. "zal", "kayumars" */
  slug: string;
  title: string;
  category: string;
  /** a story can be «شاهنامه» and «جنگی» and «مناسبت» at once */
  tags: string[];
  /** secondary tags; Home filters by the five shelves in `category` */
  genres: string[];
  ageBand: AgeBand;
  lang: string;
  pageCount: number;
  durationEstimateSec: number;
  coverImageUrl: string | null;
}

export interface StoryPage {
  storyId: string;
  /** 1-based */
  index: number;
  text: string;
  /** optional original couplet, rendered differently (Shahnameh stories) */
  verse: string | null;
  imageUrl: string | null;
}

export interface Recording {
  id: string;
  personId: string;
  childId: string;
  storyId: string;
  /** SEAM 1: how this reading was produced. Defaults to human_video. */
  source: ReadingSource;
  status: RecordingStatus;
  startedAt: string;
  completedAt: string | null;
}

/** One page of one recording. The real unit of the system: re-recording a single
 *  page replaces one clip row and one object, nothing else. */
export interface Clip {
  recordingId: string;
  pageIndex: number;
  /** object key in R2, region-prefixed */
  storageKey: string;
  mimeType: ClipMimeType;
  durationMs: number;
  bytes: number;
  uploadedAt: string;
}

export interface ShelfItem {
  childId: string;
  recordingId: string;
  playCount: number;
  lastPlayedAt: string | null;
}
