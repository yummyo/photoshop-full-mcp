"use strict";

const { app, imaging, core, constants } = require("photoshop");
const { PluginError } = require("./errors");
const { captureState } = require("./inspection");
const { base64 } = require("./crypto-compat");

function rectangle(value) {
  const values = value && [value.left, value.top, value.right, value.bottom];
  if (!values || !values.every(v => v != null && Number.isFinite(Number(v)))) throw new PluginError("CAPABILITY_UNAVAILABLE", "Pixel bounds are unavailable");
  const [left, top, right, bottom] = values.map(Number);
  const box = { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right) - Math.floor(left), height: Math.ceil(bottom) - Math.floor(top) };
  if (box.width <= 0 || box.height <= 0) throw new PluginError("CAPABILITY_UNAVAILABLE", "The source has empty pixel bounds");
  return box;
}
function findLayer(doc, id) {
  const stack = Array.from(doc.layers || []).map(layer => ({ layer, ancestors: [] }));
  let count = 0;
  while (stack.length) {
    if (++count > 50000) throw new PluginError("PRECONDITION_FAILED", "Layer lookup exceeded 50000 nodes");
    const entry = stack.pop();
    if (entry.layer.id === id) return entry;
    let children = [];
    try { children = Array.from(entry.layer.layers || []); } catch (_) { /* Non-group. */ }
    for (const layer of children) stack.push({ layer, ancestors: [...entry.ancestors, entry.layer.id] });
  }
  throw new PluginError("STALE_TARGET", "The requested layer is not in the open document");
}
async function capture(input = {}, context = {}) {
  if (input.render_mode === "isolated_composite") return require("./isolated-render").capture(input, context);
  const allowed = new Set(["document_id", "layer_id", "max_pixels", "render_mode"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new PluginError("PRECONDITION_FAILED", `Unknown pixel capture option: ${key}`);
  if (input.render_mode !== undefined && input.render_mode !== "layer_pixels") throw new PluginError("PRECONDITION_FAILED", "Unknown render_mode");
  for (const key of ["document_id", "layer_id"]) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1)) throw new PluginError("PRECONDITION_FAILED", `${key} must be a positive integer`);
  const maxPixels = input.max_pixels === undefined ? 4000000 : input.max_pixels;
  if (!Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > 8000000) throw new PluginError("PRECONDITION_FAILED", "max_pixels must be between 1 and 8000000");
  if (typeof imaging.getPixels !== "function" || typeof core.executeAsModal !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Read-only pixel capture is unavailable in this Photoshop runtime");
  const doc = input.document_id === undefined ? app.activeDocument : Array.from(app.documents || []).find(doc => doc.id === input.document_id);
  if (!doc) throw new PluginError("NO_DOCUMENT", "The requested Photoshop document is not open");
  if (!constants || doc.mode !== constants.DocumentMode.RGB || doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT) throw new PluginError("CAPABILITY_UNAVAILABLE", "Design PNG capture currently requires RGB 8-bit; source conversion is not performed");
  const before = captureState(doc);
  const entry = input.layer_id === undefined ? null : findLayer(doc, input.layer_id);
  const requested = entry ? rectangle(entry.layer.boundsNoEffects) : rectangle({ left: 0, top: 0, right: doc.width, bottom: doc.height });
  if (requested.width * requested.height > maxPixels) throw new PluginError("PRECONDITION_FAILED", "Source exceeds max_pixels; no resizing or precision reduction was performed");
  const result = await core.executeAsModal(async executionContext => {
    if (context.bindModal) context.bindModal(executionContext);
    if (context.throwIfCancelled) context.throwIfCancelled();
    if (JSON.stringify(before) !== JSON.stringify(captureState(doc))) throw new PluginError("STALE_TARGET", "Document changed while acquiring the read-only imaging scope");
    // No withTarget, activation, layer selection, history suspension or save.
    const pixels = await imaging.getPixels({ documentID: doc.id, ...(entry ? { layerID: entry.layer.id } : {}), sourceBounds: { left: requested.x, top: requested.y, right: requested.x + requested.width, bottom: requested.y + requested.height }, componentSize: 8, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", applyAlpha: false });
    const imageData = pixels && pixels.imageData;
    try {
      if (!imageData) throw new PluginError("HOST_ERROR", "Host returned no image data");
      if (Number(pixels.level || 0) !== 0) throw new PluginError("VERIFICATION_FAILED", "Host returned a cached pyramid image instead of full-resolution pixels");
      const width = Number(imageData.width), height = Number(imageData.height), components = Number(imageData.components);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > maxPixels || Number(imageData.componentSize) !== 8 || ![3, 4].includes(components) || imageData.colorSpace !== "RGB") throw new PluginError("CAPABILITY_UNAVAILABLE", "Host pixel format or dimensions do not match the bounded RGB 8-bit request");
      const b = pixels.sourceBounds;
      if (!b) throw new PluginError("VERIFICATION_FAILED", "Host did not return actual source bounds");
      const sourceBounds = rectangle({ left: b.left, top: b.top, right: b.right === undefined ? Number(b.left) + Number(b.width) : b.right, bottom: b.bottom === undefined ? Number(b.top) + Number(b.height) : b.bottom });
      if (sourceBounds.width !== width || sourceBounds.height !== height || sourceBounds.x < requested.x || sourceBounds.y < requested.y || sourceBounds.x + width > requested.x + requested.width || sourceBounds.y + height > requested.y + requested.height) throw new PluginError("VERIFICATION_FAILED", "Host returned scaled or out-of-request pixel bounds");
      if (imageData.colorProfile && imageData.colorProfile !== "sRGB IEC61966-2.1") throw new PluginError("VERIFICATION_FAILED", "Host returned an unexpected color profile");
      const bytes = await imageData.getData({ chunky: true });
      if (!ArrayBuffer.isView(bytes) || bytes.byteLength !== width * height * components) throw new PluginError("VERIFICATION_FAILED", "Pixel buffer size does not match its metadata");
      if (context.throwIfCancelled) context.throwIfCancelled();
      return { documentId: doc.id, layerId: entry ? entry.layer.id : null, name: entry ? entry.layer.name : doc.title, kind: entry ? String(entry.layer.kind) : "composite", ancestorIds: entry ? entry.ancestors : [], requestedSourceBounds: requested, sourceBounds, width, height, components, componentSize: 8, scale: 1, alpha: components === 4 ? "straight" : "none", requestedColorProfile: "sRGB IEC61966-2.1", colorProfile: imageData.colorProfile || null, rawPixels: base64(bytes), rendering: entry ? { mode: "layer-pixels", effects: "unverified", masks: "unverified", parentCompositing: "not_reconstructed", visibilityChanged: false } : { mode: "document-composite", source: "current-visible-document", visibilityChanged: false } };
    } finally { if (imageData) imageData.dispose(); }
  }, { commandName: "Read Photoshop design pixels", interactive: false });
  const after = captureState(doc);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new PluginError("STALE_TARGET", "Document state changed during pixel capture", { before, after });
  return { ...result, readOnlyCheck: { status: "unchanged", before, after } };
}

module.exports = { capture };
