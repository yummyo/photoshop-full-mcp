/** Conservative, offline interpretation of captured descriptors. Never issues host commands. */
type Data = Record<string, any>;
type Hint = { property: string; value: string; source: string; approximate: true; reason: string };
const obj = (v: any): v is Data => !!v && typeof v === "object" && !Array.isArray(v);
const numeric = (v: any, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw Error(`Expected a finite number in ${min}..${max}`);
  return v;
};
const unit = (v: any, expected: string, min = -1e6, max = 1e6) => {
  if (!obj(v) || v._unit !== expected) throw Error(`Expected explicit ${expected}; no implicit unit conversion`);
  return numeric(v._value, min, max);
};
const token = (v: any) => obj(v) && typeof v._value === "string" ? v._value : undefined;
const round = (v: number) => Math.round(v * 10000) / 10000 || 0;
const percent = (v: any) => unit(v, "percentUnit", 0, 100);
const color = (v: any) => {
  if (!obj(v) || v._obj !== "RGBColor") throw Error("Only explicit RGBColor is interpreted; other color models need host conversion");
  const g = v.grain ?? v.green;
  if (v.grain !== undefined && v.green !== undefined && v.grain !== v.green) throw Error("Conflicting green channel aliases");
  return { space: "document-rgb", red: numeric(v.red, 0, 255), green: numeric(g, 0, 255), blue: numeric(v.blue, 0, 255) };
};
const cssColor = (c: ReturnType<typeof color>, alpha = 1) => `rgba(${round(c.red)}, ${round(c.green)}, ${round(c.blue)}, ${round(alpha)})`;
const unavailable = (status: string, reason: string) => ({ status, reason });
function attempt(fn: () => Data): Data { try { return { status: "parsed", ...fn() }; } catch (e) { return unavailable("unsupported", e instanceof Error ? e.message : String(e)); } }

/** CSS hints are individual suggestions, never an assembled or visually certified style. */
export function normalizeDesignStyles(layers: Data[], document: Data, requested = true): Data {
  const byId = new Map(layers.map(layer => [layer.id, layer]));
  const srgb = document.colorProfileName === "sRGB IEC61966-2.1" && ["RGB", "RGBColorMode"].includes(document.mode);
  const normalized = layers.map((layer, layerIndex) => {
    const hints: Hint[] = [], issues: Data[] = [];
    const source = (field: string) => `design.json#/layers/${layerIndex}/${field}`;
    const hint = (property: string, value: string, path: string, reason: string) => hints.push({ property, value, source: source(path), approximate: true, reason });
    const appearance = layer.appearance;
    if (requested && appearance?.status !== "available") issues.push({ code: "APPEARANCE_UNAVAILABLE", reason: appearance?.reason || "No appearance descriptor captured" });
    const field = (name: string): Data => {
      if (!requested) return unavailable("not_requested", "include_styles was false");
      if (appearance?.status !== "available") return unavailable("unavailable", appearance?.reason || "No appearance descriptor captured");
      if (appearance.truncatedFields?.length) return unavailable("unsupported", "Appearance was truncated; do not interpret an incomplete descriptor");
      const group = appearance.fields?.[name];
      if (group?.status !== "available" || !obj(group.raw)) return unavailable(group?.status || "not_returned", group?.reason || "Host did not return this field; absence is not proof of no effect");
      return group.raw;
    };
    const parseGroup = (name: string, fn: (raw: Data) => Data) => {
      const raw = field(name); return typeof raw.status === "string" ? raw : attempt(() => fn(raw));
    };
    if (!srgb) issues.push({ code: "COLOR_PROFILE_UNVERIFIED", reason: "Document RGB values are preserved; CSS color hints require confirmed sRGB RGB mode" });
    const opacity = typeof layer.opacity === "number" && Number.isFinite(layer.opacity) && layer.opacity >= 0 && layer.opacity <= 100
      ? { status: "parsed", percent: layer.opacity, unitInterval: layer.opacity / 100, source: source("opacity") }
      : unavailable("unavailable", "No valid DOM percentage opacity");
    // Keep DOM opacity separate from descriptor opacity (which can be byte-based).
    if (opacity.status === "parsed") hint("opacity", String(round(layer.opacity / 100)), "opacity", "Apply once to the corresponding element/group; do not multiply ancestors or fill opacity again");
    if (typeof layer.fillOpacity !== "number" || !Number.isFinite(layer.fillOpacity) || layer.fillOpacity < 0 || layer.fillOpacity > 100) issues.push({ code: "FILL_OPACITY_UNKNOWN" });
    else if (layer.fillOpacity !== 100) issues.push({ code: "FILL_OPACITY_SEPARATE", percent: layer.fillOpacity, reason: "Photoshop fill opacity is not CSS element opacity" });
    const fill = parseGroup("fill", raw => {
      if (!Array.isArray(raw.adjustment) || raw.adjustment.length !== 1) throw Error("Expected a single fill adjustment; no stacking inference");
      const value = raw.adjustment[0], path = "appearance/fields/fill/raw/adjustment/0";
      if (value?._obj === "solidColorLayer") {
        const rgb = color(value.color);
        if (srgb) hint("background-color", cssColor(rgb), path, "Requires the correct shape, masks and separate fill opacity; not certified as a rectangle");
        return { type: "solid", color: rgb, source: source(path) };
      }
      if (value?._obj !== "gradientLayer") throw Error("Adjustment is not a supported solid or gradient fill");
      const gradient = value.gradient;
      if (!obj(gradient) || token(gradient.gradientForm) !== "customStops") throw Error("Only explicit custom-stop gradients are interpreted");
      if (!Array.isArray(gradient.colors) || gradient.colors.length < 2 || gradient.colors.length > 64 || !Array.isArray(gradient.transparency) || gradient.transparency.length < 2 || gradient.transparency.length > 64) throw Error("Missing or over-budget gradient stops");
      const stops = gradient.colors.map((s: Data) => {
        if (token(s.type) !== "userStop") throw Error("Dynamic foreground/background gradient colors cannot be resolved offline");
        return { location: numeric(s.location, 0, 4096), midpoint: numeric(s.midpoint, 0, 100), color: color(s.color) };
      });
      const alpha = gradient.transparency.map((s: Data) => ({ location: numeric(s.location, 0, 4096), midpoint: numeric(s.midpoint, 0, 100), opacityPercent: percent(s.opacity) }));
      for (const values of [stops, alpha]) for (let i = 1; i < values.length; i++) if (values[i]!.location < values[i - 1]!.location) throw Error("Gradient stops are not ordered");
      const angle = unit(value.angle, "angleUnit", -360, 360), kind = token(value.type);
      const scale = value.scale === undefined ? null : unit(value.scale, "percentUnit", 0, 1000);
      const offset = obj(value.offset) ? { horizontalPercent: unit(value.offset.horizontal, "percentUnit", -1000, 1000), verticalPercent: unit(value.offset.vertical, "percentUnit", -1000, 1000) } : null;
      const cssAngle = round(((90 - angle) % 360 + 360) % 360);
      const alphaFor = (location: number) => alpha.find(s => s.location === location)?.opacityPercent;
      const alignedAlpha = stops.length === alpha.length && stops.every((s, i) => s.location === alpha[i]!.location);
      const uniformAlpha = alpha.every(s => s.opacityPercent === alpha[0]!.opacityPercent);
      const cssEligible = kind === "linear" && value.reverse === false && value.align === true && value.dither === false
        && scale === 100 && offset?.horizontalPercent === 0 && offset?.verticalPercent === 0
        && stops.every(s => s.midpoint === 50) && alpha.every(s => s.midpoint === 50) && (alignedAlpha || uniformAlpha)
        && stops[0]!.location === 0 && stops.at(-1)!.location === 4096 && alpha[0]!.location === 0 && alpha.at(-1)!.location === 4096;
      if (cssEligible && srgb) hint("background-image", `linear-gradient(${cssAngle}deg, ${stops.map(s => `${cssColor(s.color, (uniformAlpha ? alpha[0]!.opacityPercent : alphaFor(s.location)!) / 100)} ${round(s.location / 4096 * 100)}%`).join(", ")})`, path, "Angle/stops candidate only; Photoshop and CSS gradient extent/interpolation require visual comparison");
      if (!cssEligible) issues.push({ code: "GRADIENT_CSS_WITHHELD", reason: "Only explicit, unscaled, aligned linear gradients with neutral midpoints and compatible alpha stops get a CSS hint" });
      return { type: "gradient", gradientType: kind ?? null, angleDegrees: angle, cssAngleDegrees: cssAngle, colorStops: stops, transparencyStops: alpha, reverse: value.reverse ?? null, scalePercent: scale, offset, source: source(path) };
    });
    const stroke = parseGroup("stroke", raw => {
      const v = raw.AGMStrokeStyleInfo ?? raw.AGMStrokeStyle;
      if (!obj(v)) throw Error("No supported vector stroke descriptor");
      if (v.strokeEnabled === false) return { status: "disabled", source: source("appearance/fields/stroke") };
      if (v.strokeEnabled !== true) throw Error("Stroke enabled state is not explicit");
      const width = unit(v.strokeStyleLineWidth, "pixelsUnit", 0), rgb = color(v.strokeStyleContent?.color), alpha = percent(v.strokeStyleOpacity) / 100;
      const alignment = token(v.strokeStyleLineAlignment), mode = token(v.strokeStyleBlendMode);
      if (mode === "normal" && alignment === "strokeStyleAlignInside" && Array.isArray(v.strokeStyleLineDashSet) && !v.strokeStyleLineDashSet.length && srgb)
        hint("border", `${round(width)}px solid ${cssColor(rgb, alpha)}`, "appearance/fields/stroke", "Inside-stroke candidate for border-box geometry; actual vector path, joins and masks still need validation");
      else issues.push({ code: "STROKE_CSS_WITHHELD", reason: "Dashed, non-normal, unknown or non-inside stroke requires geometry/compositing review" });
      return { widthPx: width, color: rgb, opacity: alpha, alignment: alignment ?? null, blendMode: mode ?? null, source: source("appearance/fields/stroke") };
    });
    const shadows = parseGroup("effects", raw => {
      if (raw.layerFXVisible === false) return { status: "disabled", source: source("appearance/fields/effects") };
      const fx = raw.layerEffects;
      if (!obj(fx)) throw Error("No layerEffects descriptor; absence does not prove no effects");
      if (fx.masterFXSwitch === false) return { status: "disabled", source: source("appearance/fields/effects") };
      const scale = fx.scale === undefined ? null : unit(fx.scale, "percentUnit", 0, 1000);
      const items: Data[] = [];
      for (const [key, value] of Object.entries(fx)) {
        if (["_obj", "scale", "masterFXSwitch"].includes(key)) continue;
        if (!["dropShadow", "dropShadowMulti", "innerShadow", "innerShadowMulti"].includes(key)) {
          issues.push({ code: "EFFECT_NOT_CONVERTED", effect: key, reason: "Preserved in design.json; needs a dedicated converter or raster asset" }); continue;
        }
        const values = Array.isArray(value) ? value : [value];
        if (values.length > 32) { issues.push({ code: "EFFECT_LIMIT", effect: key }); continue; }
        values.forEach((v: Data, index: number) => {
          const path = `appearance/fields/effects/raw/layerEffects/${key}${Array.isArray(value) ? `/${index}` : ""}`;
          const item = attempt(() => {
            if (v?.enabled === false || fx.masterFXSwitch === false) return { status: "disabled" };
            if (v?.enabled !== true || v.present === false || v.showInDialog === false) throw Error("Shadow active/render state is not supported");
            const rgb = color(v.color), alpha = percent(v.opacity) / 100, distance = unit(v.distance, "pixelsUnit", 0), blur = unit(v.blur, "pixelsUnit", 0), choke = percent(v.chokeMatte);
            const angle = v.useGlobalAngle === true ? numeric(raw.globalLightingAngle, -360, 360) : v.useGlobalAngle === false ? unit(v.localLightingAngle, "angleUnit", -360, 360) : (() => { throw Error("Shadow light source is not explicit"); })();
            const radians = angle * Math.PI / 180, x = round(-Math.cos(radians) * distance), y = round(Math.sin(radians) * distance), inset = key.startsWith("inner");
            // A contour/noise/spread or unknown scale is not silently flattened to CSS.
            if (srgb && raw.layerFXVisible === true && scale === 100 && choke === 0 && token(v.mode) === "normal" && percent(v.noise) === 0 && v.antiAlias === false && v.transferSpec?._obj === "shapeCurveType" && v.transferSpec.name === "Linear" && Object.keys(v.transferSpec).every(k => ["_obj", "name"].includes(k)))
              hint("box-shadow", `${inset ? "inset " : ""}${x}px ${y}px ${round(blur)}px 0 ${cssColor(rgb, alpha)}`, path, "Photoshop blur and CSS blur differ; this individual shadow needs visual tuning and ordering");
            else issues.push({ code: "SHADOW_CSS_WITHHELD", source: source(path), reason: "Non-normal blend, contour, noise, spread, effect visibility or scale needs review" });
            return { inset, color: rgb, opacity: alpha, distancePx: distance, blurPx: blur, chokePercent: choke, angleDegrees: angle, offsetPx: { x, y }, effectScalePercent: scale, effectScaleApplied: false, blendMode: token(v.mode) ?? null };
          });
          items.push({ ...item, source: source(path) });
        });
      }
      return { status: items.some(i => i.status === "unsupported") ? "partial" : "parsed", items, effectScalePercent: scale, source: source("appearance/fields/effects") };
    });
    const masks = field("masks");
    if (masks.hasUserMask === true || masks.hasVectorMask === true || masks.hasFilterMask === true) issues.push({ code: "MASK_REQUIRES_REVIEW", reason: "Mask geometry is not represented by these CSS hints" });
    const chain: Data[] = [layer];
    const seen = new Set([layer.id]); let parentId = layer.parentId;
    while (parentId !== null && parentId !== undefined) {
      const parent = byId.get(parentId);
      if (!parent || seen.has(parentId)) { issues.push({ code: "ANCESTRY_UNRESOLVED" }); break; }
      seen.add(parentId); chain.push(parent); parentId = parent.parentId;
    }
    for (const entry of chain) {
      if (entry.isClippingMask === true) issues.push({ code: "CLIPPING_DEPENDENCY", layerId: entry.id });
      if (typeof entry.blendMode !== "string" || !["normal", "passThrough"].includes(entry.blendMode)) issues.push({ code: "BLEND_REQUIRES_REVIEW", layerId: entry.id, blendMode: entry.blendMode ?? null });
    }
    for (const [property, result] of Object.entries({ fill, stroke, shadows })) if (["unsupported", "partial"].includes(result.status)) issues.push({ code: "STYLE_UNRESOLVED", property, reason: result.reason || "Some items could not be interpreted" });
    return { layerId: layer.id, name: layer.name, source: source("appearance"), opacity, fillOpacityPercent: layer.fillOpacity ?? null, fill, stroke, shadows, cssHints: hints, issues, requiresVisualValidation: true, rasterReviewRecommended: issues.length > 0, appearanceStatus: requested ? appearance?.status || "unavailable" : "not_requested" };
  });
  return { schemaVersion: "photoshop.web-styles/1", source: "design.json captured descriptors; no additional host reads", originalDocumentReadOnly: true, colorProfileName: document.colorProfileName ?? null, cssHintsVisuallyVerified: false, cssHintsAreCompleteStyles: false, layers: normalized, summary: { layerCount: normalized.length, layersWithCssHints: normalized.filter(l => l.cssHints.length).length, layersWithReviewItems: normalized.filter(l => l.issues.length).length, requested }, limitations: ["Hints are individual properties, not a combined style. Resolve shape, masks, stacking, ancestor effects and fill opacity before use.", "Unknown or absent properties do not prove an effect is absent. Unsupported descriptors remain in design.json.", "No font substitution, pixel comparison, automatic layout or CSS visual equivalence is claimed."] };
}
