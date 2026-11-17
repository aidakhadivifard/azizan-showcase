import { describe, it, expect } from "vitest";
import { captureHeight, tooClose } from "./captureSize.js";

describe("the recording keeps the camera's whole frame", () => {
  it("a square sensor → a square recording (nothing thrown away)", () => {
    expect(captureHeight(2208, 2208)).toBe(600);
  });
  it("a portrait 3:4 camera → 3:4; taller is capped at 3:4", () => {
    expect(captureHeight(1440, 1920)).toBe(800);
    expect(captureHeight(1080, 1920)).toBe(800);
  });
  it("a landscape camera → square (sides cropped, never bars)", () => {
    expect(captureHeight(1920, 1440)).toBe(600);
    expect(captureHeight(0, 0)).toBe(800);
  });
  it("too close = the face is over half the frame's height", () => {
    expect(tooClose({ h: 0.63 })).toBe(true);
    expect(tooClose({ h: 0.4 })).toBe(false);
    expect(tooClose(null)).toBe(false);
  });
});
