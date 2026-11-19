# 设计数据、参考图与图层素材导出

新增工具 `photoshop_design_export` 将读取结果写入一个全新的目录，原始 Photoshop 文档保持只读。`readOnlyHint` 为 false，因为它会创建本地文件；`destructiveHint` 为 false。未复用会切换活动文档/图层的通用编辑包装器。

## 调用

```json
{
  "document_id": 59,
  "layer_ids": [9126, 4951],
  "include_reference": true,
  "include_styles": true,
  "render_mode": "isolated_composite",
  "pixel_tolerance": 1,
  "max_pixels": 4000000
}
```

- 省略文档 ID 时读取活动文档，随后绑定实际 ID。跨重启不能复用旧 ID。
- `layer_ids` 最多 32 个唯一正整数；省略时只生成设计数据和参考图。需要更多素材时分批调用，每批都有独立清单。
- `include_reference` 默认为 true，导出当前可见文档的完整像素参考图。
- `include_styles` 默认为 true，附带宿主返回的外观描述符；独立的 `photoshop_document_inspect` 也新增此选项，默认 false 以保持轻量读取。
- `max_pixels` 默认 400 万，上限 800 万，分别约束画布或单素材。超限明确拒绝，不自动缩小。
- 每批请求的画布与素材面积合计限制为 1600 万像素，超限时要求分批，避免原生端同时保留过多像素回执。
- `render_mode` 默认 `layer_pixels`，只读取原始单层像素。显式选择 `isolated_composite` 后，在受控临时副本中保留目标子树和祖先链，读取 Photoshop 合成结果并进行回放校验；不修改原文档的图层。
- `pixel_tolerance` 为 0–8，默认 1，表示当前背景回放校验允许的最大通道差；不代表全页面相似度百分比。
- 当前像素导出要求 RGB 8-bit 文档；不会转换原文档模式、位深或保存原稿。输出像素明确请求 sRGB，并记录宿主返回的色彩信息。

配置 `PS_MCP_DESIGN_EXPORT_DIR` 指定输出根目录；默认使用 MCP 的 exportDir/design。可将其设为本地专用输出目录。

```text
outputs/<document-id>-<unique-run-id>/
├─ design.json
├─ design-preview.png
├─ manifest.json
├─ fonts.json
├─ styles.json
└─ assets/
   ├─ layer-9126.png
   └─ layer-4951.png
```

同层素材名由图层 ID 决定，图层名称保留在清单中；名称不参与路径拼接。每次调用创建独立目录，文件使用独占创建，禁止覆盖。输出根目录不能经过符号链接或 junction。`outputs/` 被 Git 忽略，避免把设计数据和素材意外提交。

## 像素与坐标

`layer_pixels` 使用固定的 `imaging.getPixels` 调用，只传显式文档/图层 ID。读取期间进入必要的 imaging modal scope，但不激活文档、不选择图层、不切换可见性、不暂停历史，也不保存。`isolated_composite` 会创建并激活临时副本，仅在副本上隔离可见性，结束时清理副本并恢复原活动文档；两种模式都不保存原 PSD。

请求不提供 `targetSize`，验证宿主返回 level 0、实际源矩形、8-bit RGB/RGBA 格式和像素字节数。PNG 在 Node 端无损编码，保留返回的 alpha 值。

宿主可能裁掉没有像素的边缘，因此：

- 完整参考图会按宿主返回的实际原点补回透明边缘，保持原画布宽高。
- 图层素材保留宿主的实际裁切范围，`capture.sourceBounds.x/y` 是放回文档的坐标；负坐标不会丢弃。
- `requestedSourceBounds` 和 `sourceBounds` 分开记录；`scale` 固定为 1。
- 素材还记录源图层 ID、类型、祖先 ID、可见性以及两种 DOM 边界。

参考：[Adobe Imaging API](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/imaging)。该 API 允许读取文档合成图或单图层，且实际返回范围可能被裁切。

## 样式描述符

通过固定 ActionJSON `get layer` 读取当前页图层的外观数据，保留原始 `_unit`/`_value`：

- `adjustment` 中的纯色、渐变等填充描述。
- `layerEffects`、效果可见性与返回的描边字段。
- 可返回的形状/路径边界、画板、智能对象信息。
- 像素/矢量/滤镜蒙版的存在、启用状态、密度和羽化信息。

字段未返回时标记 `not_returned`，不能推断为没有此效果。读取失败标记 `unavailable`；长数组/深层结构的裁切列在 `truncatedFields`。原始参数不是直接可用的 CSS，不同描述符的不透明度还可能使用 0–255。

新增 [styles.json 样式解释](WEB_STYLES.md)，提供保守的归一化颜色、渐变、描边和阴影，以及带来源和限制的独立 CSS 候选。工具结果增加 stylesPath/styleSummary，清单增加 styles 文件摘要；不支持项保留明确状态，不自动生成最终 CSS。样式统计不改变素材验证或清单完成状态的含义。

## 合成范围与限制

完整参考图代表当前可见文档的合成结果。独立图层素材被明确标记为 `layer-pixels`：**当前不保证包含图层效果、蒙版或父级混合/裁切结果**，不能把它们当成已验证的最终独立合成素材。隐藏层不会被强制显示。

`isolated_composite` 的实现和限制详见 [临时副本渲染](ISOLATED_RENDER.md)。该模式已实现副本渲染与当前背景的局部像素校验，但尚未在真实 Photoshop 上验收；不能据此承诺复杂组在任意背景上都能独立还原。

图层组、形状、智能对象是否能够直接返回像素取决于宿主；不支持时记录该项失败，不编造图片。临时副本模式已实现，复杂合成效果的真实兼容性、路径点数据和自动 CSS 转换仍待后续验证或开发。按用户 2026-11-17 的要求，缺失字体暂缓处理，不阻塞 P2 导出和首轮网页还原；相关字形、字宽和换行差异单列记录，字体审计结果保留供后续完善。

## 可追溯性与结果状态

`manifest.json` 版本为 `photoshop.design-assets/1`，记录每个文件的相对路径、字节数、SHA-256、源文档、图层、实际裁切信息和读取状态。

`fonts.json` 保留每个文字范围的 PostScript 字体名称、宿主可用性、字符区间，以及整层检查与范围检查之间的冲突。缺少字段时列为未知，不猜测继承字体，不自动安装或替换字体。

- `complete`：本次要求的文件均产生，外观描述符请求均成功；不代表视觉还原验收通过，也不代表所有效果参数都有返回。
- `partial`：部分素材或外观读取不可用，清单保留原因。
- 单个素材 `exported_unverified`：PNG 已生成，但在当前背景上的回放与原图不匹配；文件保留供检查，整个包标为 partial。
- `invalidated`：文档或目标在读取期间变化，或整个流程失败；现有文件留作诊断，不得视为有效设计包。

完整树分页绑定文档 revision，像素读取逐项核查与开始时相同的活动文档、选中图层、saved、历史和选区状态，最后再核对 revision。读取前后状态检查不等同于文件字节或渲染像素比较。

## 本轮验证状态

构建与 42 项相关测试通过，覆盖 alpha/PNG 像素、透明边缘补齐、实际裁切坐标、分页完整性、按 ID 绑定、独立目录、防路径越界、部分失败、文档变化失效、整批资源上限、分段字体冲突、临时副本所有权/ID 重映射/清理/取消、局部回放校验、样式解释及 MCP 工具到导出文件的完整调用链。测试在不暴露 TextEncoder、btoa、SubtleCrypto 或 Node 模块的 UXP 模拟环境中执行像素和外观模块。

这些自动化结果尚不代替 Photoshop 实机导出验证。实机部署/验收结果须另外记录，并与此前 P1 的只读检查报告区分。
