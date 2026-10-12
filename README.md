# outbrief-server

[English](README.en.md)

OutBrief 服务端：只做中转。接收 outbrief-daemon 加密好的汇报，推给客户端“来电”；挂断后把客户端加密好的回复交还给 daemon。服务端没有密钥，看不到汇报、简报和回复的内容；没有登录，账号是匿名的，设备之间用配对码加入同一个账号。

使用文档、安装步骤和架构决策都在官网：**<https://outbriefapp.com>**

- [Server 自部署（部署、环境变量、本地开发）](https://outbriefapp.com/docs/server/)
- [快速开始（安装顺序与设备配对）](https://outbriefapp.com/docs/quick-start/)
- [架构决策记录（ADR）](https://outbriefapp.com/docs/adr/)

## License

[OutBrief License](LICENSE)（基于 Apache License 2.0 并附加条件，参照 [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)）。
