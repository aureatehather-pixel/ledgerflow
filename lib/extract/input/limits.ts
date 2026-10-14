/**
 * Input limits.
 *
 * A PDF is untrusted input from a party outside this system. Every limit here
 * exists to bound work *before* it is done, because the cheap defences have to
 * run first: a byte-count check costs nothing and a page-count check costs one
 * structural parse, while rasterising is orders of magnitude more expensive and
 * is exactly what a hostile document would try to provoke.
 *
 * The pixel cap is the least obvious and the most important. A PDF can declare
 * an arbitrary MediaBox, so a one-page document can ask for a canvas of billions
 * of pixels. Scale is therefore derived from the cap rather than fixed, and a
 * page that cannot fit is refused rather than rendered small and silently.
 */

export interface InputLimits {
  /** Refused before pdf.js is given the bytes. */
  readonly maxBytes: number;
  /** Refused after the structure is read, before any page is touched. */
  readonly maxPages: number;
  /** Upper bound on width x height for any rasterised page. */
  readonly maxRenderPixels: number;
  /** Preferred rasterisation scale, reduced if the pixel cap requires it. */
  readonly renderScale: number;
}

/**
 * Defaults.
 *
 * `maxBytes` matches the upload ceiling in `lib/upload/validation.ts` so a file
 * that was accepted at the boundary cannot be rejected here for size alone --
 * two different limits on the same axis is a bug waiting for the day they drift.
 *
 * `maxPages` at 200 is a guard, not a product decision: a year of statements for
 * one account sits far below it, and a document above it is more likely a
 * mis-upload than a bank statement. It is deliberately generous, because
 * refusing a real 120-page statement would be worse than the cost of parsing it.
 *
 * `renderScale` 2.0 approximates 144 DPI against the 72 DPI PDF user-space unit.
 * What resolution a model actually needs is an M2b measurement, not a guess to
 * bake in now -- this is a starting point that a real corpus will move.
 */
export const DEFAULT_INPUT_LIMITS: InputLimits = Object.freeze({
  maxBytes: 15 * 1024 * 1024,
  maxPages: 200,
  maxRenderPixels: 40_000_000,
  renderScale: 2.0,
});

/**
 * Largest scale that keeps a page inside the pixel cap.
 *
 * Returns `null` when even scale 1 would exceed it -- the caller must refuse
 * rather than shrink, because a page silently rendered at 0.05 would be
 * unreadable and would look like a successful render.
 */
export function scaleWithinPixelBudget(
  widthAtScale1: number,
  heightAtScale1: number,
  limits: InputLimits,
): number | null {
  if (widthAtScale1 <= 0 || heightAtScale1 <= 0) return null;
  const atOne = widthAtScale1 * heightAtScale1;
  if (atOne > limits.maxRenderPixels) return null;
  const maxScale = Math.sqrt(limits.maxRenderPixels / atOne);
  return Math.min(limits.renderScale, maxScale);
}
