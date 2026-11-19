# 本地只读检查扩展验证记录

日期：2026-11-16。分支：`codex/read-only-document-inspection`。上游基线：`4b08733394436c02af71eb5bd4e21ad225d0a858`。

## 已实现和自动化验证

- 新增 `photoshop_document_inspect`，返回 `photoshop.design/1` 数据：递归树、数量、可见性、边界、文字及混合文字范围。
- 合入 UXP 认证兼容代码；保留 HMAC-SHA256、Bridge v4 的 owner generation 和 execution protocol 校验，未放宽认证。
- 使用 Node 24.22.1。`npm run build`、TypeScript 编译和 `git diff --check` 通过。
- 定向测试 **14 项全部通过**：本轮新增 11 项，已有图片放置和文字排版回归 3 项。

复验命令（Node 版本须满足 package.json）：

```powershell
npm run build
node --import tsx --test --test-concurrency=1 tests/document-inspection.test.ts tests/photoshop-text-fit.test.ts tests/photoshop-placement.test.ts
git diff --check
```

测试覆盖认证缺少浏览器全局对象、错误密钥、篡改签名、错误运行时代次、递归数量、隐藏祖先、负坐标、效果边界、分页过期、混合文字与原始单位、只读状态、不可用字段、长文本截断，以及 MCP 输入校验和只读标记。测试使用冻结的模拟宿主对象及只允许 `get` 的 ActionJSON 断言，不能代替真实 Photoshop 验收。

## 上游基线已有的失败

在隔离的原始 HEAD 副本中复现后确认：

- `npm run check` 中 TypeScript 和 catalog handler 检查通过；严格 inventory audit 因 `document.export` 的已有 live evidence contract digest 不匹配而失败（`SUPPORTED_LIVE_EVIDENCE_MISSING`）。未伪造或重新签署实机证据。
- `npm --prefix apps/uxp-plugin run check` 的静态检查要求出现字面量 `/v1/poll`，与上游 v4 当前的动态路由表达式不一致，首阶段报错；后续脚本未因此获得完整通过结论。
- 完整测试尝试遇到 Windows 临时目录下 `Cannot verify owner-only ACL for Photoshop MCP secret`，并有 owner 启动失败后清理路径报告 `ERR_SERVER_NOT_RUNNING`。已停止该次测试进程。未保留无关 ACL 改动，也未声称完整测试集通过。

## 实机只读验证

随后在 Photoshop 27.0.0 / UXP 9.0.2 完成 P1 只读验证，覆盖分页、按 ID 查询及读取前后的文档状态。见 [实机验证摘要](LIVE_VALIDATION_2026-11-17.md)。此结果不包括 P2 导出。
