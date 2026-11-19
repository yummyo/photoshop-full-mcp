# Read-only document inspection

`photoshop_document_inspect` reads the open document's layer hierarchy, pixel bounds and text metadata. It is separate from editing commands and is annotated `readOnlyHint: true` and `destructiveHint: false`.

This local extension has automated coverage and passed core read-only inspection through a real MCP stdio client on Photoshop 27.0.0 / UXP 9.0.2 on 2026-11-17. The sample contained 453 nodes and 142 text layers; all text-style ranges were read across ten pages. Two groups had unavailable bounds and some paragraph fields were null. See the [live report](LIVE_VALIDATION_2026-11-17.md); this is validation of one host/sample, not a blanket compatibility claim.

See [the local validation record](INSPECTION_VALIDATION.md) for commands, baseline failures and the candidate package status.

## Inputs

```json
{
  "document_id": 60,
  "include_hidden": true,
  "include_text": true,
  "include_text_runs": true,
  "limit": 100
}
```

- Omit `document_id` to inspect the active document. An explicit open document can be inspected without activating it.
- Optional `layer_ids` selects 1–1000 unique IDs. It selects result records, not Photoshop's active layers. It does not automatically include descendants.
- `include_hidden` defaults to true. When false, layers hidden by an ancestor are excluded; unknown visibility remains explicitly null.
- `include_text` and `include_text_runs` default to true. Text runs use fixed, read-only ActionJSON `get` descriptors with explicit document and layer IDs.
- `include_styles` defaults to false. When true, fixed `get layer` descriptors attach raw fill, effects, stroke, masks, shape, artboard and smart-object fields. Missing properties are `not_returned`, not assumed absent. See [design export](DESIGN_EXPORT.md).
- `limit` is 1–500 and defaults to 100.
- Follow `page.nextCursor` using the same document, layer filter and inclusion options. A document-state or query change invalidates the cursor with `STALE_TARGET`.

## Output contract: `photoshop.design/1`

The result contains:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `photoshop.design/1` |
| `document` | ID, title, canvas dimensions, resolution, mode, bit-depth enum and profile |
| `revision` | SHA-256 of the query, document-state snapshot and structural metadata |
| `counts.topLevelCount` | Number of root layers/groups |
| `counts.totalNodeCount` | Recursive count, including groups |
| `counts.groupCount`, `leafCount` | Group and non-group counts |
| `counts.matchedCount` | Number after the ID/visibility filters |
| `rootLayerIds` | Root IDs in Photoshop collection order |
| `layers` | The current page of layer records, in depth-first collection order |
| `page` | Offset, returned count, limit, `hasMore` and `nextCursor` |
| `readOnlyCheck` | Before/after state snapshots and `unchanged` status |
| `warnings` | Explicit limitations observed during this read |

Each layer record includes `id`, `parentId`, `ancestorIds`, `index`, `depth`, `name`, `kind`, `children`, visibility, opacity, lock/clipping/blend information, bounds and text metadata.

`children` is an array of child IDs, not embedded layer objects. IDs can refer to another page or outside an ID-filtered result. Assemble all pages into an ID map and use `rootLayerIds`/`children` to reconstruct the tree. Do not interpret one page as the complete document.

### Geometry

- `bounds` includes layer effects. `boundsNoEffects` excludes them.
- Both are document-pixel rectangles with `left`, `top`, `right`, `bottom`, `x`, `y`, `width` and `height`.
- Absolute origin is the document's top-left. Negative coordinates are retained.
- `positionInParent` is derived from the layer and parent's **boundsNoEffects** top-left; it is not an inferred CSS layout constraint or an artboard-local transform.
- Unavailable geometry is null with a reason in `unavailableFields`.

### Text

For text layers, `text` includes contents, point/paragraph flags, whole-layer character and paragraph style fields, and font availability where the installed-font collection can be inspected.

DOM character metrics are retained as UXP exposes them, in pixels at the document's resolution. `tracking` is in 1/1000 em. The raw `textStyleRange` and `paragraphStyleRange` descriptors preserve their `_unit`/`_value` pairs, character offsets, text-shape information and text transform. Do not convert a raw points value directly into CSS pixels without considering resolution and transform.

Mixed styles must be read from the ranges. A whole-layer style is not evidence that every character has that style. Font availability currently checks the whole-layer PostScript font; individual range fonts remain available in their raw descriptors for downstream checking.

If a host property throws or is absent, it is returned as null with an entry in `unavailableFields`. Failed text-descriptor reads are marked `text.ranges.status: unavailable`; non-text layers use `text.status: not_applicable`.

## Read-only behavior and limits

The implementation does not assign document/layer properties, activate a document, select layers, suspend history, execute editing commands, save, or write export files. It snapshots the active document, selected layer IDs, saved flag, history ID/count and selection bounds before and after inspection. If an observable field changes during the read, it rejects the result with `STALE_TARGET`. Unobservable snapshot fields remain listed; an unchanged snapshot is not a pixel-level comparison.

Limits are explicit: 50,000 nodes, 256 nesting levels, 500 records per page and 4 MiB UTF-8 per response. Long text contents are capped at 200,000 characters with `contentsTruncated: true`. Raw descriptor arrays are capped at 2,000 entries and nesting at 12 levels; `truncatedFields` records these cases. Reduce the page size or query specific IDs for large documents. Truncated data must not be treated as complete.

The live-qualified P1 increment does not export assets, identify rasterized text, or produce a high-fidelity webpage. The [P2 candidate](DESIGN_EXPORT.md) implements raw appearance descriptors and traceable reference/layer PNG exports, with automated coverage; actual PSD exports and exact effects/mask/parent compositing remain pending live qualification.

## Deployment and validation

The current source uses Bridge v4 and a persistent runtime owner. Deploy the Node runtime and UXP panel together; do not combine the new panel with an old standalone v3 runtime. Preserve the existing pairing data directory. The authenticated discovery compatibility helper retains HMAC-SHA256, owner-generation binding and execution-protocol binding.

For the portable Photoshop setup, the previously verified user fallback plugin directory is:

```text
%APPDATA%\Adobe\UXP\Plugins\External\com.codex.photoshop-full-mcp_2.0.1
```

Build and review the runtime/panel before replacing this directory. Preserve backups and any unsaved Photoshop work. Reload the panel and restart Codex after the coordinated update. Keep native Adobe CLI/Vulcan loading separate; this extension does not depend on that failing installation path.

The live run verified the sample PSD's recursive counts, returned coordinates, mixed text styles, unavailable-field reporting, pagination, ID-query consistency and unchanged observable original-document state. Full pixel-level coordinate/render comparison, artboard transforms, asset exports and another PSD remain pending. Restart Codex after switching its configured entry point to refresh its tool inventory.
