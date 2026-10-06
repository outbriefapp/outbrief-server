# ADR 0004：LLM 用 Gemini 3.8 Flash，CLIProxy 主通道 + Vercel AI Gateway 兜底

- 状态：已采纳（2026-09-25）；调用位置由 [ADR 0005](0005-llm-on-user-devices.md) 修订：通道、切换、熔断规则原样搬到 outbrief-daemon 生成简报，配置从服务端环境变量改为 `~/.outbrief/daemon.json` 的 `llm`；`/v1/llm/*` 与流式问答切换规则（第 6 条）随服务端问答一起取消
- 决策者：zhibo li
- 取代：ADR 0002 第 1 条中的“CLIProxy + gemini-3.6-flash-high”

## 背景

简报、问答、下一步提示词三类调用都在服务端（ADR 0002）。只接一个 CLIProxy 时，CLIProxy 或 SSH 隧道一挂，来电就只剩原文，问答直接不可用。需要一个备用通道，并明确什么时候切、切到哪、怎么记录。

## 决策

1. **一个逻辑模型 `gemini-3.8-flash`（协议 `LlmModel`），每个通道映射到自己的模型名。**
   - 主通道 CLIProxy：`LLM_PRIMARY_BASE_URL`（默认 `http://127.0.0.1:18317/v1`），模型 `gemini-3.8-flash-high(low)`。
   - 兜底通道 Vercel AI Gateway：`LLM_FALLBACK_BASE_URL`（默认 `https://ai-gateway.vercel.sh/v1`），模型 `google/gemini-3.8-flash`。
   - 两个通道都走 Vercel AI SDK v7 的 `createOpenAICompatible`。没有 API key 的通道不启用；两个都没有时 `/v1/llm/*` 返回 503，简报记为 `failed`，服务照常启动。
2. **推理参数：主通道发 `reasoning_effort: "none"`，兜底通道不发任何推理参数。** Vercel 上显式传 effort 反而会打开 thinking（2026-08-07 实测），不传就是不思考。
3. **切换条件（按调用逐个判断，先主后备）：** 主通道抛错、返回非 2xx、超时、结构化输出不符合 schema、`finishReason === "content-filter"`，或者主通道熔断器处于打开状态。调用方主动取消（客户端断开、服务关闭）不切换，也不计入熔断。
4. **超时：主通道 30 s，兜底 45 s**（`LLM_*_TIMEOUT_MS`）。没用 youtube-dubbing-proxy 的 10 s：简报是一次性输出几千字的结构化 JSON，Vercel 实测单次 11.3 s，10 s 会把正常请求判成超时。流式调用中这个值是相邻两个分块之间允许的最长间隔。
5. **熔断器每个通道一个，参数与 youtube-dubbing-proxy `openAiWrapperConfigTemplate` 相同：** 基于次数的滑动窗口 5 次，5 次全部失败（100 %）即打开；打开 30 s 后半开，放行 2 次试探调用，两次都成功才关闭，任一失败重新打开 30 s。主通道打开期间请求直接走兜底，不再碰主通道。
6. **流式（`/v1/llm/qa`）只能在第一个文本 token 之前切换。** 实现上先从主通道的流里拉出第一个非空文本块再提交响应；在这之前失败就换兜底，两个都失败返回 502。第一个 token 之后出错只结束当前流，不拼接另一个通道的回答，由客户端提示并重试。
7. **每次逻辑调用输出一行 JSON 日志**（`msg: "llm_call"`）：任务、最终通道、耗时、是否切换、切换原因（`error | timeout | content_filter | schema | circuit_open`）。简报把产出通道写进 `briefs.llm_channel`，`llm_calls` / `rewritten` / `supplemented` 记录是否触发了覆盖率重写与补充说明。

## 依据（实测，2026-09-25，同一份简报请求）

- CLIProxy `gemini-3.8-flash-high(low)` + `reasoning_effort: none`：3.3 s。
- CLIProxy `gemini-3.8-flash-high`：3.5 s。
- Vercel AI Gateway `google/gemini-3.8-flash`（不传推理参数）：11.3 s。
- 以上全部 `finish_reason = stop`，JSON 均通过 schema 校验。
- `pnpm brief:eval` 跑 5 份真实 Codex 汇报（主通道）：critical 事实覆盖率全部 100 %，口播字数占原文 6 %～11 %，每份一次调用约 5.5～6.6 s；同一份汇报主 / 兜底通道各跑一次都通过。
- Gemini 的结构化输出会把可空字符串字段写坏：`recommendedOptionId` 应为 `"a"` 时经常返回 `"aToString"`、`"a-保留 v1 三个月过渡"`，`reason` 被省略。因此发给模型的 schema 里这两个字段是普通字符串（空串表示没有推荐），服务端再把不指向任何选项的推荐置为 null。

## 备选与放弃原因

- 只用 CLIProxy：依赖本机隧道和第三方反代，单点故障时整通电话降级成念原文。
- 只用 Vercel AI Gateway：比 CLIProxy 慢 3 倍多，且按量计费；只适合做兜底。
- 流式中途切换通道续写：两个模型的前后半句拼在一起，语义和口吻都会断裂，宁可让用户重问。

## 影响

- 新增环境变量 `LLM_PRIMARY_*`、`LLM_FALLBACK_*`（见 `.env.example`），key 只放服务端 `.env`。
- 熔断状态在进程内，多实例部署时各自统计。
- 主通道长时间不可用时，简报延迟从约 6 s 上升到约 18 s（兜底通道）。
