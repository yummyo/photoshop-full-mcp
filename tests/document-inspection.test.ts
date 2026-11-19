import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { pluginModules } from "./helpers/uxp-harness.js";
import { PhotoshopFullMcpServer } from "../src/server.js";
import { CommandCatalog } from "../src/catalog.js";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function fixture(options: { missingGeometry?: boolean; textContents?: string; rangeCount?: number; missingGroupChildren?: boolean; nullParagraphStyle?: boolean } = {}) {
  const state = { historyId: 5, saved: true, descriptorFailure: false, changeDuringRead: false };
  const box = (left: number, top: number, right: number, bottom: number) => Object.freeze({ left, top, right, bottom });
  const make = (id: number, kind: string, extra: any = {}) => Object.freeze({ id, kind, name: "duplicate name", visible: true, opacity: 100, fillOpacity: 100, blendMode: "normal", allLocked: false, isClippingMask: false,
    bounds: box(-7, -12, 42, 12), boundsNoEffects: box(-5, -10, 40, 10), ...extra });
  const text = make(2, "text", { ...(options.missingGeometry ? { bounds: undefined, boundsNoEffects: undefined, blendMode: undefined } : {}), textItem: Object.freeze({ contents: options.textContents ?? "示例文本\n文字", isPointText: false, isParagraphText: true,
    characterStyle: Object.freeze({ font: "Test-Regular", size: 36, leading: 40, tracking: 25, fauxBold: false, fauxItalic: true, horizontalScale: 100, verticalScale: 100, baselineShift: 0, useAutoLeading: false, antiAliasMethod: "sharp", color: { rgb: { red: 12, green: 34, blue: 56 } } }),
    paragraphStyle: Object.freeze({ justification: "center", hyphenation: false, firstLineIndent: 0, leftIndent: options.nullParagraphStyle ? null : 1, rightIndent: 2, spaceBefore: 0, spaceAfter: 3 }) }) });
  const pixel = make(3, "normal");
  const hiddenChild = make(5, "normal");
  const group = make(1, "group", { boundsNoEffects: box(-10, -20, 100, 100), layers: options.missingGroupChildren ? undefined : Object.freeze([text, pixel]) });
  const hidden = make(4, "group", { visible: false, layers: Object.freeze([hiddenChild]) });
  const doc = Object.freeze({ id: 7, title: "sample.psd", width: 1920, height: 1080, resolution: 144, mode: "RGBColorMode", bitsPerChannel: "eight", colorProfileName: "sRGB", layers: Object.freeze([group, hidden]), activeLayers: Object.freeze([text]),
    get saved() { return state.saved; }, get activeHistoryState() { return { id: state.historyId }; }, historyStates: Object.freeze([{}, {}, {}, {}, {}]), selection: Object.freeze({ bounds: null }) });
  const other = Object.freeze({ ...doc, id: 8 });
  const app = Object.freeze({ get activeDocument() { return doc; }, documents: Object.freeze([doc, other]), fonts: Object.freeze([{ postScriptName: "Test-Regular" }]) });
  const calls: any[] = [];
  const action = { batchPlay: async (descriptors: any[], batchOptions: any) => {
    calls.push({ descriptors, options: batchOptions });
    if (state.descriptorFailure) throw new Error("Text ranges unavailable in fixture");
    if (state.changeDuringRead) state.historyId++;
    return descriptors.map(descriptor => {
      assert.equal(descriptor._obj, "get", "inspection may only issue get actions");
      assert.equal(descriptor._target[0]._property, "textKey");
      assert.equal(descriptor._target[1]._ref, "layer");
      assert(descriptor._target[1]._id > 0);
      assert.equal(descriptor._target[2]._ref, "document");
      const ranges = [{ from: 0, to: 2, textStyle: { fontPostScriptName: "Test-Regular", size: { _unit: "pointsUnit", _value: 18 } } }, { from: 2, to: 6, textStyle: { fontPostScriptName: "Test-Bold", size: { _unit: "pointsUnit", _value: 24 } } }];
      return { textKey: { textStyleRange: options.rangeCount ? Array.from({ length: options.rangeCount }, (_, index) => ranges[index % 2]) : ranges, paragraphStyleRange: [{ from: 0, to: 6, paragraphStyle: { align: "center" } }], transform: { xx: 1, xy: 0, yx: 0, yy: 1, tx: 3, ty: 4 } } };
    });
  } };
  const load = pluginModules({ app, action, core: { executeAsModal: () => { throw new Error("Inspection must not activate a modal editing scope"); } } });
  return { state, doc, app, calls, inspect: load("inspection").inspect, resolveTarget: load("targets").resolveTarget };
}

test("compatibility crypto matches independent Node digests without WebCrypto globals or Node imports", async () => {
  const load = pluginModules(), compat = load("crypto-compat"), bridge = load("bridge");
  const bytes = new Uint8Array([255, 0, 1, 2, 128]);
  assert.equal(compat.base64(bytes.subarray(1, 4)), Buffer.from(bytes.subarray(1, 4)).toString("base64"));
  assert.equal(compat.sha256Hex(bytes.buffer), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(compat.sha256Hex("示例文本"), createHash("sha256").update("示例文本").digest("hex"));
  assert.equal(compat.base64("示例文本🙂"), Buffer.from("示例文本🙂").toString("base64"));
  assert.equal(compat.utf8ByteLength("示例文本🙂"), Buffer.byteLength("示例文本🙂"));
  for (const protocol of ["ps-mcp-bridge/3", "ps-mcp-bridge/4"]) {
    const fields = [protocol, "test-server", "38452", "2", "challenge-123"];
    if (protocol.endsWith("/4")) fields.push("owner-generation-test", "ps-mcp-executor/1");
    assert.equal(await bridge.discoveryProof("test-key", protocol, "test-server", 38452, 2, "challenge-123", "owner-generation-test", "ps-mcp-executor/1"), createHmac("sha256", "test-key").update(fields.join("\n")).digest("base64url"));
  }
});

test("authenticated discovery rejects tampered, wrong-key and wrong-owner proofs", async () => {
  let mode = "valid";
  const protocol = "ps-mcp-bridge/4";
  const bridge = pluginModules({}, { fetch: async (url: string) => {
    const parsed = new URL(url), challenge = parsed.searchParams.get("challenge");
    const fields = [protocol, "test-server", parsed.port, "2", challenge, mode === "owner" ? "tampered-owner" : "owner-generation-test", "ps-mcp-executor/1"];
    const proof = createHmac("sha256", mode === "key" ? "wrong-key" : "test-key").update(fields.join("\n")).digest("base64url");
    return { ok: true, text: async () => JSON.stringify({ protocol, serverId: "test-server", port: Number(parsed.port), secretGeneration: 2, ownerGeneration: "owner-generation-test", executionProtocol: "ps-mcp-executor/1", proof: mode === "proof" ? `${proof}x` : proof }) };
  } })("bridge");
  assert.equal((await bridge.probe(38452, "test-key")).legacy, false);
  for (mode of ["proof", "key", "owner"]) assert.equal(await bridge.probe(38452, "test-key"), null);
});

test("inspection reconstructs hierarchy and distinguishes top-level count from recursive total", async () => {
  const { inspect, calls } = fixture();
  const result = await inspect({ include_text: false });
  assert.equal(result.schemaVersion, "photoshop.design/1");
  assert.deepEqual(plain(result.counts), { topLevelCount: 2, totalNodeCount: 5, groupCount: 2, leafCount: 3, matchedCount: 5 });
  assert.deepEqual(plain(result.layers.map((node: any) => [node.id, node.parentId, node.depth, node.children])), [[1, null, 0, [2, 3]], [2, 1, 1, []], [3, 1, 1, []], [4, null, 0, [5]], [5, 4, 1, []]]);
  assert.equal(result.layers[1].bounds.x, -7);
  assert.equal(result.layers[1].boundsNoEffects.x, -5);
  assert.deepEqual(plain(result.layers[1].positionInParent), { x: 5, y: 10, basis: "boundsNoEffects" });
  assert.equal(result.readOnlyCheck.status, "unchanged");
  assert.equal(calls.length, 0);
});

test("pages preserve revision identity and reject changed documents or options", async () => {
  const { inspect, state } = fixture();
  const first = await inspect({ limit: 2, include_text: false });
  const second = await inspect({ limit: 2, include_text: false, cursor: first.page.nextCursor });
  const last = await inspect({ limit: 2, include_text: false, cursor: second.page.nextCursor });
  assert.deepEqual(plain([...first.layers, ...second.layers, ...last.layers].map(node => node.id)), [1, 2, 3, 4, 5]);
  assert.equal(last.page.nextCursor, null);
  await assert.rejects(inspect({ limit: 2, cursor: first.page.nextCursor }), (error: any) => error.code === "STALE_TARGET");
  state.historyId++;
  await assert.rejects(inspect({ limit: 2, include_text: false, cursor: first.page.nextCursor }), (error: any) => error.code === "STALE_TARGET");
});

test("text inspection retains mixed runs, source units and font availability without changing selection", async () => {
  const { inspect, doc, calls } = fixture();
  const result = await inspect({ layer_ids: [2] });
  assert.equal(result.layers[0].text.contents, "示例文本\n文字");
  assert.equal(result.layers[0].text.characterStyle.font, "Test-Regular");
  assert.equal(result.layers[0].text.characterStyle.size, 36);
  assert.equal(result.layers[0].text.characterStyle.color.hex, "0c2238");
  assert.equal(result.layers[0].text.fontAvailability, "available");
  assert.equal(result.layers[0].text.ranges.textStyleRange.length, 2);
  assert.equal(result.layers[0].text.ranges.bounds, null);
  assert.match(result.layers[0].text.ranges.unavailableFields.bounds, /not present/);
  assert.deepEqual(plain(result.layers[0].text.ranges.textStyleRange[1].textStyle.size), { _unit: "pointsUnit", _value: 24 });
  assert.equal(calls.length, 1);
  assert.deepEqual(doc.activeLayers.map(layer => layer.id), [2]);
  assert.equal(doc.saved, true);
  assert.deepEqual(plain(result.readOnlyCheck.before), plain(result.readOnlyCheck.after));
});

test("hidden ancestors and inactive document targets do not require selecting a layer or document", async () => {
  const { inspect, app } = fixture();
  const visible = await inspect({ include_hidden: false, include_text: false });
  assert.deepEqual(plain(visible.layers.map((node: any) => node.id)), [1, 2, 3]);
  const hidden = await inspect({ document_id: 8, layer_ids: [5], include_text: false });
  assert.equal(hidden.document.id, 8);
  assert.equal(hidden.layers[0].effectiveVisible, false);
  assert.equal(app.activeDocument.id, 7);
  assert.equal(hidden.readOnlyCheck.status, "unchanged");
});

test("implicit null and omitted targets resolve the active document without activating it", () => {
  const { resolveTarget, app, doc } = fixture();
  assert.equal(resolveTarget(null).document, doc);
  assert.equal(resolveTarget(undefined).document, doc);
  assert.equal(resolveTarget({ documentId: 8 }).document.id, 8);
  assert.equal(app.activeDocument.id, 7);
});

test("unavailable text ranges are explicit and a concurrent document edit invalidates inspection", async () => {
  const { inspect, state } = fixture();
  state.descriptorFailure = true;
  const unavailable = await inspect({ layer_ids: [2] });
  assert.equal(unavailable.layers[0].text.ranges.status, "unavailable");
  assert.match(unavailable.layers[0].text.ranges.reason, /unavailable/);
  state.descriptorFailure = false; state.changeDuringRead = true;
  await assert.rejects(inspect({ layer_ids: [2] }), (error: any) => error.code === "STALE_TARGET");
});

test("invalid IDs, options and cursors fail before any host action", async () => {
  const { inspect, calls } = fixture();
  for (const options of [{ limit: 0 }, { limit: 501 }, { layer_ids: [2, 2] }, { cursor: "invalid" }, { include_hidden: "false" }, { arbitrary_write: true }]) {
    await assert.rejects(inspect(options), (error: any) => error.code === "PRECONDITION_FAILED");
  }
  await assert.rejects(inspect({ layer_ids: [999] }), (error: any) => error.code === "STALE_TARGET");
  await assert.rejects(inspect({ document_id: 999 }), (error: any) => error.code === "NO_DOCUMENT");
  assert.equal(calls.length, 0);
});

test("missing geometry is explicit and an unreadable group cannot masquerade as a complete tree", async () => {
  const result = await fixture({ missingGeometry: true }).inspect({ layer_ids: [2], include_text: false });
  const layer = result.layers[0];
  for (const field of ["bounds", "boundsNoEffects", "positionInParent", "blendMode"]) {
    assert.equal(layer[field], null);
    assert.equal(typeof layer.unavailableFields[field], "string");
  }
  await assert.rejects(fixture({ missingGroupChildren: true }).inspect(), (error: any) => error.code === "HOST_ERROR");
});

test("oversized text and range lists report truncation instead of claiming complete data", async () => {
  const result = await fixture({ textContents: "文".repeat(200001), rangeCount: 2001 }).inspect({ layer_ids: [2] });
  const text = result.layers[0].text;
  assert.equal(text.contents.length, 200000);
  assert.equal(text.contentsTruncated, true);
  assert.equal(text.ranges.textStyleRange.length, 2000);
  assert.deepEqual(plain(text.ranges.truncatedFields), ["descriptor.textStyleRange"]);
  assert(result.warnings.some((message: string) => message.includes("truncated")));
});

test("null host styles retain an explicit reason instead of silently appearing complete", async () => {
  const result = await fixture({ nullParagraphStyle: true }).inspect({ layer_ids: [2], include_text_runs: false });
  assert.equal(result.layers[0].text.paragraphStyle.leftIndent, null);
  assert.match(result.layers[0].text.unavailableFields["paragraphStyle.leftIndent"], /unset, mixed, or not applicable/);
});

test("MCP exposes inspection as a strictly validated read-only tool and forwards defaults", async () => {
  const dataDir = resolve(".cache/inspection-contract-test");
  const server = await PhotoshopFullMcpServer.create({ dataDir, exportDir: resolve(dataDir, "exports"), allowedRoots: [dataDir], portStart: 51400, portEnd: 51401, commandTimeoutMs: 1000, approvalMode: "auto", advancedProfile: "safe", serverId: "inspection-test", bridgeToken: "test-only-key-abcdefghijklmnopqrstuvwxyz" }, await CommandCatalog.load(), { runtimeOwner: true });
  const calls: any[] = [];
  (server as any).bridge.dispatch = async (kind: string, payload: unknown) => {
    calls.push({ kind, payload });
    return { ok: true, data: { schemaVersion: "photoshop.design/1", layers: [] } };
  };
  try {
    assert.equal((server as any).bridge.status().protocol, "ps-mcp-bridge/4", "status must match authenticated v4 discovery");
    const tool = server.listToolDefinitions().find(tool => tool.name === "photoshop_document_inspect")!;
    assert(tool); assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.annotations?.destructiveHint, false);
    const exportTool = server.listToolDefinitions().find(tool => tool.name === "photoshop_design_export")!;
    assert(exportTool); assert.equal(exportTool.annotations?.readOnlyHint, false); assert.equal(exportTool.annotations?.destructiveHint, false);
    assert.equal((await server.callTool(exportTool.name, { layer_ids: [2, 2] })).isError, true);
    assert.equal((await server.callTool(exportTool.name, { render_mode: "arbitrary" })).isError, true);
    assert.equal((await server.callTool(exportTool.name, { pixel_tolerance: -1 })).isError, true);
    const invalid = await server.callTool(tool.name, { limit: 501 });
    assert.equal(invalid.isError, true); assert.equal(calls.length, 0);
    const result = await server.callTool(tool.name, { document_id: 7, layer_ids: [2] });
    assert.equal(result.isError, undefined);
    assert.equal(calls[0].kind, "document.inspect");
    assert.deepEqual(calls[0].payload, { document_id: 7, layer_ids: [2], include_hidden: true, include_text: true, include_text_runs: true, include_styles: false, limit: 100 });
  } finally { await server.stop(); }
});
