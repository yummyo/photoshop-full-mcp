import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { decodeDesignPixels, DesignExporter, referencePng, referenceRoiHash, type DesignExportOptions } from "../src/design-export.js";
import { pluginModules } from "./helpers/uxp-harness.js";
import { auditDesignFonts } from "../src/design-fonts.js";
import { PhotoshopFullMcpServer } from "../src/server.js";
import { CommandCatalog } from "../src/catalog.js";
import { PhotoshopMcpError } from "../src/errors.js";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const exportDesignBundle = (root: string, read: (kind: string, payload: any) => Promise<any>, options: DesignExportOptions) => new DesignExporter(root, read).export(options);
const state = { activeDocumentId: 7, selectedLayerIds: [2], saved: true, historyStateId: 5, historyLength: 1, selectionBounds: null, unavailableFields: {} };
const check = () => ({ status: "unchanged", before: structuredClone(state), after: structuredClone(state) });
function pixels(layerId: number | null = null) {
  return { documentId: 7, layerId, name: "sample", kind: layerId ? "pixel" : "composite", width: 2, height: 1, components: 4, componentSize: 8, scale: 1, alpha: "straight", requestedColorProfile: "sRGB IEC61966-2.1", colorProfile: "sRGB IEC61966-2.1", sourceBounds: { x: layerId ? -1 : 1, y: 1, width: 2, height: 1 }, rawPixels: Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]).toString("base64"), readOnlyCheck: check(), rendering: { mode: layerId ? "layer-pixels" : "document-composite", effects: "unverified" } };
}
function pngData(png: Buffer) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const parts = []; let offset = 8;
  while (offset < png.length) { const length = png.readUInt32BE(offset), name = png.toString("ascii", offset + 4, offset + 8); if (name === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length)); offset += length + 12; }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25], scanlines: inflateSync(Buffer.concat(parts)) };
}
async function outputRoot() {
  const base = resolve(".cache/design-export-tests"); await mkdir(base, { recursive: true }); return mkdtemp(join(base, "case-"));
}
function hostFixture(options: { failLayer?: boolean; finalChanged?: boolean; missingChild?: boolean } = {}) {
  const root = { id: 1, parentId: null, children: [2], name: "组", kind: "group", ancestorIds: [], effectiveVisible: true, appearance: { status: "available" } };
  const child = { id: 2, parentId: 1, children: [], name: "../unsafe:image", kind: "pixel", ancestorIds: [1], effectiveVisible: true, appearance: { status: "available" } };
  const calls: any[] = [];
  const read = async (kind: string, payload: any) => {
    calls.push({ kind, payload });
    if (kind === "design.pixels") { if (payload.layer_id && options.failLayer) throw new Error("Layer pixels not supported by this host"); return pixels(payload.layer_id ?? null); }
    assert.equal(kind, "document.inspect");
    return { schemaVersion: "photoshop.design/1", document: { id: 7, title: "sample.psd", width: 4, height: 3, resolutionPpi: 72 }, revision: options.finalChanged && payload.limit === 1 ? "b".repeat(64) : "a".repeat(64), counts: { totalNodeCount: 2 }, rootLayerIds: [1], layers: payload.limit === 1 ? [root] : payload.cursor ? (options.missingChild ? [] : [child]) : [root], page: { nextCursor: payload.limit === 1 || payload.cursor ? null : `${"a".repeat(64)}:1` }, readOnlyCheck: check(), warnings: [] };
  };
  return { read, calls };
}

test("reference PNG restores trimmed canvas borders and preserves straight alpha bytes", () => {
  const decoded = decodeDesignPixels(pixels(), 100);
  const png = pngData(referencePng(decoded.bytes, decoded.metadata, 4, 3, 100));
  assert.deepEqual([png.width, png.height, png.colorType], [4, 3, 6]);
  assert.deepEqual([...png.scanlines.subarray(0, 17)], Array(17).fill(0));
  assert.deepEqual([...png.scanlines.subarray(17 + 1 + 4, 17 + 1 + 12)], [10, 20, 30, 40, 50, 60, 70, 80]);
  for (const corrupt of [{ width: 3 }, { rawPixels: "AAAA" }, { scale: 0.5 }, { alpha: "premultiplied" }, { sourceBounds: { x: 0, y: 0, width: 3, height: 1 } }]) assert.throws(() => decodeDesignPixels({ ...pixels(), ...corrupt }, 100));
});

test("a design bundle paginates, uses stable safe filenames, hashes assets and never overwrites another run", async () => {
  const root = await outputRoot(), host = hostFixture();
  const first = await exportDesignBundle(join(root, "outputs"), host.read, { layer_ids: [2], max_pixels: 100 });
  const second = await exportDesignBundle(join(root, "outputs"), host.read, { layer_ids: [2], max_pixels: 100 });
  assert.notEqual(first.directory, second.directory);
  const manifest = JSON.parse(await readFile(join(first.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "complete"); assert.equal(manifest.assets[0].path, "assets/layer-2.png");
  assert.equal(manifest.assets[0].capture.sourceBounds.x, -1);
  assert.equal(manifest.assets[0].capture.rendering.effects, "unverified");
  const bytes = await readFile(join(first.directory, manifest.assets[0].path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.assets[0].sha256);
  assert.deepEqual([...pngData(bytes).scanlines.subarray(1)], [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.equal(JSON.parse(await readFile(join(first.directory, "design.json"), "utf8")).layers.length, 2);
  const stylesBytes = await readFile(first.stylesPath);
  const styles = JSON.parse(stylesBytes.toString("utf8"));
  assert.equal(styles.schemaVersion, "photoshop.web-styles/1");
  assert.equal(styles.layers.length, 2); assert.equal(styles.cssHintsVisuallyVerified, false);
  assert.equal(manifest.styles.sha256, createHash("sha256").update(stylesBytes).digest("hex"));
  assert.deepEqual(manifest.styleSummary, styles.summary);
  assert(host.calls.every(call => ["document.inspect", "design.pixels"].includes(call.kind)));
});

test("unsupported layer rendering is recorded as partial while concurrent document change invalidates the run", async () => {
  const root = await outputRoot();
  const partial = await exportDesignBundle(join(root, "partial"), hostFixture({ failLayer: true }).read, { layer_ids: [2], max_pixels: 100 });
  const manifest = JSON.parse(await readFile(join(partial.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "partial"); assert.equal(manifest.assets[0].status, "unavailable");
  let failedDirectory: string;
  await assert.rejects(exportDesignBundle(join(root, "changed"), hostFixture({ finalChanged: true }).read, { max_pixels: 100 }), (error: any) => { failedDirectory = error.details.directory; return error.code === "STALE_TARGET"; });
  const invalid = JSON.parse(await readFile(join(failedDirectory!, "manifest.json"), "utf8"));
  assert.equal(invalid.status, "invalidated");
  assert(!(await readdir(failedDirectory!)).includes("design.json"));
});

test("style artifacts interpret the captured descriptor without extra host reads and honor include_styles false", async () => {
  const root = await outputRoot(), host = hostFixture();
  const read = async (kind: string, payload: any) => {
    const page = await host.read(kind, payload);
    page.document.mode = "RGBColorMode"; page.document.colorProfileName = "sRGB IEC61966-2.1";
    for (const layer of page.layers) {
      layer.opacity = 100; layer.fillOpacity = 100; layer.blendMode = "normal";
      layer.appearance = { status: "available", truncatedFields: [], fields: { fill: { status: "available", raw: { adjustment: [{ _obj: "solidColorLayer", color: { _obj: "RGBColor", red: 1, grain: 2, blue: 3 } }] } } } };
    }
    return page;
  };
  const result = await exportDesignBundle(root, read, { include_reference: false });
  const styles = JSON.parse(await readFile(result.stylesPath, "utf8"));
  assert.equal(result.styleSummary.layersWithCssHints, 2);
  assert.equal(styles.layers[1].fill.color.green, 2);
  const design = JSON.parse(await readFile(result.designPath, "utf8"));
  const pointer = styles.layers[1].fill.source.split("#")[1].split("/").slice(1);
  assert.equal(pointer.reduce((v: any, key: string) => v[key], design)._obj, "solidColorLayer");
  const skipped = await exportDesignBundle(root, read, { include_reference: false, include_styles: false });
  const skippedStyles = JSON.parse(await readFile(skipped.stylesPath, "utf8"));
  assert.equal(skippedStyles.layers[0].fill.status, "not_requested");
  assert(skippedStyles.layers[0].cssHints.every((h: any) => h.property === "opacity"));
  assert(host.calls.every(call => call.kind === "document.inspect"));
});

test("invalid IDs, incomplete pages and linked output roots fail without producing a valid bundle", async () => {
  const root = await outputRoot(), host = hostFixture();
  await assert.rejects(exportDesignBundle(join(root, "missing"), host.read, { layer_ids: [999] }));
  await assert.rejects(exportDesignBundle(join(root, "incomplete"), hostFixture({ missingChild: true }).read, {}));
  assert.deepEqual(await readdir(root), []);
  const target = join(root, "outside"), link = join(root, "linked"); await mkdir(target); await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(exportDesignBundle(link, host.read, { include_reference: false }), /symlink|junction/);
  await assert.rejects(exportDesignBundle(join(link, "nested"), host.read, { include_reference: false }), /symlink|junction/);
  assert.deepEqual(await readdir(target), []);
});

function imagingFixture(options: { wrongSize?: boolean; changed?: boolean; level?: number } = {}) {
  let disposed = false, history = 5, modalCalls = 0;
  const layer = Object.freeze({ id: 2, kind: "pixel", name: "asset", boundsNoEffects: { left: -1, top: 1, right: 1, bottom: 2 } });
  const doc = Object.freeze({ id: 7, title: "sample.psd", width: 4, height: 3, mode: "RGB", bitsPerChannel: 8, layers: [layer], activeLayers: [layer], saved: true, get activeHistoryState() { return { id: history }; }, historyStates: [{}], selection: { bounds: null } });
  const calls: any[] = [];
  const photoshop = { app: Object.freeze({ activeDocument: doc, documents: [doc] }), constants: { DocumentMode: { RGB: "RGB" }, BitsPerChannelType: { EIGHT: 8 } },
    core: { executeAsModal: async (fn: any) => { modalCalls++; return fn({}); } }, imaging: { getPixels: async (args: any) => {
      calls.push(args);
      return { level: options.level || 0, sourceBounds: { left: args.sourceBounds.left, top: 1, right: args.sourceBounds.left + 2, bottom: 2 }, imageData: { width: 2, height: 1, components: 4, componentSize: 8, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", getData: async () => { if (options.changed) history++; return new Uint8Array(options.wrongSize ? [1] : [10,20,30,40,50,60,70,80]); }, dispose: () => { disposed = true; } } };
    } } };
  return { capture: pluginModules(photoshop)("design-pixels").capture, calls, disposed: () => disposed, modalCalls: () => modalCalls };
}

test("UXP pixel capture targets explicit IDs without activation and disposes buffers on success and failure", async () => {
  const fixture = imagingFixture(); const result = await fixture.capture({ document_id: 7, layer_id: 2 });
  assert.equal(result.sourceBounds.x, -1); assert.equal(result.readOnlyCheck.status, "unchanged");
  assert.equal(fixture.modalCalls(), 1); assert.equal(fixture.disposed(), true);
  assert.equal(fixture.calls[0].documentID, 7); assert.equal(fixture.calls[0].layerID, 2);
  assert.equal(fixture.calls[0].applyAlpha, false); assert.equal(fixture.calls[0].targetSize, undefined);
  for (const options of [{ wrongSize: true }, { changed: true }, { level: 1 }]) {
    const failed = imagingFixture(options);
    await assert.rejects(failed.capture({ layer_id: 2 })); assert.equal(failed.disposed(), true);
  }
});

test("appearance reads only get descriptors, preserves units and distinguishes absent fields from no effect", async () => {
  const nodes: any[] = [{ id: 2 }]; const calls: any[] = [];
  const readAppearance = pluginModules({ action: { batchPlay: async (descriptors: any[]) => { calls.push(...descriptors); return [{ adjustment: [{ _obj: "gradientLayer", angle: { _unit: "angleUnit", _value: 90 } }], layerEffects: { dropShadow: { distance: { _unit: "pixelsUnit", _value: 5 } } }, hasUserMask: false }]; } } })("appearance").readAppearance;
  await readAppearance({ id: 7 }, nodes, []);
  assert.equal(calls[0]._obj, "get"); assert.equal(calls[0]._target[1]._id, 7);
  assert.deepEqual(plain(nodes[0].appearance.fields.fill.raw.adjustment[0].angle), { _unit: "angleUnit", _value: 90 });
  assert.equal(nodes[0].appearance.fields.masks.raw.hasUserMask, false);
  assert.equal(nodes[0].appearance.fields.stroke.status, "not_returned");
});

test("font audit preserves mixed ranges and conflicting host evidence without inventing a fallback", () => {
  const report = auditDesignFonts([{ id: 2, kind: "text", text: { characterStyle: { font: "A" }, fontAvailability: "available", ranges: { textStyleRange: [
    { from: 0, to: 2, textStyle: { fontPostScriptName: "A", fontAvailable: false } },
    { from: 2, to: 5, textStyle: { fontPostScriptName: "B", fontAvailable: false } },
    { from: 5, to: 8, textStyle: { fontPostScriptName: "C" } }
  ] } } }]);
  assert.deepEqual(report.conflicting, ["A"]); assert.deepEqual(report.missing, ["B"]);
  assert.equal(report.fonts.find((font: any) => font.postScriptName === "C").status, "unknown");
  assert.deepEqual(report.fonts[1].evidence[0], { status: "missing", layerId: 2, source: "textStyleRange.fontAvailable", from: 2, to: 5 });
  assert.equal(report.installedOrReplacedFonts, false);
  assert.equal(report.unresolvedRanges.length, 1);
});

test("aggregate image budget is checked before native pixel requests and filesystem output", async () => {
  const root = await outputRoot(), host = hostFixture();
  const read = async (kind: string, payload: any) => {
    const page = await host.read(kind, payload);
    for (const layer of page.layers || []) layer.boundsNoEffects = { x: 0, y: 0, width: 3000, height: 3000 };
    return page;
  };
  await assert.rejects(exportDesignBundle(join(root, "oversized"), read, { layer_ids: [1, 2], include_reference: true, max_pixels: 8000000 }), /16 million/);
  assert(host.calls.every(call => call.kind === "document.inspect"));
  assert.deepEqual(await readdir(root), []);
});

test("registered MCP export tool produces the bundle through only read-only host messages", async () => {
  const root = await outputRoot(), host = hostFixture();
  const originalRoot = process.env.PS_MCP_DESIGN_EXPORT_DIR;
  process.env.PS_MCP_DESIGN_EXPORT_DIR = join(root, "outputs");
  const server = await PhotoshopFullMcpServer.create({ dataDir: root, exportDir: root, allowedRoots: [root], portStart: 51400, portEnd: 51401, commandTimeoutMs: 1000, approvalMode: "auto", advancedProfile: "safe", serverId: "export-contract-test", bridgeToken: "test-only-key-abcdefghijklmnopqrstuvwxyz" }, await CommandCatalog.load(), { runtimeOwner: true });
  (server as any).bridge.dispatch = async (kind: string, payload: any) => ({ ok: true, data: await host.read(kind, payload) });
  try {
    const response = await server.callTool("photoshop_design_export", { document_id: 7, layer_ids: [2], max_pixels: 100 });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent?.status, "complete");
    const directory = response.structuredContent!.directory as string;
    assert((await readdir(directory)).includes("fonts.json"));
    assert(host.calls.every(call => ["document.inspect", "design.pixels"].includes(call.kind)));
    assert(host.calls.filter(call => call.kind === "document.inspect").every(call => call.payload.include_styles === true));
  } finally {
    await server.stop();
    if (originalRoot === undefined) delete process.env.PS_MCP_DESIGN_EXPORT_DIR; else process.env.PS_MCP_DESIGN_EXPORT_DIR = originalRoot;
  }
});

function isolatedHost(options: { mismatch?: boolean; badAssetHash?: boolean; wrongReference?: boolean } = {}) {
  const host = hostFixture();
  const read = async (kind: string, payload: any) => {
    if (kind !== "design.pixels" || !payload.layer_id) return host.read(kind, payload);
    assert.equal(payload.render_mode, "isolated_composite");
    const result = pixels(payload.layer_id); result.sourceBounds = { x: 1, y: 1, width: 2, height: 1 };
    const bytes = Buffer.from(result.rawPixels, "base64"), reference = decodeDesignPixels(pixels(), 100);
    const verification = { status: options.mismatch ? "mismatch" : "matched", method: "source-over-premultiplied-sRGB", scope: "current-backdrop-asset-rectangle", bounds: result.sourceBounds, tolerance: 1, comparedPixels: 2, mismatchedPixels: options.mismatch ? 1 : 0, maxChannelDifference: options.mismatch ? 12 : 0, meanPixelMaxDifference: options.mismatch ? 6 : 0, arbitraryBackgroundVerified: false, outsideBoundsVerified: false, assetPixelSha256: options.badAssetHash ? "f".repeat(64) : createHash("sha256").update(bytes).digest("hex"), originalRoiSha256: options.wrongReference ? "f".repeat(64) : referenceRoiHash(reference.bytes, reference.metadata, result.sourceBounds), backgroundRoiSha256: "0".repeat(64) };
    return { ...result, temporaryDocument: { closed: true, originalDocumentIdsRestored: true }, rendering: { mode: "isolated-composite", implementation: "isolated-composite/1", verification } };
  };
  return { read };
}

test("isolated assets bind their proof to the reference PNG pixels and retain mismatches as unverified files", async () => {
  const root = await outputRoot();
  for (const mismatch of [false, true]) {
    const result = await exportDesignBundle(join(root, mismatch ? "mismatch" : "match"), isolatedHost({ mismatch }).read, { layer_ids: [2], render_mode: "isolated_composite", max_pixels: 100 });
    const manifest = JSON.parse(await readFile(join(result.directory, "manifest.json"), "utf8"));
    assert.equal(manifest.status, mismatch ? "partial" : "complete");
    assert.equal(manifest.assets[0].status, mismatch ? "exported_unverified" : "exported");
    assert.equal(result.assetsExported, 1); assert.equal(result.assetsUnverified, mismatch ? 1 : 0);
    assert((await readdir(join(result.directory, "assets"))).includes("layer-2.png"));
  }
});

test("tampered isolated proofs are rejected and a changed reference invalidates the bundle", async () => {
  const root = await outputRoot();
  const rejected = await exportDesignBundle(join(root, "bad-proof"), isolatedHost({ badAssetHash: true }).read, { layer_ids: [2], render_mode: "isolated_composite", max_pixels: 100 });
  assert.equal(rejected.assetsUnavailable, 1); assert.deepEqual(await readdir(join(rejected.directory, "assets")), []);
  await assert.rejects(exportDesignBundle(join(root, "bad-reference"), isolatedHost({ wrongReference: true }).read, { layer_ids: [2], render_mode: "isolated_composite", max_pixels: 100 }), (error: any) => error.code === "STALE_TARGET");
});

test("cleanup uncertainty or user cancellation stops the entire asset batch and retains diagnostic identity", async () => {
  for (const code of ["OUTCOME_UNKNOWN", "CANCELLED"] as const) {
    const root = await outputRoot(), host = hostFixture(); let assetCalls = 0;
    const read = async (kind: string, payload: any) => {
      if (kind === "design.pixels" && payload.layer_id) { assetCalls++; throw new PhotoshopMcpError(code, "Native export stopped", { temporaryDocumentId: 9 }); }
      return host.read(kind, payload);
    };
    await assert.rejects(exportDesignBundle(root, read, { layer_ids: [1, 2], include_reference: false, max_pixels: 100 }), (error: any) => error.code === code && error.details.causeDetails.temporaryDocumentId === 9);
    assert.equal(assetCalls, 1);
  }
});
