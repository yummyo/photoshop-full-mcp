# 网页样式解释与 CSS 候选

`photoshop_design_export` 现在额外写入 `styles.json`，数据版本 `photoshop.web-styles/1`。它只解释已经捕获的 `design.json`，不增加宿主命令、不安装字体、不编辑原 PSD。输出带独立 SHA-256，由 `manifest.styles` 引用；工具结果新增 `stylesPath` 和 `styleSummary`。

本轮为源码及自动化验证，尚未完成真实 Photoshop 描述符或浏览器截图验收。候选包单独保留。

## 支持范围

| 内容 | 归一化数据 | CSS 候选条件 |
| --- | --- | --- |
| 透明度 | DOM 百分比、0–1 值 | 对对应元素/组使用一次，不混入描述符字节值、祖先或填充透明度 |
| 纯色 | 明确 RGBColor 的浮点 RGB 通道 | 确认文档为 RGB/sRGB；形状、蒙版和 fillOpacity 另行核对 |
| 渐变 | 类型、角度、颜色/透明度停止点、中点、缩放、偏移 | 显式线性、无反转/抖动、对齐、100% 缩放、零偏移、中点 50；颜色与透明度停止点须对齐，或透明度恒定 |
| 矢量描边 | 像素宽度、颜色、透明度、对齐、混合模式 | 内描边、普通混合、空虚线数组；border 候选仍需真实路径和 border-box 验证 |
| 内外阴影 | 距离、模糊、扩展、颜色、透明度、全局/局部角度、多阴影来源 | 已知可见、100% 效果缩放、普通混合、无扩展/噪点、识别到线性轮廓时提供单项 box-shadow 候选 |

RGB 别名 `grain`/`green` 冲突时拒绝解释。非 RGB 颜色不在 Node 端猜测转换。文档配置不是已确认的 sRGB RGB 时，保留颜色数据，但不给颜色相关 CSS。

渐变位置按当前支持描述符的 0–4096 约定解释。未知单位、动态前景/背景色、倒序停止点均拒绝；相关规则须继续采集真实宿主样本验证，不代表 Adobe 为所有版本保证相同结构。[Adobe ActionJSON 说明](https://developer.adobe.com/photoshop/uxp/ps_reference/media/batchplay/)介绍了描述符及从宿主采集的方法。

CSS 角度候选使用 `90 - Photoshop角度` 后归一化。CSS 的角度和范围定义见 [MDN linear-gradient](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/gradient/linear-gradient)；范围、插值和像素结果仍须比对。

阴影像素值尚未应用效果缩放，记录 `effectScaleApplied: false`。未知或非 100% 缩放时不输出 CSS，不将 Photoshop 模糊认证为 CSS 模糊；全局光角度缺失时不猜测默认值。

## 输出与限制

每层含 `layerId`、名称、来源、`fill`、`stroke`、`shadows`、`cssHints` 和 `issues`。例如 `design.json#/layers/8/appearance/fields/fill/raw/adjustment/0` 是实际 JSON Pointer；图层 ID 另行记录。

所有候选为 `approximate: true`，并带说明，`requiresVisualValidation` 始终为 true。`rasterReviewRecommended` 表示有待核对的问题，不是自动导出或认定必须栅格化。

状态区分 `parsed`、`partial`、`disabled`、`unsupported`、`not_returned`、`unavailable` 和 `not_requested`。`parsed` 只表示解释器识别了字段。截断描述符不会被解释成完整样式；未返回效果不等于没有效果。

`include_styles: false` 时外观字段为 `not_requested`；基本检查中的 DOM 透明度仍可解释。候选是独立属性，不是完整规则；多个阴影的顺序、形状、蒙版、父组混合及 fillOpacity 都需单独处理。不要给已带效果的 PNG 重复应用同一效果。

`manifest.status: complete` 继续表示要求的文件成功产生，不代表 CSS 或视觉还原完整。样式统计与素材回放验证分开。

仍需开发：圆角几何、完整路径/SVG、画板变换、更多叠加/发光/斜面效果转换、蒙版/剪贴依赖的网页表达、自动布局及浏览器差异报告。缺失字体继续暂缓。

## 验证

42 项相关测试及构建通过。新增覆盖颜色/单位、渐变 alpha/角度、反转/中点/缩放、描边条件、全局/局部光、多阴影、缺失/关闭/截断、父组合成依赖、JSON Pointer、输出摘要及无额外宿主调用。

尚未完成真实 PSD 导出和浏览器视觉验收；模拟描述符不作为实机兼容证明。上游全量检查的既有失败单独记录。
