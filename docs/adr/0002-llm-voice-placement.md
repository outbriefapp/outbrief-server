# ADR 0002：LLM 调用方式与语音链路放置

- 状态：已采纳（2026-09-25）；第 2 条中 `packages/voice` 与第 3 条 STT 选择由 [ADR 0003](0003-repos-mysql-azure-stt.md) 修订；第 1 条中“CLIProxy + gemini-3.6-flash-high”由 [ADR 0004](0004-llm-gemini-flash-failover.md) 取代；第 1 条“服务端只做无状态单轮 LLM 调用”与“客户端直连 LLM”的放弃理由由 [ADR 0005](0005-llm-on-user-devices.md) 取代
- 决策者：zhibo li
- 补充 / 修订：ADR 0001 第 2 条中“服务端负责 TTS/STT”的部分

## 背景

讨论中提出五个问题：简报生成是否需要 Agent；TTS 能否放客户端；多轮交互的 Agent 循环放在哪；如何打断；语音识别选什么。担心点是服务端集中承担所有用户的 LLM 会话与免费语音通道流量。

## 决策

1. **不引入 Agent 框架，服务端只做无状态单轮 LLM 调用。** 使用 Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`）接 CLIProxy：
   - 简报：事件到达时服务端调用一次 `generateObject`（zod schema 放 `@outbrief/protocol`），代码校验 `critical` 事实全覆盖，不合格补调一次，仍不合格追加“补充说明”卡片。
   - 问答 / 下一步提示词：`POST /v1/llm/:task`（`task ∈ {qa, next-prompt}`），`streamText` 单轮流式；报告、简报、对话历史由客户端每次带上；系统提示词由服务端按 task 选择，客户端不能自带。
   - 对话状态、翻卡片、记录决策、续播都在客户端执行。
2. **TTS 客户端直连 Azure 路径 B，服务端兜底。** 扩展的 `edge-tts/*` 抽成同构包 `packages/voice`，客户端与服务端共用。客户端按句合成并本地缓存；连续失败时调用服务端 `POST /v1/tts`（官方 `AZURE_SPEECH_KEY`，按用户限额）。
3. **STT 首选本地 SenseVoice-Small int8（sherpa-onnx 官方 Rust crate，Tauri command）**；模型未下载或失败时用 Azure 路径 B STT（客户端直连）。录音统一为 16 kHz 单声道 PCM（AudioWorklet）。
4. **打断为显式触发**：按住说话、点“打字”、输入第一个字、点决策选项即暂停；续播从当前句开头；回答中再次打断会 abort 进行中的 LLM 请求与未播音频。首期不做语音自动打断（需要回声消除 + VAD）。

## 依据（实测）

- 纯网页（Chromium，无扩展、无代理）：签名 → JWT → TTS → STT 全部 200。三个接口对 `tauri://localhost`、`http://tauri.localhost` 预检均返回 `Access-Control-Allow-Origin: *`。
- 换 token 接口带任何 `Referer` 即返回 401（错误码 401001）；WebView 中请求必须设置 `referrerPolicy: "no-referrer"`。扩展的 Service Worker 不带 Referer，所以此前没暴露。
- SenseVoice-Small int8（M4 Max CPU，2 线程）：模型 240 MB，加载 0.43 s，11.3 s 音频识别 0.18 s（RTF 0.016）。Azure STT 同一音频网页往返 4.5 s。
- 简报单次 `generateObject` 类调用（gemini-3.6-flash-high）约 5.6 s，关键事实全覆盖。

## 备选与放弃原因

- LangChain / LangGraph / Mastra：解决多步工具循环与状态持久化，本场景三类调用都是单轮。
- 服务端托管对话状态：会话内存与水平扩容成本上升，且无收益。
- 客户端直连 LLM：凭据需下发到客户端；保留服务端网关以集中管理 key、限额与提示词版本。
- Web Speech API：WebView2（Windows）、WebKitGTK（Linux）不可用。
- Whisper：中文准确率与速度都不如 SenseVoice；可作为英文用户可选项。

## 影响

- 路径 B 签名密钥随客户端分发；该密钥已公开（read-frog、youtube-dubbing-extension 同款），不增加暴露面；官方 Speech Key 只放服务端。
- 首次使用本地 STT 需下载约 240 MB 模型；下载完成前走 Azure STT。
- 需要新增 `packages/voice`、服务端 `/v1/llm/:task`、`/v1/tts`、客户端 Tauri command（sherpa-onnx）。
