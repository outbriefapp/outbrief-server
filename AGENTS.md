# 给 Agent 的规则

## 自测不能给用户打电话

本机正在运行的 server（`localhost:8787`）和 daemon（`127.0.0.1:8790`）是用户本人在用的环境：写进这个 server 的每一条汇报都会马上变成用户手机上的一通来电。Agent 任务还没结束时发的测试汇报，会让用户先接到一通“假电话”，等任务真正结束后再接一通（YOUT-201）。

- 不要向运行中的 server 发 `/v1/events`、`/v1/daemon/events`、`/v1/daemon/multica-reports`，也不要往 `outbrief` 库里直接插汇报。
- 不要向运行中的 daemon `POST /report`（要验证 daemon 用 `POST /report?dryRun=1`，见 outbrief-daemon 的 AGENTS.md）。
- 验证 server 用单元测试和集成测试（`OUTBRIEF_TEST_DATABASE_URL` 指向的 `_test` 库）。确实要走到“来电”的整条链路时，另起一个换端口、换数据库的 server，不要用用户正在用的那套。
- 需要用户亲自接电话验收时，在 Multica 评论里写清楚怎么触发，由用户自己触发。
