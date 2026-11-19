import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { encodePng } from "./png.js";
import { PhotoshopMcpError } from "./errors.js";
import { auditDesignFonts } from "./design-fonts.js";
import { normalizeDesignStyles } from "./design-styles.js";

type Data = Record<string, any>;
type ReadHost = (kind: string, payload: Record<string, unknown>) => Promise<unknown>;
export interface DesignExportOptions { document_id?: number; layer_ids?: number[]; include_reference?: boolean; include_styles?: boolean; max_pixels?: number; render_mode?: "layer_pixels" | "isolated_composite"; pixel_tolerance?: number }
const fail = (message: string, code: "PRECONDITION_FAILED" | "VERIFICATION_FAILED" | "STALE_TARGET" = "VERIFICATION_FAILED"): never => { throw new PhotoshopMcpError(code, message); };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fingerprint = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function prepareRoot(value: string): Promise<string> {
  const requested = resolve(value), missing: string[] = [];
  let existing = requested;
  for (;;) {
    try { await lstat(existing); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing.push(basename(existing)); const parent = dirname(existing); if (parent === existing) throw error; existing = parent; }
  }
  if ((await lstat(existing)).isSymbolicLink() || !samePath(existing, await realpath(existing))) fail("Export root must not traverse a symlink or junction", "PRECONDITION_FAILED");
  for (const name of missing.reverse()) {
    existing = join(existing, name);
    await mkdir(existing).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    if ((await lstat(existing)).isSymbolicLink() || !samePath(existing, await realpath(existing))) fail("Export root changed into a symlink or junction", "PRECONDITION_FAILED");
  }
  return existing;
}

/** Validate the host's binary contract before encoding or allocating a canvas. */
export function decodeDesignPixels(value: unknown, maxPixels: number): { metadata: Data; bytes: Buffer } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Host returned no pixel metadata");
  const data = value as Data;
  const { width, height, components, rawPixels, sourceBounds } = data;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || width * height > maxPixels || ![3, 4].includes(components) || data.componentSize !== 8 || data.scale !== 1) fail("Invalid or over-budget full-resolution pixel metadata");
  const expected = width * height * components;
  if (expected > 32 * 1024 * 1024 || typeof rawPixels !== "string" || rawPixels.length !== 4 * Math.ceil(expected / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(rawPixels)) fail("Invalid bounded base64 pixel buffer");
  const bytes = Buffer.from(rawPixels, "base64");
  if (bytes.length !== expected || bytes.toString("base64") !== rawPixels) fail("Pixel byte count or base64 encoding does not match metadata");
  if (!sourceBounds || ![sourceBounds.x, sourceBounds.y, sourceBounds.width, sourceBounds.height].every(Number.isSafeInteger) || sourceBounds.width !== width || sourceBounds.height !== height) fail("Actual source bounds do not match PNG dimensions");
  if (data.readOnlyCheck?.status !== "unchanged" || !equal(data.readOnlyCheck.before, data.readOnlyCheck.after)) fail("Host did not verify unchanged document state", "STALE_TARGET");
  if (data.alpha !== (components === 4 ? "straight" : "none")) fail("Host alpha metadata is inconsistent");
  if (data.requestedColorProfile !== "sRGB IEC61966-2.1" || (data.colorProfile && data.colorProfile !== "sRGB IEC61966-2.1")) fail("Unexpected PNG color profile");
  const { rawPixels: _pixels, ...metadata } = data;
  return { metadata, bytes };
}

/** Imaging API may trim transparent borders. Preserve the full reference canvas. */
export function referencePng(bytes: Buffer, metadata: Data, width: number, height: number, maxPixels: number): Buffer {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || width * height > maxPixels || width * height * 4 > 32 * 1024 * 1024) fail("Reference canvas exceeds the PNG budget");
  const b = metadata.sourceBounds;
  if (b.x < 0 || b.y < 0 || b.x + metadata.width > width || b.y + metadata.height > height) fail("Composite bounds escape the document canvas");
  const canvas = Buffer.alloc(width * height * 4);
  for (let y = 0; y < metadata.height; y++) for (let x = 0; x < metadata.width; x++) {
    const source = (y * metadata.width + x) * metadata.components;
    const target = ((b.y + y) * width + b.x + x) * 4;
    bytes.copy(canvas, target, source, source + 3);
    canvas[target + 3] = metadata.components === 4 ? bytes[source + 3]! : 255;
  }
  return encodePng(canvas, width, height, 4);
}

export function referenceRoiHash(bytes: Buffer, metadata: Data, bounds: Data): string {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.width < 1 || bounds.height < 1 || bounds.width * bounds.height > 4000000) fail("Invalid reference verification rectangle");
  const rgba = Buffer.alloc(bounds.width * bounds.height * 4), source = metadata.sourceBounds;
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    const sx = bounds.x + x - source.x, sy = bounds.y + y - source.y;
    if (sx < 0 || sy < 0 || sx >= metadata.width || sy >= metadata.height) continue;
    const from = (sy * metadata.width + sx) * metadata.components, to = (y * bounds.width + x) * 4;
    bytes.copy(rgba, to, from, from + 3); rgba[to + 3] = metadata.components === 4 ? bytes[from + 3]! : 255;
  }
  return fingerprint(rgba);
}

function verifyIsolatedProof(decoded: { metadata: Data; bytes: Buffer }, tolerance: number): void {
  const m = decoded.metadata, p = m.rendering?.verification;
  if (m.rendering?.mode !== "isolated-composite" || m.rendering?.implementation !== "isolated-composite/1" || m.temporaryDocument?.closed !== true || m.temporaryDocument?.originalDocumentIdsRestored !== true) fail("Host did not prove temporary-copy cleanup");
  if (!p || p.method !== "source-over-premultiplied-sRGB" || p.scope !== "current-backdrop-asset-rectangle" || p.tolerance !== tolerance || p.arbitraryBackgroundVerified !== false || p.outsideBoundsVerified !== false || !equal(p.bounds, m.sourceBounds)) fail("Host returned an invalid isolated-render verification scope");
  if (p.assetPixelSha256 !== fingerprint(decoded.bytes) || !/^[a-f0-9]{64}$/.test(p.originalRoiSha256 || "") || !/^[a-f0-9]{64}$/.test(p.backgroundRoiSha256 || "")) fail("Isolated asset pixels differ from the verification receipt");
  if (p.comparedPixels !== m.width * m.height || p.comparedPixels > 4000000 || !Number.isSafeInteger(p.mismatchedPixels) || p.mismatchedPixels < 0 || p.mismatchedPixels > p.comparedPixels || !Number.isFinite(p.maxChannelDifference) || p.maxChannelDifference < 0 || p.maxChannelDifference > 255 + 1e-7 || !Number.isFinite(p.meanPixelMaxDifference) || p.meanPixelMaxDifference < 0 || p.meanPixelMaxDifference > p.maxChannelDifference + 1e-7 || p.status !== (p.mismatchedPixels ? "mismatch" : "matched") || (!p.mismatchedPixels && p.maxChannelDifference > tolerance + 1e-7) || (p.mismatchedPixels && p.maxChannelDifference <= tolerance + 1e-7)) fail("Host returned inconsistent isolated-render metrics");
}

export class DesignExporter {
  constructor(private readonly outputRoot: string, private readonly readHost: ReadHost) {}

  async export(input: DesignExportOptions): Promise<Data> {
    const allowed = new Set(["document_id", "layer_ids", "include_reference", "include_styles", "max_pixels", "render_mode", "pixel_tolerance"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) fail(`Unknown design export option: ${key}`, "PRECONDITION_FAILED");
    if (input.document_id !== undefined && (!Number.isSafeInteger(input.document_id) || input.document_id < 1)) fail("document_id must be positive", "PRECONDITION_FAILED");
    const layerIds = input.layer_ids || [];
    if (!Array.isArray(layerIds) || layerIds.length > 32 || layerIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(layerIds).size !== layerIds.length) fail("layer_ids must contain at most 32 unique positive IDs", "PRECONDITION_FAILED");
    for (const key of ["include_reference", "include_styles"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") fail(`${key} must be boolean`, "PRECONDITION_FAILED");
    const maxPixels = input.max_pixels ?? 4000000;
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 8000000) fail("max_pixels must be between 1 and 8000000", "PRECONDITION_FAILED");
    const renderMode = input.render_mode || "layer_pixels", tolerance = input.pixel_tolerance ?? 1;
    if (!["layer_pixels", "isolated_composite"].includes(renderMode) || !Number.isInteger(tolerance) || tolerance < 0 || tolerance > 8) fail("Invalid render_mode or pixel_tolerance", "PRECONDITION_FAILED");
    const options = { include_hidden: true, include_text: true, include_text_runs: true, include_styles: input.include_styles !== false, limit: 50 };
    let documentId = input.document_id, cursor: string | undefined;
    const pages: Data[] = [], ids = new Set<number>(), layers: Data[] = [];
    do {
      const page = await this.readHost("document.inspect", { ...options, ...(documentId ? { document_id: documentId } : {}), ...(cursor ? { cursor } : {}) }) as Data;
      if (!page || page.schemaVersion !== "photoshop.design/1" || !Array.isArray(page.layers) || !page.document?.id || page.readOnlyCheck?.status !== "unchanged" || !equal(page.readOnlyCheck.before, page.readOnlyCheck.after)) fail("Host returned an invalid or changed design page");
      if (documentId !== undefined && documentId !== page.document.id) fail("Inspection returned another document", "STALE_TARGET");
      if (pages.length && (page.revision !== pages[0]!.revision || !equal(page.document, pages[0]!.document) || !equal(page.readOnlyCheck.before, pages[0]!.readOnlyCheck.before))) fail("Document changed between export pages", "STALE_TARGET");
      documentId = page.document.id;
      for (const layer of page.layers) {
        if (!Number.isSafeInteger(layer.id) || ids.has(layer.id)) fail("Duplicate or invalid layer identity in export");
        ids.add(layer.id); layers.push(layer);
      }
      pages.push(page); cursor = page.page?.nextCursor ?? undefined;
      if (cursor !== undefined && (typeof cursor !== "string" || !/^[a-f0-9]{64}:[0-9]{1,8}$/.test(cursor))) fail("Host returned an invalid page cursor");
      if (pages.length > 1000 || layers.length > 50000 || (cursor && page.layers.length === 0)) fail("Export traversal limit exceeded");
    } while (cursor);
    const first = pages[0]!, before = first.readOnlyCheck.before;
    if (layers.length !== first.counts?.totalNodeCount) fail("Export did not return the full document tree");
    const byId = new Map(layers.map(layer => [layer.id, layer]));
    for (const layer of layers) {
      if (layer.parentId !== null && !byId.has(layer.parentId)) fail("Export contains an orphan layer");
      if (layer.parentId !== null && !byId.get(layer.parentId)!.children.includes(layer.id)) fail("Export contains an unlisted child layer");
      if (!Array.isArray(layer.children) || layer.children.some((child: number) => byId.get(child)?.parentId !== layer.id)) fail("Export contains inconsistent child links");
    }
    if (layerIds.some(id => !ids.has(id))) fail("A requested asset ID is not in the current document", "STALE_TARGET");
    if (!equal(first.rootLayerIds, layers.filter(layer => layer.parentId === null).map(layer => layer.id))) fail("Export root layer order is inconsistent");
    // Bound a complete batch as well as each image: native receipts retain
    // base64 buffers until acknowledgement/retention cleanup.
    const requestedPixels = (input.include_reference !== false ? first.document.width * first.document.height : 0) + layerIds.reduce((sum, id) => {
      const b = byId.get(id)!.boundsNoEffects;
      const area = renderMode === "isolated_composite" ? first.document.width * first.document.height : b ? Math.ceil(b.width) * Math.ceil(b.height) : 0;
      return sum + (Number.isFinite(area) && area > 0 ? Math.min(area, maxPixels) : 0);
    }, 0);
    if (requestedPixels > 16000000) fail("Batch exceeds the 16 million pixel budget; export fewer layer IDs", "PRECONDITION_FAILED");
    const actualRoot = await prepareRoot(this.outputRoot);
    const runId = `${documentId}-${randomUUID()}`, directory = join(actualRoot, runId), assetsDirectory = join(directory, "assets");
    await mkdir(directory, { mode: 0o700 }); await mkdir(assetsDirectory, { mode: 0o700 });
    const appearanceUnavailable = options.include_styles ? layers.filter(layer => layer.appearance?.status !== "available").map(layer => ({ layerId: layer.id, reason: layer.appearance?.reason || "Host returned no appearance descriptor" })) : [];
    const missingFonts = [...new Set(layers.filter(layer => layer.text?.fontAvailability === "missing").map(layer => layer.text.characterStyle.font))];
    const limitations = renderMode === "isolated_composite"
      ? ["Only an owned temporary duplicate is edited. Isolated effects/masks/ancestors are rendered by Photoshop; source-over verification covers the asset rectangle on its current backdrop, not arbitrary backgrounds or off-canvas pixels. Mismatches are retained as unverified assets."]
      : ["Layer pixel captures do not certify layer effects, masks or parent compositing. No visibility changes, selection, history suspension or temporary document edits are performed."];
    const manifest: Data = { schemaVersion: "photoshop.design-assets/1", runId, status: "in_progress", document: first.document, revision: first.revision, createdAt: new Date().toISOString(), originalDocumentReadOnly: true, renderMode, appearance: { requested: options.include_styles, unavailable: appearanceUnavailable }, missingWholeLayerFonts: missingFonts, assets: [], reference: null, limitations };
    const write = async (name: string, bytes: Buffer | string) => { await writeFile(join(directory, name), bytes, { flag: "wx", mode: 0o600 }); return { path: name, bytes: Buffer.byteLength(bytes), sha256: fingerprint(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) }; };
    let referencePixels: { metadata: Data; bytes: Buffer } | undefined;
    const capture = async (layerId?: number) => {
      const isolated = layerId !== undefined && renderMode === "isolated_composite";
      const decoded = decodeDesignPixels(await this.readHost("design.pixels", { document_id: documentId, ...(layerId !== undefined ? { layer_id: layerId } : {}), max_pixels: maxPixels, ...(isolated ? { render_mode: renderMode, pixel_tolerance: tolerance } : {}) }), maxPixels);
      if (decoded.metadata.documentId !== documentId || decoded.metadata.layerId !== (layerId ?? null) || !equal(decoded.metadata.readOnlyCheck.before, before)) fail("Pixel capture belongs to a changed document or target", "STALE_TARGET");
      if (isolated) {
        verifyIsolatedProof(decoded, tolerance);
        if (referencePixels && referenceRoiHash(referencePixels.bytes, referencePixels.metadata, decoded.metadata.sourceBounds) !== decoded.metadata.rendering.verification.originalRoiSha256) fail("Rendered asset was checked against different reference pixels", "STALE_TARGET");
      }
      return decoded;
    };
    try {
      if (input.include_reference !== false) {
        const { bytes, metadata } = await capture();
        referencePixels = { bytes, metadata };
        const png = referencePng(bytes, metadata, first.document.width, first.document.height, maxPixels);
        manifest.reference = { ...await write("design-preview.png", png), width: first.document.width, height: first.document.height, capture: metadata };
      }
      for (const layerId of layerIds) {
        try {
          const { bytes, metadata } = await capture(layerId);
          const png = encodePng(bytes, metadata.width, metadata.height, metadata.components);
          const status = metadata.rendering?.verification?.status === "mismatch" ? "exported_unverified" : "exported";
          manifest.assets.push({ layerId, name: byId.get(layerId)!.name, status, ...await write(`assets/layer-${layerId}.png`, png), capture: metadata, sourceLayer: { kind: byId.get(layerId)!.kind, visible: byId.get(layerId)!.effectiveVisible, bounds: byId.get(layerId)!.bounds, boundsNoEffects: byId.get(layerId)!.boundsNoEffects, ancestorIds: byId.get(layerId)!.ancestorIds } });
        } catch (error) {
          if (error instanceof PhotoshopMcpError && ["STALE_TARGET", "OUTCOME_UNKNOWN", "CANCELLED"].includes(error.code)) throw error;
          manifest.assets.push({ layerId, name: byId.get(layerId)!.name, status: "unavailable", reason: error instanceof Error ? error.message : String(error) });
        }
      }
      const final = await this.readHost("document.inspect", { ...options, document_id: documentId, limit: 1 }) as Data;
      if (final.revision !== first.revision || !equal(final.readOnlyCheck?.before, before) || !equal(final.readOnlyCheck?.after, before)) fail("Document changed before export completed", "STALE_TARGET");
      const { page: _page, ...header } = first;
      const design = { ...header, layers, page: { returned: layers.length, hasMore: false, nextCursor: null }, extraction: { runId, capturedAt: new Date().toISOString(), pages: pages.length, originalDocumentReadOnly: true }, warnings: [...new Set(pages.flatMap(page => page.warnings || []))] };
      manifest.design = await write("design.json", JSON.stringify(design, null, 2) + "\n");
      const fonts = auditDesignFonts(layers);
      manifest.fonts = await write("fonts.json", JSON.stringify(fonts, null, 2) + "\n");
      manifest.fontSummary = { missing: fonts.missing, conflicting: fonts.conflicting };
      const styles = normalizeDesignStyles(layers, first.document, options.include_styles);
      manifest.styles = await write("styles.json", JSON.stringify(styles, null, 2) + "\n");
      manifest.styleSummary = styles.summary;
      manifest.resourceBudget = { maxPixelsPerImage: maxPixels, maxRequestedPixelsPerBatch: 16000000, requestedPixels };
      manifest.readOnlyCheck = { status: "unchanged", before, after: final.readOnlyCheck.after };
      manifest.status = appearanceUnavailable.length || manifest.assets.some((asset: Data) => asset.status !== "exported") ? "partial" : "complete";
      manifest.completedAt = new Date().toISOString();
      await write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
      return { schemaVersion: manifest.schemaVersion, status: manifest.status, directory, manifestPath: join(directory, "manifest.json"), designPath: join(directory, "design.json"), stylesPath: join(directory, "styles.json"), referencePath: manifest.reference ? join(directory, "design-preview.png") : null, counts: first.counts, styleSummary: manifest.styleSummary, assetsExported: manifest.assets.filter((asset: Data) => asset.status.startsWith("exported")).length, assetsUnverified: manifest.assets.filter((asset: Data) => asset.status === "exported_unverified").length, assetsUnavailable: manifest.assets.filter((asset: Data) => asset.status === "unavailable").length, originalDocumentReadOnly: true, readOnlyCheck: manifest.readOnlyCheck, limitations: manifest.limitations };
    } catch (error) {
      manifest.status = "invalidated";
      manifest.reason = error instanceof Error ? error.message : String(error);
      await write("manifest.json", JSON.stringify(manifest, null, 2) + "\n").catch(() => {});
      throw new PhotoshopMcpError(error instanceof PhotoshopMcpError ? error.code : "HOST_ERROR", manifest.reason, { directory, status: "invalidated", ...(error instanceof PhotoshopMcpError && error.details !== undefined ? { causeDetails: error.details } : {}) });
    }
  }
}
