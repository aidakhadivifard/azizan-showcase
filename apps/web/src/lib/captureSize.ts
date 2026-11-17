// The recording's size follows the camera's frame (owner, 2026-10-30: «وبش رو بهتر کنیم»): with
// resizeMode "none" the owner's phone hands over the sensor's own SQUARE (2208×2208); cutting that to
// 3:4 threw away a quarter of the width. A square sensor → a square recording; a portrait 3:4 sensor →
// 3:4; anything wider than square is cropped to square, anything taller than 3:4 to 3:4.
export const CAPTURE_W = 600;
export function captureHeight(vw: number, vh: number): number {
  if (!vw || !vh) return 800;
  return Math.min(800, Math.max(600, Math.round((CAPTURE_W * vh) / vw)));
}

/** the face fills more than half the camera's height — the phone is held too close for any hat to fit */
export function tooClose(box: { h: number } | null | undefined): boolean {
  return !!box && box.h > 0.5;
}
