# ADR 0003：拆成三个仓库、存储改 MySQL、STT 首期走 Azure

- 状态：已采纳（2026-09-25）
- 决策者：zhibo li
- 后续：`outbrief-hook` 已于 2026-09-28（YOUT-200）并入 `outbrief-daemon`（`outbrief-daemon hook` 子命令），仓库删除；两者本来就装在同一台 Agent 电脑上，hook 离开 daemon 也没法单独工作。
- 修订：ADR 0001 第 2、3、6 条（共享 `@outbrief/protocol`、SQLite、pnpm workspace）；ADR 0002 第 2、3 条（`packages/voice`、本地 SenseVoice 优先）

## 决策

1. **三个独立仓库，本地统一放在 `~/work/code/outbrief/`，各自独立开发、测试、发布。**
   - `outbrief-server`（`asasas234/outbrief-server`）：Hono 服务端 + MySQL；方案文档与 ADR 也放这里。
   - `outbrief-app`（`asasas234/outbrief-app`）：Tauri 2 + React 19 客户端。
   - `outbrief-hook`（`asasas234/outbrief-hook`）：零依赖的 Agent 完成回调脚本。
   - 原 monorepo `asasas234/outbrief` 删除。
2. **协议以服务端 `src/protocol.ts`（zod）为准。** 客户端、hook 各自在 `src/protocol.ts` 手写镜像类型，文件头注明来源；改接口时三处一起改。接口面只有几个字段，不值得为此发 npm 包。
3. **存储：MySQL 8（`mysql2/promise`）。** 本地开发用本机 docker 容器 `some-mysql`；`db/bootstrap.sql` 以 root 建 `outbrief` / `outbrief_test` 两个库和 `outbrief` 账号；表结构只由 `db/migrations/NNN_*.sql` 定义，`pnpm db:migrate` 或服务启动时按版本顺序执行，记录在 `schema_migrations`。所有时间列存 UTC（`DATETIME(3)`，连接 `timezone: "Z"`）。
4. **集成测试连真实 MySQL。** 测试库 URL 必须以 `_test` 结尾，否则拒绝运行，防止误清空开发库；CI 用 GitHub Actions 的 MySQL 8 service。
5. **STT 首期用 Azure 路径 B，客户端直连**，与 TTS 共用签名和 token；本地 SenseVoice（sherpa-onnx）放二期，作为降低打断延迟的优化。
6. **语音代码放客户端 `outbrief-app/src/voice/`。** 服务端兜底 `POST /v1/tts` 使用官方 `AZURE_SPEECH_KEY` 的标准 REST，不复用路径 B 代码，因此不需要共享包。

## 理由

- 用户要求按前后端拆分项目、分别上传 GitHub，并在 Multica 中分别关联仓库和本地目录。
- 本机已有 MySQL 实例，现有项目都用 MySQL；服务端部署到服务器后，SQLite 需要单独处理数据文件与备份。
- Azure STT 与 TTS 是同一套签名 / token，首期不用引入 240 MB 模型和原生依赖；实测往返 4.5 s 可接受，瓶颈出现后再换本地。

## 影响

- 首次在新机器上跑服务端需要先执行 `db/bootstrap.sql`，再 `pnpm db:migrate`（或直接启动服务）。
- 协议变化没有编译期保护，靠三方各自的测试与联调发现不一致。
- 打断后的识别等待约 4.5 s，UI 需要显示“正在听写”。
