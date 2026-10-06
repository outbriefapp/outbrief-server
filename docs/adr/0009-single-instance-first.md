# ADR 0009：先单实例上线，有压力再引入 Redis 做多实例

- 状态：已采纳（2026-10-01，YOUT-233）
- 决策者：zhibo li
- 延续：ADR 0003（存储用 MySQL）、ADR 0008 “影响”最后一条（在线状态、限流、设置转发都在进程内存里）

## 背景

server 只做中转：不调用大模型，也不解密（ADR 0005、0007），每个请求就是几次 MySQL 读写加上转发一段密文。数据（账号、设备、配对码、来电、回复）都在 MySQL 里，但下面这些实时状态只在**进程内存**里，所以同一时刻只能跑一个实例：

| 位置 | 多实例下会怎样 |
|---|---|
| `EventStore` 的订阅者（`#listeners` / `#deliveryListeners`） | 汇报打到实例 A、手机的 SSE 连在 B：来电不会实时推送 |
| `DaemonGateway` 的连接表 | 回复打到 A、daemon 连在 B：回复一直 `queued` 到过期；A 认为这台电脑离线 |
| `DaemonGateway.requestSettings` | 设置请求落在 A、daemon 连在 B：直接 `409 machine_offline` |
| `EventStore.#inserting`（进程内串行插入） | 两个实例并发插入时 AUTO_INCREMENT 可能乱序提交，SSE 跳过 `seq <= lastSent` 会**永久漏掉**一通来电 |
| `StreamRegistry`（App 在线、移除设备时断开 SSE） | 在线状态不准；移除的设备在别的实例上的 SSE 不断开 |
| `RateLimiter` | 限额被放大成实例数倍，配对码 / 认领码防猜解变弱 |
| `AccountStore` 的认领码和串行建账号 | 每个实例的认领码不同；两个实例可能同时认领成功 |
| 启动时的 `migrate()` | 多个实例同时启动时并发执行同一个迁移 |

`expireReplies` 每个实例都跑也没关系（`UPDATE … WHERE status = 'queued'` 本身幂等）。

单个 Node 进程撑几千条 SSE / WebSocket 长连接没有问题，瓶颈出现前先给机器加 CPU、内存（纵向扩容）就够用很久。现在为多实例改造，换来的只是用不上的容量，代价是多一个 Redis 组件、多一套跨实例逻辑。

## 决策

1. **先单实例 + MySQL 上线**，代码不为多实例改造。上表的问题都只在同时运行两个以上实例时出现；单实例下进程内的串行插入、在线状态、限流都是正确的。
2. **部署约束**（违反任何一条都会触发上表的问题）：
   - 副本数固定为 1，不开自动扩容。
   - 发布用“先停旧的、再起新的”（例如 k8s `strategy: Recreate`、`replicas: 1`），不用滚动更新、蓝绿部署或任何会让新旧版本同时在线的方式。
   - 接受发布、重启时几秒到十几秒的中断：App 和 daemon 会自动重连，来电靠 `Last-Event-ID` 续传，回复在 MySQL 里排队，不丢数据，只是晚一点到。
   - MySQL 是唯一的数据源，必须有备份。
3. **出现以下任意一条时，再改成多实例**：
   - 纵向扩容后 CPU 或事件循环延迟仍然长期偏高；
   - 长连接数接近单机上限（上万量级）；
   - 业务要求发布和单机故障时不中断服务（高可用）。
4. **到时的做法：MySQL 仍是唯一数据源，Redis 只做消息总线和连接路由**，也就是业界通用的“长连接网关 + 连接路由表 + 共享消息总线”模式（SignalR / Socket.IO 的 Redis backplane 同理）。Redis 里只放通知和“谁连在哪个实例”，丢了也能从 MySQL 恢复；经过 Redis 的仍然只有密文和路由字段，端到端加密不受影响。协议不变，App 和 daemon 不用改。
   - **P0（只用 MySQL）**：插入来电时在事务里 `SELECT … FROM accounts WHERE id = ? FOR UPDATE`，替代进程内的 `#inserting`：同一账号按提交顺序拿到递增的 `seq`，`seq` 仍是全局自增，协议不变；认领码存进数据库、建账号加锁；`migrate()` 加 `GET_LOCK`（或部署时单独跑 `pnpm db:migrate`）。
   - **P1（`ioredis`）**：抽出扇出 / 路由接口，内存版和 Redis 版各一份。提交后往 `account:{id}` 发只带 `seq` 的轻通知，各实例从 MySQL 拉 `seq > lastSent` 再推；daemon 和 App 的连接写入路由表（带 TTL、靠心跳续期），回复入队、设置请求通过 `node:{实例ID}` 收件箱转给连接所在的实例；移除设备时广播，让各实例断开本机连接。
   - **P2**：限流换成 `rate-limiter-flexible` 的 Redis 后端；补“两个 server 实例 + 一个 Redis”的集成测试（A 收到汇报，B 上的 SSE 收到来电；回复打到 A，daemon 连在 B 也能送达）。
   - 是否配置 Redis 是部署选择：不配时就是单实例、内存实现；配了却连不上时启动失败，不悄悄退回内存实现。

## 放弃的方案

- **现在就上 Redis 多实例**：多一个要运维的组件和一套跨实例逻辑，当前规模用不上；私有化部署也会多一个依赖。
- **Centrifugo**（独立实时消息服务）：能接管 SSE 扇出和在线状态，但要多部署一个服务、换客户端协议；daemon 的“按电脑下发回复 + 回执 + 设置请求 / 应答”它不覆盖，还得自己做。
- **Socket.IO + Redis Adapter**：要把原生 `ws` + SSE 整体换协议，App 和 daemon 都得改。
- **Ably / Pusher 等托管服务**：多一个外部依赖和费用，私有化部署要多配一套东西。
- **改用 Postgres LISTEN/NOTIFY**：不加组件也能跨实例通知，但要先从 MySQL 迁到 Postgres，代价比加 Redis 大。

## 影响

- 部署配置必须写死单副本 + 先停后起，改部署前先看本 ADR。
- 代码里“run one server instance”的注释（`src/eventStore.ts`、`src/daemon/gateway.ts`、`src/accounts/rateLimit.ts`）指向的就是这条约束。
- 发布、重启期间有短暂中断，没有高可用。
