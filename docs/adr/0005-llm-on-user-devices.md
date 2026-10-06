# ADR 0005：大模型调用全部放到用户设备上

- 状态：已采纳（2026-09-28）
- 决策者：zhibo li
- 取代：ADR 0002 第 1 条（服务端做全部 LLM 调用、客户端不直连 LLM）
- 修订：ADR 0004 的配置来源和调用位置

## 背景

后续要支持用户自己设置大模型的 API Key 和接口地址。LLM 调用放在服务端时，只能用服务端的一套 key，用户的 key 要么上传到服务端保存，要么没法用。YOUT-188 已经把 Multica 令牌留在用户电脑上的 outbrief-daemon，大模型配置按同样的思路处理。

改动前服务端有四处调用大模型：

1. 简报：每条汇报到达后 `generateObject`，不合格重写一次（`src/brief/`）。
2. `POST /v1/llm/qa`：通话中提问，流式回答。
3. `POST /v1/llm/next-prompt`：挂断后生成下一步提示词。客户端在 YOUT-175 之后已经不展示它，但挂断时仍会请求。
4. `POST /v1/llm/reply`：替用户起草 Multica 回复。客户端早已不用（回复直接由通话记录拼出来）。

## 决策

1. **服务端不再调用任何大模型。** 删除 `/v1/llm/*`、`src/llm/`、`src/brief/` 和 `LLM_*` 环境变量，依赖里去掉 `ai`、`@ai-sdk/openai-compatible`。
2. **简报由 outbrief-daemon 生成。** 配置在 `~/.outbrief/daemon.json` 的 `llm.primary` / `llm.fallback`（`baseUrl`、`apiKey`、`model`，可选 `timeoutMs`、`reasoningEffort`），通道切换、熔断、覆盖率检查与重写规则照搬 ADR 0004 和原 `src/brief/generate.ts`。daemon 先把汇报写进本地发件箱再应答 hook，后台生成简报，然后把汇报连同简报（`BriefSubmission`）提交给 `POST /v1/daemon/events` 或 `/v1/daemon/multica-reports`；提交失败按退避重试，重启后继续。没有配置大模型或所有通道都失败时提交 `status: "failed"`，来电照常，客户端念原文，与之前服务端生成失败时一样。
3. **服务端只校验、存储、推送。** 每个事件入库时就带着简报，入库即推送，不再有“等简报生成”的状态，也不再在启动时补生成。迁移 `007` 给历史上没生成简报的事件补一条 `failed`。
4. **通话中提问在客户端做。** 客户端「设置 → 大模型」保存 OpenAI 兼容的接口地址、API Key、模型，只存在本机。问答基于汇报全文 + 简报 + 通话记录，所有来电（包括 Multica）都能提问，不再是“只记录不回答”。桌面端经 Tauri HTTP 插件发请求，绕开大模型接口没有 CORS 的问题。
5. **挂断后的回复不用大模型**，仍由客户端把用户在通话里说的话和决策拼成可编辑的回复，交给上报这通来电的 daemon 发出。

## 影响

- 电脑关机或 daemon 没运行时，本机 Agent 和 Multica 的汇报都不会来电（与 YOUT-188 相同）；daemon 已经接收但还没生成完简报时关机，重启后继续。
- 同一个用户的两个入口各有一份大模型配置：daemon（简报）和客户端（问答）。本地开发时 `scripts/dev.sh` 用 daemon 的配置预填客户端；后续做用户自定义 key 时，再决定是否由客户端统一下发给 daemon。
- 简报的生成时长由用户自己的模型决定，服务端不再有 LLM 成本和 key 管理。
