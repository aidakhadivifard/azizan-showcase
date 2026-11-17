import { describe, it, expect } from "vitest";
import { playbackModeForChild, showsText } from "./ageMode.js";

describe("ageMode — playback mode follows the child's age, chosen once", () => {
  it("under 5 (2-4) plays in 'young' mode", () => {
    expect(playbackModeForChild({ ageBand: "2-4" })).toBe("young");
  });

  it("5-8 plays in 'old' mode", () => {
    expect(playbackModeForChild({ ageBand: "5-8" })).toBe("old");
  });

  it("older plays in 'old' mode", () => {
    expect(playbackModeForChild({ ageBand: "older" })).toBe("old");
  });

  it("young mode shows no on-screen text; old mode shows text", () => {
    expect(showsText("young")).toBe(false);
    expect(showsText("old")).toBe(true);
  });
});
