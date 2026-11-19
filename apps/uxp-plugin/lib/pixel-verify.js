"use strict";

const { PluginError } = require("./errors");
function validRgba(bytes, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 4000000 || !ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || bytes.byteLength !== width * height * 4) throw new PluginError("VERIFICATION_FAILED", "Invalid bounded RGBA verification buffer");
}
function alphaBounds(bytes, width, height) {
  validRgba(bytes, width, height);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (bytes[(y * width + x) * 4 + 3] > 0) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < 0 ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
function cropRgba(bytes, width, height, bounds) {
  validRgba(bytes, width, height);
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > width || bounds.y + bounds.height > height) throw new PluginError("VERIFICATION_FAILED", "Invalid crop bounds");
  const output = new Uint8Array(bounds.width * bounds.height * 4);
  for (let row = 0; row < bounds.height; row++) {
    const start = ((bounds.y + row) * width + bounds.x) * 4;
    output.set(bytes.subarray(start, start + bounds.width * 4), row * bounds.width * 4);
  }
  return output;
}
function compareComposite(original, foreground, background, width, height, bounds, tolerance = 1) {
  for (const bytes of [original, foreground, background]) validRgba(bytes, width, height);
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 8) throw new PluginError("PRECONDITION_FAILED", "pixel_tolerance must be between 0 and 8");
  // Validate the ROI without creating another copy of the entire canvas.
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > width || bounds.y + bounds.height > height) throw new PluginError("VERIFICATION_FAILED", "Invalid verification bounds");
  let mismatchedPixels = 0, maxChannelDifference = 0, totalDifference = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
    const i = (y * width + x) * 4, fa = foreground[i + 3] / 255, ba = background[i + 3] / 255, oa = original[i + 3] / 255;
    const alpha = fa + ba * (1 - fa);
    let difference = Math.abs(alpha * 255 - original[i + 3]);
    for (let channel = 0; channel < 3; channel++) {
      const actual = foreground[i + channel] * fa + background[i + channel] * ba * (1 - fa);
      difference = Math.max(difference, Math.abs(actual - original[i + channel] * oa));
    }
    if (difference > tolerance + 1e-7) mismatchedPixels++;
    maxChannelDifference = Math.max(maxChannelDifference, difference); totalDifference += difference;
  }
  const comparedPixels = bounds.width * bounds.height;
  return { status: mismatchedPixels ? "mismatch" : "matched", method: "source-over-premultiplied-sRGB", scope: "current-backdrop-asset-rectangle", bounds, tolerance, comparedPixels, mismatchedPixels, maxChannelDifference, meanPixelMaxDifference: totalDifference / comparedPixels, arbitraryBackgroundVerified: false, outsideBoundsVerified: false };
}
module.exports = { alphaBounds, cropRgba, compareComposite };
