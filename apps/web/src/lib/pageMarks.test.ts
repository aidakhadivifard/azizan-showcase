import { describe, it, expect } from "vitest";
import { pageAt, type PageMark } from "./pageMarks.js";

const marks: PageMark[] = [
  { t: 0, page: 0 },
  { t: 12.5, page: 1 },
  { t: 30, page: 2 },
  { t: 41, page: 1 }, // the reader went back a page
  { t: 50, page: 2 },
];

describe("page marks — the right picture at the right second", () => {
  it("follows the page turns made while recording", () => {
    expect(pageAt(0, marks, 11, 60)).toBe(0);
    expect(pageAt(12.4, marks, 11, 60)).toBe(0);
    expect(pageAt(12.5, marks, 11, 60)).toBe(1);
    expect(pageAt(35, marks, 11, 60)).toBe(2);
  });
  it("honours going back a page", () => {
    expect(pageAt(45, marks, 11, 60)).toBe(1);
    expect(pageAt(55, marks, 11, 60)).toBe(2);
  });
  it("without marks, spreads the pages evenly over the video", () => {
    expect(pageAt(0, null, 10, 100)).toBe(0);
    expect(pageAt(55, null, 10, 100)).toBe(5);
    expect(pageAt(100, null, 10, 100)).toBe(9);
  });
});

// Review 2026-11-16: in a story read in several sittings, a sitting with NO page marks (an old, moved or rescued
// clip) spread the WHOLE book over itself — while page 4 was being read the child saw page 1, then every picture
// swept past. Such a sitting carries on from where the one before it stopped.
import { sittingStartPage, pageWindow } from "./pageMarks.js";
describe("a sitting without page marks, later in a several-sitting story", () => {
  const first: PageMark[] = [{ t: 0, page: 0 }, { t: 10, page: 1 }, { t: 20, page: 2 }];

  it("starts on the page after the previous sitting's last one", () => {
    expect(sittingStartPage([first, null], 1, 10)).toBe(3);
    expect(sittingStartPage([first, null], 0, 10)).toBe(0);
  });
  it("with no marks before it either, the book is shared out between the sittings", () => {
    expect(sittingStartPage([null, null], 1, 10)).toBe(5);
    expect(sittingStartPage([null, null, null], 2, 9)).toBe(6);
  });
  it("never starts past the last page", () => {
    expect(sittingStartPage([[{ t: 0, page: 9 }], null], 1, 10)).toBe(9);
  });
  it("its pages are the REMAINING ones, spread over its own length", () => {
    // pages 3..9 (7 pages) over 70 s → 10 s each
    expect(pageAt(0, null, 10, 70, 3)).toBe(3);
    expect(pageAt(35, null, 10, 70, 3)).toBe(6);
    expect(pageAt(69, null, 10, 70, 3)).toBe(9);
    expect(pageWindow(35, null, 10, 70, 3)).toEqual({ start: 30, end: 40 });
  });
  it("a sitting WITH marks is untouched by the start page", () => {
    expect(pageAt(12, first, 10, 60, 3)).toBe(1);
  });
});
