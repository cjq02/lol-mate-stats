# AGENTS.md

面向 AI 协作代理和贡献者的操作手册。产品功能、接口和评分公式见 `README.md`，这里只写动手前必须知道的约束。

## 项目速览

- 英雄联盟选人 / 对局阶段队友战绩面板，数据来自本机 LCU 接口，**只读**。
- Node.js >= 22.13，主要面向 Windows。
- ESM + TypeScript（`strict: true`，`module: NodeNext`）。
- 后端在 `src/`，前端在 `public/`，纯静态、无构建步骤。
- 运行时依赖只有 `mysql2` 和 `ws`，不要新增运行时依赖。
- MySQL 是可选能力：没配置或连不上时，面板仍需可用。

## 常用命令

| 场景 | 命令 |
| --- | --- |
| 类型检查（提交前必跑） | `npm run typecheck` |
| 测试（提交前必跑） | `npm test` |
| 开发热重载 | `npm run dev` |
| 无客户端预览界面 | `npm run demo` |
| 构建 | `npm run build` |
| 启动面板 | `npm start` |
| 单次输出当前对局 | `npm run once` |
| 查询指定召唤师 | `npm run scan -- "名字#TAG"` |
| 诊断环境 | `npm run doctor` |
| 重算历史评分 | `npm run db:recompute-scores` |

提交前统一执行：`npm run typecheck && npm test`。`npm test` 只运行 `src/stats/rating.test.ts`，新增测试也加在这个文件。

`npm start` 运行的是 `dist/` 构建产物。改完 `src/` 后必须执行 `npm run build` 再启动；只重启服务不会生效。开发调试用 `npm run dev`，或直接用 `npm run start:build`（自动先构建）。

## 目录职责

- `src/lcu/`：客户端发现、HTTP、WebSocket、Live Client Data API。只做通信，不写业务判断。
- `src/stats/`：对局解析、评分、坑指数、标签、常量、MySQL 存储。
- `src/server.ts`：HTTP / SSE 路由、静态资源、图片代理。不要把统计逻辑塞进来。
- `src/ai.ts`：AI 提示词和流式调用。提示词改动集中在这里。
- `src/index.ts`：CLI 入口与 `start / once / scan / demo / doctor` 流程。
- `src/tools/`：一次性迁移 / 重算工具，不参与常规启动。
- `public/app.js`：单文件原生 JS。DOM 引用统一放在 `els` 表里，新增元素先加进 `els`。
- `scripts/`：独立分析脚本，不参与构建。

## 代码规范

- 相对导入必须带 `.js` 后缀（如 `./rating.js`），Node 内置模块用 `node:` 前缀。
- 类型导入用 `import type`，不要和值导入混写。
- 2 空格缩进、单引号、分号、多行尾逗号、LF 换行。
- 导出的函数写显式返回类型；公共类型放 `src/types.ts`。
- 面向用户的文案、日志和注释使用中文，保持现有语气。
- 控制台输出走 `src/util.ts` 的 `logTag / dim / ok / warn / fail`，不要手拼格式。
- 不引入框架、打包器、linter 或格式化工具；当前没有 lint / format 配置。
- 可选能力失败时优雅降级，不要因为缓存、段位、图标等非核心数据失败而中断主流程。

## 数据与安全红线

- LCU 接口只读：不注入游戏进程、不修改客户端文件、不自动操作对局。
- 服务默认只绑定 `127.0.0.1`，不要改成 `0.0.0.0` 或暴露到公网。
- 禁止把 LCU token、密码、AI API Key、`.env` 内容写入日志、提交记录或前端。
- 除 AI 接口外，不新增对外网络请求；图标和资源走本地客户端代理。
- 不提交 `dist/`、`.env`、`node_modules/` 或本地数据目录。
- MySQL 查询必须参数化，不拼接字符串。
- 前端插入动态文本必须 `escapeHtml`；AI Markdown 走现有 `aiMarkdown`。禁止把未转义的用户数据直接放进 `innerHTML`。

## 评分与统计不变量

`src/stats/rating.ts` 是评分和坑指数的唯一来源，不要在其它模块复制阈值。

- 所有统计按当前模式隔离：大乱斗只看大乱斗，竞技场独立计算。
- 重开不计入胜率、场次、评分和坑指数，并自动往前补足正常对局。
- 样本不足 3 场时坑指数封顶 45；极端局评分封顶 12，这些保护逻辑不要随手删除。
- 新增模式或队列先改 `src/stats/constants.ts`，不要硬编码 queueId。
- 修改公式、阈值或标签时，必须同步更新三处：`rating.ts`、`rating.test.ts`、`README.md` 的公式与阈值说明。

## 测试

- 使用 `node:assert/strict` 和文件内自定义 `test()`，不引入测试框架。
- 每个评分、标签或模式判断的改动，至少补一条回归用例。
- 测试名称用中文描述行为，断言失败时给出可读的上下文。
- 提交前必须通过 `npm run typecheck && npm test`。
- 任何 `src/` 改动完成后都要 `npm run build`，确保 `dist/` 与源码一致；`dist/` 不提交。

## 前端

- `public/` 无构建、无打包、无 TS，直接在浏览器运行，不要加 `import`。
- 实时数据通过 `/api/stream` 的 SSE 获取，不要改回轮询。
- 颜色、间距和布局改 `public/style.css`，不要在 JS 里拼内联样式。
- 保留现有卡片、弹窗和页签结构，优先复用已有样式类。

## 数据库

- 表结构集中在 `src/stats/store.ts`，启动时用 `CREATE TABLE IF NOT EXISTS` 自动建表。
- 迁移和批量重算放在 `src/tools/`，不要把一次性 SQL 写进业务代码。
- 新增缓存前先明确失效策略；报告缓存在出现新对局前有效。
- 连接失败后按现有 30 秒重试机制降级，不要阻塞面板启动。

## Git 与提交

- 完成一个可运行的改动后，**自动提交并推送到 `origin` 当前分支**，不需要再询问用户。
- 提交或推送前先跑 `npm run typecheck && npm test`，改完 `src/` 还要执行 `npm run build`；失败则先修复，不要提交半成品。
- 提交消息使用中文，保留 Conventional Commits 前缀，例如：
  - `feat: 新增对局详情缓存`
  - `fix: 修正评分权重计算`
  - `style: 调整 MVP 边框颜色`
  - `docs: 更新 AGENTS.md 协作规范`
- 单行摘要，祈使语气，不加句号；一个提交只做一件事。
- UI 样式调整与逻辑改动分开提交。
- 推送失败时不要强推（禁止 `--force`），保留现场并说明原因。
- 只有用户明确要求“先不要提交/推送”时才暂停自动提交。

## 不要做

- 不要新增运行时依赖或前端框架。
- 不要提交 `dist/`、`.env`、本地数据库或资源目录。
- 不要在日志或前端输出 token、密码、API Key。
- 不要把服务绑定到 `127.0.0.1` 以外。
- 不要绕过 `rating.ts` 在其它地方复制评分阈值。
- 不要改公式却不更新 README 和测试。
- 不要对 LCU 接口执行写操作。
