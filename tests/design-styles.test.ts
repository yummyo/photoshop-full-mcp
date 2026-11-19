import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDesignStyles } from "../src/design-styles.js";

const doc = { mode: "RGBColorMode", colorProfileName: "sRGB IEC61966-2.1", resolutionPpi: 72 };
const pct = (n: number) => ({ _unit: "percentUnit", _value: n });
const px = (n: number) => ({ _unit: "pixelsUnit", _value: n });
const angle = (n: number) => ({ _unit: "angleUnit", _value: n });
const en = (v: string) => ({ _enum: "fixture", _value: v });
const rgb = { _obj: "RGBColor", red: 12, grain: 34, blue: 56 };
function layer(groups: Record<string, any> = {}, extra: Record<string, any> = {}): any {
  return { id: 1, parentId: null, name: "shape", opacity: 50, fillOpacity: 100, blendMode: "normal", isClippingMask: false,
    appearance: { status: "available", fields: Object.fromEntries(Object.entries(groups).map(([name, raw]) => [name, { status: "available", raw }])), truncatedFields: [] }, ...extra };
}
const one = (l: any, d = doc) => normalizeDesignStyles([l], d).layers[0];
const hints = (result: any, property: string) => result.cssHints.filter((h: any) => h.property === property);
function gradient() {
  return { _obj: "gradientLayer", type: en("linear"), angle: angle(90), reverse: false, align: true, dither: false, scale: pct(100), offset: { horizontal: pct(0), vertical: pct(0) }, gradient: {
    gradientForm: en("customStops"), colors: [0, 4096].map((location, i) => ({ location, midpoint: 50, type: en("userStop"), color: { ...rgb, red: i * 255 } })),
    transparency: [0, 4096].map((location, i) => ({ location, midpoint: 50, opacity: pct(i ? 100 : 0) }))
  } };
}
function shadow() { return { enabled: true, present: true, showInDialog: true, color: rgb, opacity: pct(50), distance: px(10), blur: px(8), chokeMatte: pct(0), useGlobalAngle: false, localLightingAngle: angle(90), mode: en("normal"), noise: pct(0), antiAlias: false, transferSpec: { _obj: "shapeCurveType", name: "Linear" } }; }

test("solid colors retain RGB precision and DOM opacity without conflating fill opacity or descriptor bytes", () => {
  const input = layer({ fill: { adjustment: [{ _obj: "solidColorLayer", color: rgb }] }, compositing: { opacity: 128 } }, { fillOpacity: 40 });
  const before = structuredClone(input), result = one(input);
  assert.deepEqual(result.fill.color, { space: "document-rgb", red: 12, green: 34, blue: 56 });
  assert.equal(hints(result, "background-color")[0].value, "rgba(12, 34, 56, 1)");
  assert.equal(hints(result, "opacity")[0].value, "0.5");
  assert(result.issues.some((i: any) => i.code === "FILL_OPACITY_SEPARATE"));
  assert.deepEqual(input, before);
  for (const h of result.cssHints) { assert.equal(h.approximate, true); assert(h.source.startsWith("design.json#/layers/0/")); }
});

test("unverified profiles, other color models, invalid channels and ambiguous aliases never generate color CSS", () => {
  const solid = (c: any) => layer({ fill: { adjustment: [{ _obj: "solidColorLayer", color: c }] } });
  const profile = one(solid(rgb), { ...doc, colorProfileName: "Adobe RGB (1998)" });
  assert.equal(profile.fill.status, "parsed"); assert.equal(hints(profile, "background-color").length, 0);
  for (const c of [{ _obj: "CMYKColor", cyan: 10 }, { ...rgb, red: NaN }, { ...rgb, red: 256 }, { ...rgb, green: 35 }]) {
    const result = one(solid(c)); assert.equal(result.fill.status, "unsupported"); assert.equal(hints(result, "background-color").length, 0);
  }
});

test("linear gradients bind color and alpha stops and convert directional angles with explicit limitations", () => {
  const result = one(layer({ fill: { adjustment: [gradient()] } }));
  assert.equal(result.fill.angleDegrees, 90); assert.equal(result.fill.cssAngleDegrees, 0);
  assert.equal(hints(result, "background-image")[0].value, "linear-gradient(0deg, rgba(0, 34, 56, 0) 0%, rgba(255, 34, 56, 1) 100%)");
  assert.match(hints(result, "background-image")[0].reason, /extent\/interpolation/);
});

test("nonlinear midpoint, separate alpha curves, reversed and scaled gradients withhold CSS instead of flattening", () => {
  for (const modify of [
    (g: any) => { g.gradient.colors[0].midpoint = 25; },
    (g: any) => { g.gradient.transparency.splice(1, 0, { location: 2048, midpoint: 50, opacity: pct(90) }); },
    (g: any) => { g.reverse = true; }, (g: any) => { g.scale = pct(80); },
    (g: any) => { g.type = en("radial"); }, (g: any) => { g.dither = true; },
    (g: any) => { g.scale = pct(150); g.offset.horizontal = pct(-25); }
  ]) { const g = gradient(); modify(g); const result = one(layer({ fill: { adjustment: [g] } })); assert.equal(result.fill.status, "parsed"); assert.equal(hints(result, "background-image").length, 0); }
  const g = gradient(); g.gradient.colors.reverse(); assert.equal(one(layer({ fill: { adjustment: [g] } })).fill.status, "unsupported");
});

test("stroke candidates require explicit pixel units, inside alignment, normal blending and no dash", () => {
  const s = { strokeEnabled: true, strokeStyleLineWidth: px(2), strokeStyleContent: { color: rgb }, strokeStyleOpacity: pct(75), strokeStyleLineAlignment: en("strokeStyleAlignInside"), strokeStyleBlendMode: en("normal"), strokeStyleLineDashSet: [] };
  const run = (v: any) => one(layer({ stroke: { AGMStrokeStyleInfo: v } }));
  assert.equal(hints(run(s), "border")[0].value, "2px solid rgba(12, 34, 56, 0.75)");
  assert.equal(run({ ...s, strokeEnabled: false }).stroke.status, "disabled");
  assert.equal(run({ ...s, strokeStyleLineWidth: { _unit: "pointsUnit", _value: 2 } }).stroke.status, "unsupported");
  assert.equal(hints(run({ ...s, strokeStyleLineDashSet: [px(3)] }), "border").length, 0);
  assert.equal(hints(run({ ...s, strokeStyleLineAlignment: en("strokeStyleAlignOutside") }), "border").length, 0);
});

test("shadow offsets preserve local/global angles, inner/outer identity and independent multiple effects", () => {
  const first = shadow(), second = { ...shadow(), useGlobalAngle: true };
  const result = one(layer({ effects: { layerFXVisible: true, globalLightingAngle: 0, layerEffects: { scale: pct(100), dropShadowMulti: [first, second], innerShadow: first } } }));
  assert.equal(result.shadows.items.length, 3);
  assert.deepEqual(result.shadows.items.map((s: any) => s.offsetPx), [{ x: 0, y: 10 }, { x: -10, y: 0 }, { x: 0, y: 10 }]);
  assert.equal(result.shadows.items[2].inset, true); assert.equal(hints(result, "box-shadow").length, 3);
  assert(hints(result, "box-shadow")[2].value.startsWith("inset "));
  const missing = one(layer({ effects: { layerFXVisible: true, layerEffects: { scale: pct(100), dropShadow: second } } }));
  assert.equal(missing.shadows.status, "partial"); assert.equal(hints(missing, "box-shadow").length, 0);
});

test("spread, contour, effect scale and unsupported effects remain review items instead of approximate certification", () => {
  for (const update of [{ noise: pct(10) }, { chokeMatte: pct(20) }, { mode: en("multiply") }, { transferSpec: { _obj: "shapeCurveType", name: "Custom", curve: [1, 2] } }]) {
    const result = one(layer({ effects: { layerFXVisible: true, layerEffects: { scale: pct(100), dropShadow: { ...shadow(), ...update }, outerGlow: { enabled: true } } } }));
    assert.equal(result.shadows.items[0].status, "parsed"); assert.equal(hints(result, "box-shadow").length, 0);
    assert(result.issues.some((i: any) => i.code === "EFFECT_NOT_CONVERTED")); assert.equal(result.rasterReviewRecommended, true);
  }
  const scale = one(layer({ effects: { layerFXVisible: true, layerEffects: { scale: pct(150), dropShadow: shadow() } } }));
  assert.equal(scale.shadows.items[0].effectScalePercent, 150); assert.equal(hints(scale, "box-shadow").length, 0);
});

test("missing, disabled, unrequested and truncated descriptors are distinct; masks and ancestor dependencies stay visible", () => {
  const l = layer({ effects: { layerFXVisible: false }, masks: { hasUserMask: true } }, { parentId: 2, isClippingMask: true });
  const parent = layer({}, { id: 2, blendMode: "multiply" });
  const result = normalizeDesignStyles([l, parent], doc).layers[0];
  assert.equal(result.fill.status, "not_returned"); assert.equal(result.shadows.status, "disabled");
  assert.equal(one(layer({ effects: { layerEffects: { masterFXSwitch: false, outerGlow: { enabled: true } } } })).shadows.status, "disabled");
  for (const code of ["MASK_REQUIRES_REVIEW", "CLIPPING_DEPENDENCY", "BLEND_REQUIRES_REVIEW"]) assert(result.issues.some((i: any) => i.code === code));
  l.appearance.truncatedFields = ["appearance.fill.adjustment"];
  assert.equal(one(l).fill.status, "unsupported");
  assert.equal(normalizeDesignStyles([l], doc, false).layers[0].fill.status, "not_requested");
  assert.equal(one({ ...l, appearance: undefined }).fill.status, "unavailable");
  const cyclic = normalizeDesignStyles([{ ...l, parentId: 1 }], doc).layers[0]; assert(cyclic.issues.some((i: any) => i.code === "ANCESTRY_UNRESOLVED"));
  assert.equal(normalizeDesignStyles([l], doc).cssHintsAreCompleteStyles, false);
});
