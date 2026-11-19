type Data = Record<string, any>;

/** Keep per-range host evidence, including disagreements, rather than substituting fonts. */
export function auditDesignFonts(layers: Data[]): Data {
  const fonts = new Map<string, { postScriptName: string; evidence: Data[] }>();
  const add = (name: unknown, status: string, evidence: Data) => {
    if (typeof name !== "string" || !name) return;
    const font = fonts.get(name) || { postScriptName: name, evidence: [] };
    font.evidence.push({ status, ...evidence }); fonts.set(name, font);
  };
  let rangeCount = 0;
  const unresolvedRanges: Data[] = [];
  for (const layer of layers.filter(layer => layer.kind === "text")) {
    add(layer.text?.characterStyle?.font, layer.text?.fontAvailability || "unknown", { layerId: layer.id, source: "whole-layer-font-collection" });
    for (const range of layer.text?.ranges?.textStyleRange || []) {
      rangeCount++;
      const style = range.textStyle;
      if (!style?.fontPostScriptName || typeof style.fontAvailable !== "boolean") unresolvedRanges.push({ layerId: layer.id, from: range.from ?? null, to: range.to ?? null, reason: "PostScript name or host fontAvailable flag is not returned" });
      add(style?.fontPostScriptName, style?.fontAvailable === true ? "available" : style?.fontAvailable === false ? "missing" : "unknown", { layerId: layer.id, source: "textStyleRange.fontAvailable", from: range.from ?? null, to: range.to ?? null });
    }
  }
  const records = [...fonts.values()].map(font => {
    const statuses = new Set(font.evidence.map((entry: Data) => entry.status));
    const status = statuses.has("available") && statuses.has("missing") ? "conflicting" : statuses.has("missing") ? "missing" : statuses.has("available") && !statuses.has("unknown") ? "available" : "unknown";
    return { ...font, status, layerIds: [...new Set(font.evidence.map((entry: Data) => entry.layerId))] };
  }).sort((a, b) => a.postScriptName.localeCompare(b.postScriptName));
  return { schemaVersion: "photoshop.design-fonts/1", textLayerCount: layers.filter(layer => layer.kind === "text").length, rangeCount, fonts: records, missing: records.filter(font => font.status === "missing").map(font => font.postScriptName), conflicting: records.filter(font => font.status === "conflicting").map(font => font.postScriptName), unresolvedRanges, installedOrReplacedFonts: false, limitations: ["A range without a PostScript name or fontAvailable flag remains unresolved; no font fallback or base-parent style is guessed."] };
}
