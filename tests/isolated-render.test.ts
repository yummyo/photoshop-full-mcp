import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { pluginModules } from "./helpers/uxp-harness.js";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("source-over verification preserves fractional alpha and scopes its claim to the current ROI", () => {
  const verify = pluginModules()("pixel-verify");
  const foreground = new Uint8Array([0,0,0,0, 100,0,0,128, 0,0,0,0]);
  const background = new Uint8Array([0,0,100,255, 0,0,100,255, 0,0,100,255]);
  const original = new Uint8Array([255,0,0,255, 50,0,50,255, 0,0,100,255]);
  const bounds = verify.alphaBounds(foreground, 3, 1);
  assert.deepEqual(plain(bounds), { x: 1, y: 0, width: 1, height: 1 });
  const result = verify.compareComposite(original, foreground, background, 3, 1, bounds, 1);
  assert.equal(result.status, "matched"); assert.equal(result.comparedPixels, 1);
  assert.equal(result.outsideBoundsVerified, false); assert.equal(result.arbitraryBackgroundVerified, false);
  assert.deepEqual([...verify.cropRgba(foreground, 3, 1, bounds)], [100,0,0,128]);
  original[4] = 80;
  const mismatch = verify.compareComposite(original, foreground, background, 3, 1, bounds, 1);
  assert.equal(mismatch.status, "mismatch"); assert.equal(mismatch.mismatchedPixels, 1);
  assert.throws(() => verify.compareComposite(original, foreground, background, 3, 1, bounds, 9));
  assert.equal(verify.alphaBounds(new Uint8Array(12), 3, 1), null);
});

function fixture(options: { priorOther?: boolean; wrongDuplicate?: boolean; topologyChanged?: boolean; noAutoClose?: boolean; cancelForeground?: boolean; autoCloseFails?: boolean; manualCloseFails?: boolean; clipping?: boolean; hidden?: boolean; group?: boolean; mismatch?: boolean; duplicateThrows?: boolean; propertiesChanged?: boolean } = {}) {
  const events: any[] = [], documents: any[] = [];
  let active: any, source: any, copy: any, duplicateCount = 0, disposed = 0;
  const makeLayer = (id: number, name: string, kind: string, children: any[], documentId: number, visible = true) => {
    let visibility = visible;
    return Object.freeze({ id, name, kind, layers: Object.freeze(children), isClippingMask: options.clipping && id === 2,
      get visible() { return visibility; }, set visible(value: boolean) { assert.equal(documentId, 9, "original layer visibility must never be assigned"); events.push({ type: "visibility", documentId, id, value }); visibility = value; }
    });
  };
  const close = (doc: any, automatic: boolean) => {
    assert.equal(doc.id, 9, "only the newly owned temporary document may be closed");
    if (!automatic && options.manualCloseFails) throw new Error("Simulated cleanup failure");
    events.push({ type: "close", documentId: doc.id, automatic }); documents.splice(documents.indexOf(doc), 1); active = source;
  };
  const makeDoc = (id: number, title: string, offset: number) => {
    const leaf = makeLayer(2 + offset, options.topologyChanged && id === 9 ? "wrong" : "asset", "smartObject", [], id);
    const sibling = makeLayer(3 + offset, "sibling", "pixel", [], id);
    const group = makeLayer(1 + offset, "group", "group", [leaf, sibling], id, !options.hidden);
    const backdrop = makeLayer(4 + offset, "backdrop", "pixel", [], id);
    return Object.freeze({ id, title, width: options.propertiesChanged && id === 9 ? 4 : 3, height: 1, mode: "RGB", bitsPerChannel: 8, resolution: 72, colorProfileName: "sRGB IEC61966-2.1", layers: Object.freeze([group, backdrop]), activeLayers: Object.freeze([sibling]), saved: true, activeHistoryState: Object.freeze({ id: 5 }), historyStates: Object.freeze([{}]), selection: Object.freeze({ bounds: null }),
      duplicate: async (name: string, merge: boolean) => { assert.equal(id, 7); assert.equal(merge, false); duplicateCount++; if (options.wrongDuplicate) return source; copy = makeDoc(9, name, 1000); documents.push(copy); active = copy; if (options.duplicateThrows) throw new Error("duplicate cancelled after creating owned copy"); return copy; },
      closeWithoutSaving: async () => { assert.equal(id, 9, "original document must never be closed"); close(copy, false); }
    });
  };
  source = makeDoc(7, "sample.psd", 0); const other = Object.freeze({ id: 8, title: "other.psd" });
  documents.push(source, other); active = options.priorOther ? other : source;
  const app = Object.freeze({ get documents() { return documents; }, get activeDocument() { return active; }, set activeDocument(value: any) { assert(documents.includes(value)); events.push({ type: "activate", id: value.id }); active = value; } });
  const background = new Uint8Array([0,0,100,255, 0,0,100,255, 0,0,100,255]);
  const foreground = new Uint8Array([0,0,0,0, 100,0,0,128, 0,0,0,0]);
  const original = new Uint8Array([0,0,100,255, options.mismatch ? 90 : 50,0,50,255, 0,0,100,255]);
  if (options.group) { foreground.set([0,100,0,255], 0); original.set([0,100,0,255], 0); }
  let execution: any;
  const core = { executeAsModal: async (fn: any) => {
    const registered: number[] = [];
    execution = { isCancelled: false, hostControl: options.noAutoClose ? {} : { registerAutoCloseDocument: async (id: number) => { assert.equal(id, 9); registered.push(id); events.push({ type: "register", id }); } } };
    try { return await fn(execution); }
    finally { if (!options.autoCloseFails) for (const id of registered) { const doc = documents.find(item => item.id === id); if (doc) close(doc, true); } }
  } };
  const imaging = { getPixels: async (args: any) => {
    assert.equal(args.layerID, undefined, "temporary rendering must read document composites");
    assert.equal(args.targetSize, undefined); assert.equal(args.applyAlpha, false);
    events.push({ type: "pixels", documentId: args.documentID });
    let bytes;
    if (args.documentID === 7) bytes = original;
    else {
      assert.equal(args.documentID, 9);
      const parent = copy.layers[0], target = options.group ? parent : parent.layers[0], sibling = parent.layers[1], backdrop = copy.layers[1];
      if (target.visible && !backdrop.visible && (options.group || !sibling.visible)) {
        if (options.cancelForeground) { execution.isCancelled = true; throw new Error("user cancelled temporary rendering"); }
        bytes = foreground;
      } else if (!target.visible && backdrop.visible) bytes = background;
      else throw new Error("Unexpected duplicate visibility configuration");
    }
    return { level: 0, sourceBounds: { left: 0, top: 0, right: 3, bottom: 1 }, imageData: { width: 3, height: 1, componentSize: 8, components: 4, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", getData: async () => bytes, dispose: () => { disposed++; } } };
  } };
  const capture = pluginModules({ app, core, imaging, constants: { DocumentMode: { RGB: "RGB" }, BitsPerChannelType: { EIGHT: 8 } } })("design-pixels").capture;
  return { capture: () => capture({ document_id: 7, layer_id: options.group ? 1 : 2, render_mode: "isolated_composite", max_pixels: 100 }), events, documents, active: () => active, duplicates: () => duplicateCount, disposed: () => disposed };
}

test("owned duplicate rendering remaps shifted IDs, preserves source selection and restores a previously inactive source", async () => {
  const f = fixture({ priorOther: true }), result = await f.capture();
  assert.equal(result.layerId, 2); assert.equal(result.documentId, 7);
  assert.deepEqual(plain(result.sourceBounds), { x: 1, y: 0, width: 1, height: 1 });
  assert.equal(result.rendering.verification.status, "matched");
  assert.equal(result.rendering.verification.assetPixelSha256, hash(Buffer.from(result.rawPixels, "base64")));
  assert.equal(result.temporaryDocument.closed, true); assert.equal(result.readOnlyCheck.status, "unchanged");
  assert.equal(f.active().id, 8); assert.deepEqual(f.documents.map(doc => doc.id), [7, 8]);
  assert.equal(f.disposed(), 3);
  assert(f.events.filter(event => event.type === "visibility").every(event => event.documentId === 9));
});

test("group subtrees retain their internal visibility and mismatch evidence is returned without claiming fidelity", async () => {
  const group = await fixture({ group: true }).capture();
  assert.deepEqual(plain(group.sourceBounds), { x: 0, y: 0, width: 2, height: 1 });
  assert.equal(group.rendering.verification.status, "matched");
  const mismatch = await fixture({ mismatch: true }).capture();
  assert.equal(mismatch.rendering.verification.status, "mismatch");
  assert.equal(mismatch.rendering.verification.arbitraryBackgroundVerified, false);
});

test("invalid ownership, hidden/clipped targets and absent auto-close support never edit or close user documents", async () => {
  for (const options of [{ wrongDuplicate: true }, { noAutoClose: true }, { clipping: true }, { hidden: true }]) {
    const f = fixture(options);
    await assert.rejects(f.capture());
    assert.deepEqual(f.documents.map(doc => doc.id), [7, 8]);
    assert.equal(f.events.filter(event => event.type === "visibility" || event.type === "close" || event.type === "register").length, 0);
  }
});

test("topology errors and cancellation close the owned copy; failed auto-close has a bounded manual fallback", async () => {
  for (const options of [{ topologyChanged: true }, { cancelForeground: true }, { duplicateThrows: true }, { propertiesChanged: true }]) {
    const f = fixture(options); await assert.rejects(f.capture());
    assert.deepEqual(f.documents.map(doc => doc.id), [7, 8]);
    assert(f.events.some(event => event.type === "close" && event.automatic));
  }
  const fallback = fixture({ autoCloseFails: true });
  assert.equal((await fallback.capture()).temporaryDocument.closed, true);
  assert(fallback.events.some(event => event.type === "close" && !event.automatic));
  const failure = fixture({ autoCloseFails: true, manualCloseFails: true });
  await assert.rejects(failure.capture(), (error: any) => error.code === "OUTCOME_UNKNOWN" && error.details.temporaryDocumentId === 9);
  assert.equal(failure.documents[0].id, 7);
});
