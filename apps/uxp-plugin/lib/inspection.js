"use strict";

const { app, action } = require("photoshop");
const { PluginError } = require("./errors");
const { sha256Hex, utf8ByteLength } = require("./crypto-compat");

const SCHEMA_VERSION = "photoshop.design/1";
const MAX_NODES = 50000;
const CHARACTER_FIELDS = ["font", "size", "leading", "tracking", "fauxBold", "fauxItalic", "horizontalScale", "verticalScale", "baselineShift", "useAutoLeading", "antiAliasMethod"];
const PARAGRAPH_FIELDS = ["justification", "hyphenation", "firstLineIndent", "leftIndent", "rightIndent", "spaceBefore", "spaceAfter"];

function read(fn, unavailable, field) {
  try {
    const value = fn();
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Property is not exposed by this runtime");
    return value;
  } catch (error) {
    if (unavailable) unavailable[field] = error.message || String(error);
    return null;
  }
}

function bounds(value) {
  if (!value) throw new Error("Bounds are unavailable");
  const values = [value.left, value.top, value.right, value.bottom].map(numberValue);
  if (!values.every(Number.isFinite)) throw new Error("Bounds contain non-finite values");
  const [left, top, right, bottom] = values;
  return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top };
}

function numberValue(value) {
  if (value === undefined || value === null) throw new Error("Numeric property is not exposed by this runtime");
  return Number(value);
}

function styleValue(value) {
  if (value === null) throw new Error("Photoshop returned null: style is unset, mixed, or not applicable");
  return value;
}

function stringValue(value) {
  if (value === undefined || value === null) throw new Error("Property is not exposed by this runtime");
  return String(value);
}

function captureState(doc) {
  const unavailable = {};
  return {
    activeDocumentId: read(() => app.activeDocument ? app.activeDocument.id : null, unavailable, "activeDocumentId"),
    selectedLayerIds: read(() => Array.from(doc.activeLayers).map(layer => layer.id), unavailable, "selectedLayerIds"),
    saved: read(() => doc.saved, unavailable, "saved"),
    historyStateId: read(() => doc.activeHistoryState.id, unavailable, "historyStateId"),
    historyLength: read(() => doc.historyStates.length, unavailable, "historyLength"),
    selectionBounds: read(() => doc.selection.bounds ? bounds(doc.selection.bounds) : null, unavailable, "selectionBounds"),
    unavailableFields: unavailable
  };
}

function validateOptions(input) {
  const allowed = new Set(["document_id", "layer_ids", "include_hidden", "include_text", "include_text_runs", "include_styles", "limit", "cursor"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new PluginError("PRECONDITION_FAILED", `Unknown inspection option: ${key}`);
  const limit = input.limit === undefined ? 100 : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new PluginError("PRECONDITION_FAILED", "limit must be an integer between 1 and 500");
  if (input.document_id !== undefined && (!Number.isSafeInteger(input.document_id) || input.document_id < 1)) throw new PluginError("PRECONDITION_FAILED", "document_id must be a positive integer");
  if (input.layer_ids !== undefined && (!Array.isArray(input.layer_ids) || !input.layer_ids.length || input.layer_ids.length > 1000 || input.layer_ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(input.layer_ids).size !== input.layer_ids.length)) throw new PluginError("PRECONDITION_FAILED", "layer_ids must contain 1-1000 unique positive IDs");
  for (const key of ["include_hidden", "include_text", "include_text_runs", "include_styles"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new PluginError("PRECONDITION_FAILED", `${key} must be boolean`);
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !/^[a-f0-9]{64}:[0-9]{1,8}$/.test(input.cursor))) throw new PluginError("PRECONDITION_FAILED", "Invalid inspection cursor");
  return { ...input, limit, include_hidden: input.include_hidden !== false, include_text: input.include_text !== false, include_text_runs: input.include_text_runs !== false, include_styles: input.include_styles === true };
}

function collect(doc) {
  const result = [], seen = new Set();
  const root = Array.from(doc.layers);
  const stack = root.map((layer, index) => ({ layer, index, parent: null })).reverse();
  while (stack.length) {
    if (result.length >= MAX_NODES) throw new PluginError("PRECONDITION_FAILED", `Document exceeds the ${MAX_NODES} node inspection limit`);
    const entry = stack.pop(), layer = entry.layer;
    if (entry.parent && entry.parent.depth >= 255) throw new PluginError("PRECONDITION_FAILED", "Layer nesting exceeds the 256-level inspection limit");
    if (!Number.isSafeInteger(layer.id) || seen.has(layer.id)) throw new PluginError("STALE_TARGET", "Layer identities are invalid or changed while reading");
    seen.add(layer.id);
    const unavailable = {};
    const kind = read(() => stringValue(layer.kind), unavailable, "kind");
    // Accessing .layers on a non-group can throw on some host versions.
    let children = [];
    try {
      const collection = layer.layers;
      if (kind === "group" && collection == null) throw new Error("Group child collection is not exposed by this runtime");
      children = Array.from(collection || []);
    }
    catch (error) {
      if (kind === "group" || kind === null) throw new PluginError("HOST_ERROR", `Cannot enumerate children of layer ${layer.id}: ${error.message || String(error)}`);
    }
    const visible = read(() => layer.visible, unavailable, "visible");
    const parentVisible = entry.parent ? entry.parent.effectiveVisible : true;
    const node = {
      id: layer.id, parentId: entry.parent ? entry.parent.id : null,
      ancestorIds: entry.parent ? [...entry.parent.ancestorIds, entry.parent.id] : [],
      index: entry.index, depth: entry.parent ? entry.parent.depth + 1 : 0,
      name: read(() => layer.name, unavailable, "name"), kind,
      children: children.map(child => child.id), visible,
      effectiveVisible: visible === false || parentVisible === false ? false : visible === true && parentVisible === true ? true : null,
      opacity: read(() => numberValue(layer.opacity), unavailable, "opacity"),
      fillOpacity: read(() => numberValue(layer.fillOpacity), unavailable, "fillOpacity"),
      blendMode: read(() => stringValue(layer.blendMode), unavailable, "blendMode"),
      allLocked: read(() => layer.allLocked, unavailable, "allLocked"),
      isClippingMask: read(() => layer.isClippingMask, unavailable, "isClippingMask"),
      bounds: read(() => bounds(layer.bounds), unavailable, "bounds"),
      boundsNoEffects: read(() => bounds(layer.boundsNoEffects), unavailable, "boundsNoEffects"),
      unavailableFields: unavailable
    };
    const own = node.boundsNoEffects, parentBounds = entry.parent && entry.parent.boundsNoEffects;
    node.positionInParent = own && (!entry.parent || parentBounds)
      ? { x: own.x - (parentBounds ? parentBounds.x : 0), y: own.y - (parentBounds ? parentBounds.y : 0), basis: "boundsNoEffects" }
      : null;
    if (!node.positionInParent) unavailable.positionInParent = "Layer or parent boundsNoEffects are unavailable";
    result.push({ layer, node });
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ layer: children[i], index: i, parent: node });
  }
  return { entries: result, rootLayerIds: root.map(layer => layer.id) };
}

function colorValue(color) {
  if (!color) throw new Error("Text color is unavailable");
  const rgb = color.rgb;
  const components = [rgb.red, rgb.green, rgb.blue].map(numberValue);
  if (!components.every(Number.isFinite)) throw new Error("RGB text color is unavailable");
  return { model: "RGB", red: components[0], green: components[1], blue: components[2], hex: components.map(n => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join("") };
}

function textMetadata(layer, fontNames) {
  const unavailable = {};
  const item = read(() => layer.textItem, unavailable, "textItem");
  if (!item) return { status: "unavailable", unavailableFields: unavailable };
  const character = read(() => item.characterStyle, unavailable, "characterStyle");
  const paragraph = read(() => item.paragraphStyle, unavailable, "paragraphStyle");
  const characterStyle = {}, paragraphStyle = {};
  for (const key of CHARACTER_FIELDS) characterStyle[key] = read(() => styleValue(character[key]), unavailable, `characterStyle.${key}`);
  characterStyle.color = read(() => colorValue(character.color), unavailable, "characterStyle.color");
  for (const key of PARAGRAPH_FIELDS) paragraphStyle[key] = read(() => styleValue(paragraph[key]), unavailable, `paragraphStyle.${key}`);
  const contents = read(() => item.contents, unavailable, "contents");
  const contentsTruncated = typeof contents === "string" && contents.length > 200000;
  return {
    status: "available",
    contents: contentsTruncated ? contents.slice(0, 200000) : contents,
    contentsTruncated,
    isPointText: read(() => item.isPointText, unavailable, "isPointText"),
    isParagraphText: read(() => item.isParagraphText, unavailable, "isParagraphText"),
    characterStyle, paragraphStyle,
    fontAvailability: fontNames && characterStyle.font ? (fontNames.has(characterStyle.font) ? "available" : "missing") : "unknown",
    unavailableFields: unavailable
  };
}

function copyDescriptor(value, truncations, path = "descriptor", depth = 0) {
  if (depth > 12) { truncations.push(path); return null; }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.length > 200000) { truncations.push(path); return value.slice(0, 200000); }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 2000) truncations.push(path);
    return value.slice(0, 2000).map((entry, index) => copyDescriptor(entry, truncations, `${path}[${index}]`, depth + 1));
  }
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of Object.keys(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[key] = copyDescriptor(value[key], truncations, `${path}.${key}`, depth + 1);
  }
  return result;
}

async function textRanges(doc, page, warnings) {
  const textNodes = page.filter(node => node.kind === "text");
  for (let offset = 0; offset < textNodes.length; offset += 25) {
    const batch = textNodes.slice(offset, offset + 25);
    try {
      const results = await action.batchPlay(batch.map(node => ({
        _obj: "get", _target: [{ _ref: "property", _property: "textKey" }, { _ref: "layer", _id: node.id }, { _ref: "document", _id: doc.id }],
        _options: { dialogOptions: "dontDisplay" }
      })), { synchronousExecution: false, modalBehavior: "fail" });
      batch.forEach((node, index) => {
        const result = results && results[index];
        if (!result || result._obj === "error" || !result.textKey) {
          node.text.ranges = { status: "unavailable", reason: result && result.message || "Photoshop did not return textKey" };
          return;
        }
        const truncations = [], key = result.textKey;
        const data = copyDescriptor({ textStyleRange: key.textStyleRange, paragraphStyleRange: key.paragraphStyleRange, transform: key.transform, textShape: key.textShape, bounds: key.bounds, boundingBox: key.boundingBox }, truncations);
        const unavailableFields = {};
        for (const field of Object.keys(data)) if (key[field] === undefined) unavailableFields[field] = "Property is not present in the Photoshop textKey descriptor";
        node.text.ranges = { status: "available", ...data, unavailableFields, truncatedFields: truncations };
        if (truncations.length) warnings.push(`Text descriptor for layer ${node.id} was truncated; inspect its truncatedFields`);
      });
    } catch (error) {
      for (const node of batch) node.text.ranges = { status: "unavailable", reason: error.message || String(error) };
    }
  }
}

async function inspect(input = {}) {
  const options = validateOptions(input);
  const doc = options.document_id === undefined ? app.activeDocument : Array.from(app.documents || []).find(item => item.id === options.document_id);
  if (!doc) throw new PluginError("NO_DOCUMENT", "The requested Photoshop document is not open");
  const before = captureState(doc), warnings = [];
  const documentUnavailable = {};
  const document = {
    id: doc.id, title: read(() => doc.title, documentUnavailable, "title"),
    width: read(() => numberValue(doc.width), documentUnavailable, "width"),
    height: read(() => numberValue(doc.height), documentUnavailable, "height"),
    resolutionPpi: read(() => numberValue(doc.resolution), documentUnavailable, "resolutionPpi"),
    mode: read(() => stringValue(doc.mode), documentUnavailable, "mode"),
    bitsPerChannel: read(() => stringValue(doc.bitsPerChannel), documentUnavailable, "bitsPerChannel"),
    colorProfileName: read(() => doc.colorProfileName, documentUnavailable, "colorProfileName"),
    unavailableFields: documentUnavailable
  };
  const { entries, rootLayerIds } = collect(doc);
  const existingIds = new Set(entries.map(entry => entry.node.id));
  if (options.layer_ids && options.layer_ids.some(id => !existingIds.has(id))) throw new PluginError("STALE_TARGET", "One or more requested layer IDs are no longer in this document");
  const query = { layer_ids: options.layer_ids || null, include_hidden: options.include_hidden, include_text: options.include_text, include_text_runs: options.include_text_runs, include_styles: options.include_styles };
  const revision = sha256Hex(JSON.stringify({ document, before, query, nodes: entries.map(entry => entry.node) }));
  let offset = 0;
  if (options.cursor) {
    const [expected, start] = options.cursor.split(":");
    if (expected !== revision) throw new PluginError("STALE_TARGET", "Document or inspection options changed; restart pagination without a cursor");
    offset = Number(start);
  }
  const wanted = options.layer_ids ? new Set(options.layer_ids) : null;
  const matches = entries.filter(({ node }) => (!wanted || wanted.has(node.id)) && (options.include_hidden || node.effectiveVisible !== false));
  if (offset > matches.length) throw new PluginError("PRECONDITION_FAILED", "Inspection cursor is outside this result");
  const selected = matches.slice(offset, offset + options.limit);
  let fontNames = null;
  if (options.include_text && selected.some(entry => entry.node.kind === "text")) {
    try { fontNames = new Set(Array.from(app.fonts).map(font => font.postScriptName)); } catch (_) { warnings.push("Installed font availability could not be checked"); }
  }
  for (const { layer, node } of selected) {
    node.text = node.kind !== "text" ? { status: "not_applicable" }
      : options.include_text ? textMetadata(layer, fontNames) : { status: "not_requested" };
  }
  const layers = selected.map(entry => entry.node);
  if (options.include_text && options.include_text_runs) await textRanges(doc, layers, warnings);
  if (options.include_styles) await require("./appearance").readAppearance(doc, layers, warnings);
  const after = captureState(doc);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new PluginError("STALE_TARGET", "Document state changed during inspection; retry the read", { before, after });
  const groupCount = entries.filter(entry => entry.node.kind === "group" || entry.node.children.length > 0).length;
  const nextOffset = offset + layers.length;
  const result = {
    schemaVersion: SCHEMA_VERSION, readOnly: true, document, revision,
    units: { bounds: "px", origin: "document top-left", parentPosition: "parent boundsNoEffects top-left", opacity: "percent", characterMetrics: "UXP DOM pixels at document resolution", tracking: "1/1000 em", rawTextRangeUnits: "preserved in _unit/_value descriptors" },
    counts: { topLevelCount: rootLayerIds.length, totalNodeCount: entries.length, groupCount, leafCount: entries.length - groupCount, matchedCount: matches.length },
    rootLayerIds, layers,
    page: { offset, limit: options.limit, returned: layers.length, hasMore: nextOffset < matches.length, nextCursor: nextOffset < matches.length ? `${revision}:${nextOffset}` : null },
    readOnlyCheck: { status: "unchanged", before, after }, warnings
  };
  if (utf8ByteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new PluginError("PRECONDITION_FAILED", "Inspection response exceeds 4 MiB; reduce limit or inspect individual layer IDs");
  return result;
}

module.exports = { inspect, SCHEMA_VERSION, captureState, copyDescriptor };
