# ADR 0001：技术栈与分层

- 状态：已采纳（2026-09-25）；TTS/STT 与 LLM 调用的放置由 [ADR 0002](0002-llm-voice-placement.md) 修订；仓库结构、存储与 STT 由 [ADR 0003](0003-repos-mysql-azure-stt.md) 修订
- 决策者：zhibo li

## 背景

OutBrief 需要一套代码覆盖 Windows / macOS / Linux / iOS / Android 客户端，服务端负责事件接入、LLM 精炼、TTS/STT 与排队下发；Agent 侧 hook 必须轻量且绝不阻塞 Agent。

## 决策

1. **客户端：Tauri 2 + React 19 + TypeScript + Vite。** Tauri 2 桌面与移动共用同一 Rust 壳和 Web 前端；移动端来电（CallKit / 全屏通知）等原生能力通过 Tauri 插件（Swift / Kotlin）补齐。
2. **服务端：Node 22 + Hono + zod，单体服务。** 与客户端、hook 共享 `@outbrief/protocol` 类型；Azure TTS 路径 B 可直接复用 `youtube-dubbing-extension` 的 TS 实现（已在 Node 下实测 TTS + STT 可用）。
3. **存储：首期 SQLite（`node:sqlite`，零依赖，单用户自托管）。** 多租户 / 多实例时迁移 PostgreSQL；访问集中在 `EventStore`，迁移面小。
4. **下发：SSE（fetch 流，支持 Authorization 头）+ `Last-Event-ID` 续传 + 轮询兜底。** 移动端后台唤醒需要 APNs / FCM 推送，二期引入。
5. **Hook：零运行时依赖的 Node 脚本，失败始终 `exit 0`。**
6. **工程：pnpm workspace、Biome、Vitest、GitHub Actions（Node 检查 + 三平台 Tauri 构建）。**

## 备选与放弃原因

- Flutter：移动体验好，但与现有 TS 资产（Azure TTS、协议类型）割裂。
- Electron：无移动端。React Native：桌面端（尤其 Linux）支持弱。
- Java Spring Boot 服务端：与现有 proxy 同栈，但无法与客户端共享类型、无法直接复用 TS 版 TTS 实现。

## 影响

- 需要 Node ≥ 22.18（原生类型剥离）；代码只能使用可擦除的 TS 语法（`erasableSyntaxOnly`）。
- Rust 需 stable ≥ 1.85。
