# outbrief-server

[English](README.en.md)

OutBrief 服务端：只做中转。接收 outbrief-daemon 加密好的汇报（含口播简报），暂存进 MySQL，再通过 SSE 推给客户端“来电”；挂断后把客户端加密好的回复排队交还给 daemon。服务端没有密钥，看不到汇报、简报和回复的内容（端到端加密，[ADR 0007](docs/adr/0007-end-to-end-encryption.md)）；来电结束就删掉密文，历史记录只存在用户自己的设备上（[ADR 0006](docs/adr/0006-relay-without-login-or-history.md)）；没有登录，账号是匿名的，每台设备一把令牌，设备之间用配对码加入同一个账号（[ADR 0008](docs/adr/0008-anonymous-accounts-and-device-pairing.md)）。服务端不调用任何大模型：简报由用户电脑上的 [`outbrief-daemon`](https://github.com/outbriefapp/outbrief-daemon) 生成，通话中的问答在客户端里做，都用用户自己的大模型配置（[ADR 0005](docs/adr/0005-llm-on-user-devices.md)）。

OutBrief 由三个仓库组成，本地统一放在 `~/work/code/outbrief/`：

| 仓库 | 作用 |
|---|---|
| `outbrief-server`（本仓库） | Hono 服务端 + MySQL；方案文档与 ADR |
| [`outbrief-app`](https://github.com/outbriefapp/outbrief-app) | Tauri 2 + React 19 客户端（桌面 / 移动） |
| [`outbrief-daemon`](https://github.com/outbriefapp/outbrief-daemon) | 每台 Agent 电脑上的常驻进程，含 Claude Code / Codex 完成回调（原 `outbrief-hook` 已并入） |

方案：[`docs/proposal.html`](docs/proposal.html)；决策记录：[`docs/adr/`](docs/adr/)。

## 安装顺序

来电只在同一个匿名账号里转发。推荐让跑 Agent 的那台电脑上的 daemon 创建账号，桌面 App 和手机 App 都加入这个账号。

1. **部署本仓库（server）**。只跑一个进程。私有化部署（默认）在还没有主人时，每次启动的日志里打印一次性认领码 `Claim code: XXXX-XXXX-XXXX`。记下服务地址。手机和别的电脑要能访问这个地址；`http://127.0.0.1:8787` 只有部署 server 的那台机器自己能用。给手机配对时，daemon 和 App 里填局域网 IP 或公网 `https://` 地址。命令见下方「部署」。
2. **在跑 Agent 的电脑上安装 [outbrief-daemon](https://github.com/outbriefapp/outbrief-daemon)**。`pnpm install` 之后执行 `node src/cli.ts login --server <服务地址>`，输入认领码。终端打出二维码和 6 位配对码。macOS 上接着执行 `node src/cli.ts install`（开机自启，并写入 Claude Code / Codex 的 Stop hook）。`install` 把 node 和 `src/cli.ts` 的绝对路径写进 launchd，仓库留在原地。
3. **在同一台电脑上安装桌面 App（[outbrief-app](https://github.com/outbriefapp/outbrief-app)）**。`pnpm tauri build`，安装包在 `src-tauri/target/release/bundle/`。开发时用 `pnpm tauri dev`。daemon 已经在运行时，桌面端第一次打开会自动加入这台 daemon 的账号。
4. **安装手机 App**。同一仓库，Android / iOS 工程在本机生成后再编译：`pnpm tauri android init`，然后 `pnpm tauri android dev` 或 `pnpm tauri android build`；iOS 用 `pnpm tauri ios init`，然后 `pnpm tauri ios dev` 或 `pnpm tauri ios build`。需要 [Tauri 的移动端环境](https://tauri.app/start/prerequisites/)。仓库里没有应用商店安装包。打开已配对设备的「设置 → 设备 → 添加设备」，或在电脑上执行 `node src/cli.ts pair`，用手机摄像头扫二维码。

### 配对

没有登录，也没有共享口令。谁先装谁建账号，后来的设备用 6 位配对码加入。配对码 10 分钟有效、只能用一次。二维码和配对链接是 `outbrief://pair?server=<服务地址>&code=<6位>&key=obk1_…`。服务地址和端到端密钥由设备直接交给设备，server 看不到密钥。

| 已在账号里 | 要加入的设备 | 怎么做 |
|---|---|---|
| 这台电脑的 daemon 正在运行 | 同一台电脑的桌面 App | 自动。App 用本机 `~/.outbrief/local-api.key` 向 `127.0.0.1:8790` 要配对码和密钥 |
| 桌面 App，或 daemon（`node src/cli.ts pair`） | 手机 App | 手机扫「设置 → 设备 → 添加设备」或终端里的二维码 |
| 手机或另一台电脑上的 App | 一台电脑的 daemon | 在「添加设备」页复制命令，在那台电脑上执行 `node src/cli.ts login 'outbrief://pair?…'` |
| 任意已配对设备 | 另一台电脑的桌面 App | 桌面端把配对链接贴进欢迎页。桌面端不开摄像头 |
| 只拿到 6 位数字 | daemon 或 App | 再输入「设置 → 加密」里的同一句话（至少 12 个字符）。没设过这句话时，用带 `key=` 的二维码或配对链接 |

先打开 App、由 App 创建账号也可以：欢迎页填服务地址和认领码，点「创建新账号」，再用「添加设备」里的链接在电脑上 `login`。同一台电脑上的 daemon 配对并运行之后，这台电脑的桌面 App 加入的是 daemon 所在的账号。

只有手机、不装桌面 App：做完第 1、2 步，用手机扫 daemon 登录时终端里的二维码。手机上的 Multica、大模型、汇报语言经 server 加密转给这台电脑的 daemon，电脑要在线。

公共云端把 `OUTBRIEF_OPEN_SIGNUP=true` 打开后，第一台设备直接建账号，认领码不用填。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 健康检查（无需鉴权） |
| `GET` | `/v1/server` | 无需鉴权。`{ signup }`：`open`（谁都能建账号）/ `claim`（还没人认领，第一个账号要带认领码）/ `closed`（只能用配对码加入） |
| `POST` | `/v1/accounts` | 无需鉴权。`{ device: { name, kind }, claimCode? }` → `201 { accountId, device, token }`：建匿名账号和它的第一台设备；`403 signup_closed` / `invalid_claim_code`，`429 rate_limited` |
| `POST` | `/v1/pairing/redeem` | 无需鉴权。`{ code, device: { name, kind } }` → `201 { accountId, device, token }`：用 6 位配对码加入账号；`404 invalid_pairing_code`，`429 rate_limited` |
| `GET` | `/v1/me` | 令牌所属的账号和设备（也用来检查令牌是否还有效） |
| `POST` | `/v1/pairing` | 生成配对码 `{ code, expiresAt }`（10 分钟，只能用一次） |
| `GET` | `/v1/pairing/:code` | 配对码有没有被用、被哪台设备用了（显示配对码的设备用它等待） |
| `GET` | `/v1/devices` | 本账号的所有设备（`kind`、`online`、`current`） |
| `DELETE` | `/v1/devices/:id` | 移除本账号的一台设备：令牌立即失效，连接断开。别的账号的设备一律 `404` |
| `POST` | `/v1/devices/:id/settings` | `{ requestId, sealed }` → `{ sealed }`：把加密的设置请求转给这台电脑的 daemon，返回它加密的结果（手机改 daemon 设置、派单用）；`sealed` 最长 1.8 亿字符（派单的图片一张一张转，每张最大 100 MB，和 Multica 的上传上限一致，YOUT-226），其他密文仍是 200 万；`409 machine_offline`，`504 machine_timeout` |
| `POST` | `/v1/events` | 上报一条加密的汇报 `{ source, occurredAt?, sealed }`；返回 `201` + `AgentEvent`，立即推送给本账号的设备。明文字段（`content` 等）一律 `400` |
| `GET` | `/v1/events?after=<seq>` | 轮询：本账号 `seq` 之后仍待接听的汇报（密文） |
| `GET` | `/v1/stream` | SSE；事件名 `agent-event`，`id` = `seq`，支持 `Last-Event-ID` 续传；只推本账号的来电和投递状态；另推 `call-status`：某台设备接起或结束了一通来电（不带密文），还在响的设备停下；重放时不再推别的设备已接的来电 |
| `POST` | `/v1/events/:id/status` | 客户端回写 `completed` / `dismissed` / `acknowledged`（未接来电「全部知悉」），同时删掉这通来电的密文（`sealed: null`）。只有还在响、或由这台设备接起的来电能结束；别的设备已经接了 `409 answered_elsewhere`，已经结束 `409 already_ended`（同一台设备重复回写同一结果是 200） |
| `POST` | `/v1/events/:id/answer` | 这台设备接起来电。账号下所有设备同时响铃，第一台接的拿到来电（`handledBy`），别的设备收到 `call-status` 停止响铃；晚到的 `409 answered_elsewhere` |
| `POST` | `/v1/events/:id/reply` | 挂断后回复 `{ sealed }`：排队交给上报这通来电的机器的 daemon。daemon 解密后接着原会话运行 Agent，或者（Multica 汇报）用本机保存的 Multica 令牌发评论 |
| `GET` | `/v1/daemon` | daemon 令牌。WebSocket：下发回复、转发设置请求，收回执行结果 |
| `POST` | `/v1/daemon/events` | daemon 令牌。daemon 转发本机 Agent 的汇报 `{ source, occurredAt?, sealed }` |
| `POST` | `/v1/daemon/multica-reports` | daemon 令牌。daemon 读到的一个完成的 Multica 任务 `{ taskId, occurredAt?, sealed }`；同一账号里同一任务第二次上报 `409 duplicate_task` |

### 账号和设备

- 没有登录，也没有共享口令。账号只是一个 id；每台设备（App、手机、daemon）有自己的 Bearer 令牌（App `oba_…`，daemon `obm_…`），server 只存 SHA-256，可以在任意一台设备上逐台移除。`/v1/daemon/*` 只认 daemon 的令牌。
- 来电、回复、电脑、投递状态都按账号隔离，SSE 和 WebSocket 只推给同一账号的设备。
- 谁先装谁建账号，其他设备用 6 位配对码（10 分钟、一次性）加入。二维码 / 配对链接 `outbrief://pair?server=…&code=…&key=obk1_…` 同时带上端到端密钥，由设备直接传给设备，server 看不到。输错配对码、认领码会被限流。
- 谁能建账号取决于部署：公共云端设 `OUTBRIEF_OPEN_SIGNUP=true`，开放注册、限流；私有化部署默认关闭：还没有账号时 server 每次启动在日志里打印一次性**认领码**，第一个账号要填它，之后不再允许建新账号。原因见 ADR 0008。

服务端不保存、也不使用任何 Multica 令牌：Multica 令牌只存在用户电脑上的 outbrief-daemon 里，由它监听任务、上报汇报、发回复。请求 / 响应结构以 [`src/protocol.ts`](src/protocol.ts) 为准；`outbrief-app` 与 `outbrief-daemon` 各有一份镜像类型，改接口时一起改。

简报（`Brief`）由 outbrief-daemon 用本机配置的大模型生成，和汇报一起加密后提交。`protocol.ts` 里的 `SealedReport` / `SealedReply` / `Brief` 定义的是密文里面的内容，是 daemon 和客户端之间的约定，服务端既看不到也不校验。

### 端到端加密

- 汇报（标题、原文、`cwd`、`sessionId`、简报、Multica issue 信息）由 daemon 加密成 `sealed`；回复（内容和回到哪个会话 / 评论）由客户端加密；回复失败的原因由 daemon 加密。算法 AES-256-GCM，格式 `ob1.<keyId>.<iv>.<密文>`，见 ADR 0007。
- 密钥只在用户的 daemon 和客户端上：daemon 第一次启动随机生成，本机桌面端自动同步，也可以在客户端改成口令。服务端从来拿不到。
- 服务端看得到的明文只有路由要用的：来源、时间、上报的机器、Multica 任务 id（同一任务只来一次电）、状态、投递状态、Multica 回复评论 id。

### 服务端留下什么

- 待接听的来电：密文，直到某个客户端回写 `completed` / `dismissed` / `acknowledged`（未接来电「全部知悉」），然后删掉。
- 回复：排队期间保存密文，投递成功或失败后删掉，只留状态和（加密的）错误原因。
- 历史记录只在客户端本机。

## 环境变量

都不是必填，不需要 `.env`（[`.env.example`](.env.example) 只是列出可以改的默认值）。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OUTBRIEF_DATABASE_URL` | `mysql://outbrief:outbrief_local@127.0.0.1:3306/outbrief` | 部署平台注入；默认连本机 docker 的 `outbrief` 库 |
| `PORT` | `8787` | 监听端口 |
| `OUTBRIEF_OPEN_SIGNUP` | `false` | `true`：谁都能建账号（公共云端）。`false`：第一个账号要用日志里的认领码，之后关闭注册 |
| `OUTBRIEF_TEST_DATABASE_URL` | `…/outbrief_test` | 测试库，必须以 `_test` 结尾 |

## 部署

只能运行**一个实例**：在线状态、SSE 推送、设置转发、限流都在进程内存里（[ADR 0009](docs/adr/0009-single-instance-first.md)）。副本数固定为 1、不开自动扩容；发布用“先停旧的、再起新的”（k8s `strategy: Recreate`），不要滚动更新或蓝绿部署，否则新旧版本同时在线时会漏推、漏接来电。MySQL 要有备份。安装顺序和桌面 / 手机如何配对见上文「安装顺序」。

### 直接运行

需要 Node ≥ 22.18、pnpm 9、MySQL 8。表在进程启动时按 `db/migrations/` 自动迁移。

```bash
pnpm install
OUTBRIEF_DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/outbrief' PORT=8787 pnpm start
```

`OUTBRIEF_DATABASE_URL` 由部署环境注入。上面的用户名和口令是占位符，生产使用自己的账号，不要把连接串写进仓库。本地开发库的口令只在 [`db/bootstrap.sql`](db/bootstrap.sql)。

还没有账号时，日志打印 `Claim code: XXXX-XXXX-XXXX`。第一台设备（App 欢迎页或 `outbrief-daemon login`）填这个码。认领之后注册关闭，其他设备用配对码加入。公共云端设 `OUTBRIEF_OPEN_SIGNUP=true`。

健康检查：`GET /healthz`。

### Railway

仓库里的 [`railway.json`](railway.json) 写好了健康检查和重启策略。其余配置只能在 Railway 上设置：

- 加一个 MySQL 8 服务（镜像 `mysql:8.4`，卷挂在 `/var/lib/mysql`），只走私网，不开公网 TCP Proxy。
- server 的变量：`OUTBRIEF_DATABASE_URL` 引用 MySQL 服务的 `MYSQL_URL`（`${{MySQL.MYSQL_URL}}`），不要把连接串明文写进仓库或文档；`PORT=8787`。
- 副本数 1，并给 server 挂一个卷（比如 `/data`，代码不读写它）：Railway 不允许同一个服务的两个部署同时挂着卷，挂了卷发布时就会先停旧部署、再起新的，也开不了多副本，正好满足上面的单实例约束。
- 自定义域名按 Railway 给出的 CNAME 和 `_railway-verify` TXT 记录在 DNS 里添加；用 Cloudflare 时先只做 DNS 解析（灰色云朵），让 Railway 签发证书。

## 本地开发

需要 Node ≥ 22.18、pnpm 9、本机 MySQL 8（docker 容器 `some-mysql`）。

```bash
pnpm install
# 1. 建库和账号（只需一次，root 执行）
docker exec -i some-mysql mysql -uroot -p < db/bootstrap.sql
# 2. 建表（服务启动时也会自动执行）
pnpm db:migrate
# 3. 启动；还没有账号时日志里会打印认领码
pnpm dev
```

表结构只在 `db/migrations/NNN_*.sql` 里定义，按文件名顺序执行一次，已执行的版本记录在 `schema_migrations`。新增表或字段时新建一个迁移文件，不要改已执行过的文件。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm lint` / `pnpm format` | Biome 检查 / 自动修复 |
| `pnpm typecheck` | `tsc` |
| `pnpm test` | Vitest；连接 `OUTBRIEF_TEST_DATABASE_URL`（必须是 `*_test` 库，测试会清空表） |
| `pnpm db:migrate` | 执行未执行的迁移 |

## License

[OutBrief License](LICENSE)（基于 Apache License 2.0 并附加条件，参照 [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)）。
