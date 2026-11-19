"use strict";

const { app, core, imaging, constants } = require("photoshop");
const { PluginError } = require("./errors");
const { captureState } = require("./inspection");
const { randomId } = require("./storage");
const { base64, sha256Hex } = require("./crypto-compat");
const { alphaBounds, cropRgba, compareComposite } = require("./pixel-verify");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const documents = () => Array.from(app.documents || []);
const documentIds = () => documents().map(doc => doc.id).sort((a, b) => a - b);

function tree(doc) {
  const result = [], seen = new Set(), stack = Array.from(doc.layers || []).map((layer, index) => ({ layer, path: [index] })).reverse();
  while (stack.length) {
    if (result.length >= 50000) throw new PluginError("PRECONDITION_FAILED", "Temporary render exceeds 50000 layer nodes");
    const entry = stack.pop();
    if (!Number.isSafeInteger(entry.layer.id) || entry.layer.id < 1 || seen.has(entry.layer.id)) throw new PluginError("STALE_TARGET", "Layer identities are not unique during temporary rendering");
    seen.add(entry.layer.id);
    if (entry.path.length > 256) throw new PluginError("PRECONDITION_FAILED", "Temporary render exceeds 256 layer levels");
    if (typeof entry.layer.visible !== "boolean") throw new PluginError("CAPABILITY_UNAVAILABLE", "A layer visibility state cannot be read safely");
    let children = [];
    try { const collection = entry.layer.layers; if (String(entry.layer.kind) === "group" && collection == null) throw new PluginError("CAPABILITY_UNAVAILABLE", "Group child collection is unavailable"); children = Array.from(collection || []); }
    catch (error) { if (String(entry.layer.kind) === "group") throw error; }
    result.push({ ...entry, name: entry.layer.name, kind: String(entry.layer.kind), visible: entry.layer.visible });
    for (let i = children.length - 1; i >= 0; i--) stack.push({ layer: children[i], path: [...entry.path, i] });
  }
  return result;
}
const signature = entries => entries.map(entry => ({ id: entry.layer.id, path: entry.path, name: entry.name, kind: entry.kind, visible: entry.visible }));
const prefix = (a, b) => a.length <= b.length && a.every((value, index) => value === b[index]);

async function rgba(documentId, width, height, executionContext) {
  if (executionContext.isCancelled) throw new PluginError("CANCELLED", "Temporary render was cancelled");
  const pixels = await imaging.getPixels({ documentID: documentId, sourceBounds: { left: 0, top: 0, right: width, bottom: height }, componentSize: 8, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", applyAlpha: false });
  const image = pixels && pixels.imageData;
  try {
    if (!image || Number(pixels.level || 0) !== 0 || Number(image.componentSize) !== 8 || image.colorSpace !== "RGB" || ![3, 4].includes(Number(image.components))) throw new PluginError("CAPABILITY_UNAVAILABLE", "Host did not return full-resolution RGB/RGBA pixels");
    if (image.colorProfile && image.colorProfile !== "sRGB IEC61966-2.1") throw new PluginError("VERIFICATION_FAILED", "Host returned a different color profile");
    const w = Number(image.width), h = Number(image.height), components = Number(image.components);
    if (![w, h].every(Number.isSafeInteger) || w < 0 || h < 0 || w * h > width * height) throw new PluginError("VERIFICATION_FAILED", "Invalid temporary render dimensions");
    const bytes = await image.getData({ chunky: true });
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength !== w * h * components) throw new PluginError("VERIFICATION_FAILED", "Temporary pixel byte count differs from dimensions");
    const output = new Uint8Array(width * height * 4);
    if (w === 0 && h === 0 && bytes.byteLength === 0) return output;
    const b = pixels.sourceBounds;
    const x = b && Number(b.left), y = b && Number(b.top);
    const right = b && (b.right === undefined ? x + Number(b.width) : Number(b.right));
    const bottom = b && (b.bottom === undefined ? y + Number(b.height) : Number(b.bottom));
    if (![x, y, right, bottom].every(Number.isSafeInteger) || x < 0 || y < 0 || right - x !== w || bottom - y !== h || right > width || bottom > height || w < 1 || h < 1) throw new PluginError("VERIFICATION_FAILED", "Temporary render was scaled or returned invalid bounds");
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const source = (row * w + col) * components, target = ((y + row) * width + x + col) * 4;
      output[target] = bytes[source]; output[target + 1] = bytes[source + 1]; output[target + 2] = bytes[source + 2]; output[target + 3] = components === 4 ? bytes[source + 3] : 255;
    }
    return output;
  } finally { if (image) image.dispose(); }
}

async function capture(input = {}, context = {}) {
  const allowed = new Set(["document_id", "layer_id", "max_pixels", "render_mode", "pixel_tolerance"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new PluginError("PRECONDITION_FAILED", `Unknown isolated render option: ${key}`);
  if (!Number.isSafeInteger(input.layer_id) || input.layer_id < 1 || (input.document_id !== undefined && (!Number.isSafeInteger(input.document_id) || input.document_id < 1))) throw new PluginError("PRECONDITION_FAILED", "Isolated rendering requires positive document/layer IDs");
  const tolerance = input.pixel_tolerance === undefined ? 1 : input.pixel_tolerance;
  const maxPixels = input.max_pixels === undefined ? 4000000 : input.max_pixels;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 8 || !Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > 8000000 || input.render_mode !== "isolated_composite") throw new PluginError("PRECONDITION_FAILED", "Invalid isolated rendering options");
  const doc = input.document_id === undefined ? app.activeDocument : documents().find(doc => doc.id === input.document_id);
  if (!doc) throw new PluginError("NO_DOCUMENT", "The requested source document is not open");
  const width = Number(doc.width), height = Number(doc.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > Math.min(maxPixels, 4000000)) throw new PluginError("PRECONDITION_FAILED", "Isolated verification requires a whole canvas within max_pixels and the 4 million pixel limit");
  if (!constants || doc.mode !== constants.DocumentMode.RGB || doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT || typeof doc.duplicate !== "function" || typeof core.executeAsModal !== "function" || typeof imaging.getPixels !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Temporary composite rendering requires RGB 8-bit and document duplication/imaging support");
  const sourceTree = tree(doc), selected = sourceTree.find(entry => entry.layer.id === input.layer_id);
  if (!selected) throw new PluginError("STALE_TARGET", "The selected layer is no longer in the source document");
  const ancestors = sourceTree.filter(entry => prefix(entry.path, selected.path));
  if (ancestors.some(entry => !entry.visible)) throw new PluginError("CAPABILITY_UNAVAILABLE", "Hidden targets are not forced visible for isolated rendering");
  if (ancestors.some(entry => entry.layer.isClippingMask === true)) throw new PluginError("CAPABILITY_UNAVAILABLE", "Target clips to a sibling outside its subtree; select a containing group");
  const before = captureState(doc), beforeIds = documentIds(), originalTree = signature(sourceTree), priorActive = app.activeDocument;
  const marker = `PS_MCP_TEMP_${randomId("render")}`;
  let owned = null, value, primaryError = null, cleanupError = null, autoRegistered = false;
  const isOwned = candidate => candidate && candidate.id !== doc.id && !beforeIds.includes(candidate.id) && String(candidate.title || "").startsWith(marker);
  try {
    value = await core.executeAsModal(async executionContext => {
      if (context.bindModal) context.bindModal(executionContext);
      if (context.throwIfCancelled) context.throwIfCancelled();
      if (!executionContext.hostControl || typeof executionContext.hostControl.registerAutoCloseDocument !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Host cannot guarantee automatic temporary-document cleanup");
      if (!equal(before, captureState(doc)) || !equal(originalTree, signature(tree(doc)))) throw new PluginError("STALE_TARGET", "Source changed before temporary rendering");
      const original = await rgba(doc.id, width, height, executionContext);
      let duplicate;
      try { duplicate = await doc.duplicate(marker, false); }
      catch (error) {
        // Some hosts can create a document before reporting cancellation.
        // Recover only the unique fresh document carrying our random marker.
        const fresh = documents().filter(isOwned);
        if (fresh.length === 1) {
          owned = fresh[0];
          try { await executionContext.hostControl.registerAutoCloseDocument(owned.id); autoRegistered = true; } catch (_) { /* Owned fallback below still runs. */ }
        }
        throw error;
      }
      if (!isOwned(duplicate) || !documents().some(item => item.id === duplicate.id)) throw new PluginError("HOST_ERROR", "Duplicate ownership could not be verified; no user document was modified or closed");
      owned = duplicate;
      await executionContext.hostControl.registerAutoCloseDocument(owned.id); autoRegistered = true;
      if (Number(owned.width) !== width || Number(owned.height) !== height || owned.mode !== doc.mode || owned.bitsPerChannel !== doc.bitsPerChannel || owned.resolution !== doc.resolution || owned.colorProfileName !== doc.colorProfileName) throw new PluginError("STALE_TARGET", "Duplicate canvas or color properties differ from the source");
      const copies = tree(owned);
      if (copies.length !== sourceTree.length || copies.some((entry, index) => !equal(entry.path, sourceTree[index].path) || entry.name !== sourceTree[index].name || entry.kind !== sourceTree[index].kind)) throw new PluginError("STALE_TARGET", "Duplicate layer topology does not match the original; IDs were not guessed");
      const target = copies.find(entry => equal(entry.path, selected.path));
      for (const entry of copies) if (!prefix(entry.path, selected.path) && !prefix(selected.path, entry.path) && entry.layer.visible) entry.layer.visible = false;
      const foreground = await rgba(owned.id, width, height, executionContext);
      const bounds = alphaBounds(foreground, width, height);
      if (!bounds) throw new PluginError("CAPABILITY_UNAVAILABLE", "The isolated source contains no visible pixels");
      for (const entry of copies) if (entry.layer.visible !== entry.visible) entry.layer.visible = entry.visible;
      target.layer.visible = false;
      const background = await rgba(owned.id, width, height, executionContext);
      const verification = compareComposite(original, foreground, background, width, height, bounds, tolerance);
      const bytes = cropRgba(foreground, width, height, bounds);
      verification.assetPixelSha256 = sha256Hex(bytes);
      verification.originalRoiSha256 = sha256Hex(cropRgba(original, width, height, bounds));
      verification.backgroundRoiSha256 = sha256Hex(cropRgba(background, width, height, bounds));
      if (context.throwIfCancelled) context.throwIfCancelled();
      return { documentId: doc.id, layerId: selected.layer.id, name: selected.name, kind: selected.kind, ancestorIds: ancestors.filter(entry => entry !== selected).map(entry => entry.layer.id), requestedSourceBounds: { x: 0, y: 0, width, height }, sourceBounds: bounds, width: bounds.width, height: bounds.height, components: 4, componentSize: 8, scale: 1, alpha: "straight", requestedColorProfile: "sRGB IEC61966-2.1", colorProfile: "sRGB IEC61966-2.1", rawPixels: base64(bytes), rendering: { mode: "isolated-composite", implementation: "isolated-composite/1", effects: "rendered-in-duplicate", masks: "rendered-in-duplicate", parentCompositing: "retained-ancestor-chain", originalVisibilityChanged: false, temporaryVisibilityChanged: true, canvasClipped: true, verification, limitations: ["Verification covers the asset rectangle on the current backdrop, not arbitrary backgrounds or pixels outside it. Font differences remain deferred."] } };
    }, { commandName: "Render design asset in an owned temporary copy", interactive: false });
  } catch (error) { primaryError = error; }
  finally {
    try {
      const remaining = owned && documents().find(item => item.id === owned.id);
      const restoreNeeded = priorActive && documents().some(item => item.id === priorActive.id) && (!app.activeDocument || app.activeDocument.id !== priorActive.id);
      if (remaining || restoreNeeded) await core.executeAsModal(async () => {
        if (remaining) {
          if (!isOwned(remaining) || typeof remaining.closeWithoutSaving !== "function") throw new Error("Owned temporary document cannot be safely closed");
          await remaining.closeWithoutSaving();
        }
        if (priorActive && documents().some(item => item.id === priorActive.id) && (!app.activeDocument || app.activeDocument.id !== priorActive.id)) app.activeDocument = priorActive;
      }, { commandName: "Clean up temporary design rendering", interactive: false });
    } catch (error) { cleanupError = error; }
  }
  const after = captureState(doc), documentsUnchanged = equal(beforeIds, documentIds());
  if (cleanupError || !documentsUnchanged) throw new PluginError("OUTCOME_UNKNOWN", "Temporary render cleanup did not finish; stop exporting and inspect the owned document", { temporaryDocumentId: owned && owned.id, cleanupError: cleanupError && (cleanupError.message || String(cleanupError)), originalStateUnchanged: equal(before, after) });
  if (!equal(before, after) || !equal(originalTree, signature(tree(doc)))) throw new PluginError("STALE_TARGET", "Source or selection state changed during temporary rendering", { before, after });
  if (primaryError) throw primaryError;
  return { ...value, temporaryDocument: { id: owned.id, closed: true, autoCloseRegistered: autoRegistered, originalDocumentIdsRestored: true }, readOnlyCheck: { status: "unchanged", before, after } };
}
module.exports = { capture };
