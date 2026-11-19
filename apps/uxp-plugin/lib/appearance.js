"use strict";

const { action } = require("photoshop");
// These are read from the host descriptor, never synthesized as CSS. An absent
// field does not prove absence of an effect on this host/version.
const GROUPS = {
  fill: ["adjustment"],
  effects: ["layerEffects", "layerFXVisible", "globalLightingAngle"],
  stroke: ["AGMStrokeStyleInfo", "AGMStrokeStyle"],
  shape: ["keyOriginType", "pathBounds", "vectorMask", "vectorMaskBounds"],
  masks: ["hasUserMask", "hasVectorMask", "hasFilterMask", "userMaskEnabled", "vectorMaskEnabled", "userMaskDensity", "userMaskFeather", "vectorMaskDensity", "vectorMaskFeather", "filterMaskDensity", "filterMaskFeather"],
  artboard: ["artboardEnabled", "artboard"],
  smartObject: ["smartObject", "smartObjectMore"],
  compositing: ["opacity", "fillOpacity", "mode", "group", "blendOptions", "knockout", "layerSection"]
};

async function readAppearance(doc, nodes, warnings) {
  const { copyDescriptor } = require("./inspection");
  for (let offset = 0; offset < nodes.length; offset += 12) {
    const batch = nodes.slice(offset, offset + 12);
    try {
      const results = await action.batchPlay(batch.map(node => ({ _obj: "get", _target: [{ _ref: "layer", _id: node.id }, { _ref: "document", _id: doc.id }], _options: { dialogOptions: "dontDisplay" } })), { synchronousExecution: false, modalBehavior: "fail" });
      for (let index = 0; index < batch.length; index++) {
        const node = batch[index], descriptor = results && results[index];
        if (!descriptor || descriptor._obj === "error") {
          node.appearance = { status: "unavailable", reason: descriptor && descriptor.message || "Host did not return a layer descriptor" };
          continue;
        }
        const truncatedFields = [], fields = {};
        for (const [group, names] of Object.entries(GROUPS)) {
          const raw = {};
          for (const name of names) if (descriptor[name] !== undefined) raw[name] = descriptor[name];
          fields[group] = Object.keys(raw).length
            ? { status: "available", raw: copyDescriptor(raw, truncatedFields, `appearance.${group}`) }
            : { status: "not_returned", reason: "Property not present in this host layer descriptor; absence of the visual effect is not inferred" };
        }
        node.appearance = { status: "available", source: "ActionJSON get layer", fields, truncatedFields, units: "raw _unit/_value preserved; descriptor-specific opacity may be 0-255" };
        if (truncatedFields.length) warnings.push(`Appearance descriptor for layer ${node.id} was truncated`);
      }
    } catch (error) {
      for (const node of batch) node.appearance = { status: "unavailable", reason: error.message || String(error) };
    }
  }
}

module.exports = { readAppearance };
