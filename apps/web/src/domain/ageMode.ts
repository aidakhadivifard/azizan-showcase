import type { AgeBand } from "@azizan/shared";

export type PlaybackMode = "young" | "old";

/**
 * Playback mode is decided by the child's age band, which is chosen ONCE when
 * the child is created — never re-asked on the playback screen.
 * Under 5: the child watches the reader's face and the pictures, no text.
 * 5 and over: the text appears with a small circle of the reader above it.
 */
export function playbackModeForChild(child: { ageBand: AgeBand }): PlaybackMode {
  return child.ageBand === "2-4" ? "young" : "old";
}

/** Whether the story text is shown on screen in this mode. */
export function showsText(mode: PlaybackMode): boolean {
  return mode === "old";
}
