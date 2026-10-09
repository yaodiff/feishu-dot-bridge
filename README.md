# Feishu ↔ 我的 dot

把自己的飞书机器人私聊接到已有的 dot。每个人在自己的主机上运行一套 bridge，使用自己的飞书应用、私有数据库和官方 OpenAI Tunnel；不提供统一托管或公开注册服务。

[English](README.en.md) · [个人部署](docs/DEPLOYMENT.md) · [安全](SECURITY.md) · [验收清单](docs/ACCEPTANCE.md)

## 当前支持

- 一套安装、一个固定主人、一个飞书 app/tenant、一个当前私聊绑定和一条有效事件订阅
- 官方飞书 SDK WebSocket 入站、一次性私聊配对、认证 MCP 工具和签名事件回调
- 普通文字与富文本帖子的有界纯文字展开；富文本中的链接不会自动访问，相同 `content_v2` 副本不会重复显示
- 本人事件恢复读取、固定原消息回复，以及经授权向当前绑定私聊发送带来源标签的 ChatGPT 文字副本
- 持久化 inbox/outbox、消息去重、有限重试、明确的 `pending` / `sent` / `uncertain` 状态，以及启发式敏感凭据文字省略
- 默认关闭的 PNG/JPEG 图片输入；开启后可读取新图片及富文本中最多四张内嵌图片，经过本地解码、去元数据和重编码
- 显式受控代理模式、callback 连接池和离线维护命令

默认文字模式提供 9 个 MCP 工具。`FEISHU_MEDIA_INPUT=images-v1` 增加 `get_event_image`，可使用 1 起始的 `image_index` 选择内嵌图片。音频、语音转写、模型运行时和媒体发送均不包含在本项目中。

## 实验性状态与宿主要求

短时实网测试已观察到普通文字双向流转及事件恢复读取；这不是 24/7 可靠性认证。持续事件唤醒、实际宿主图片摄取、真实 callback 连接复用收益、重启恢复和每个账号的产品兼容性仍需逐安装验收。`sent` 表示对端 API 接受，不证明客户端显示或已读；callback 2xx 也不证明 dot 已处理。

选择能长期运行的主机，提供持久磁盘、出站 HTTPS 与 WebSocket、进程监管、私密备份及容量/故障告警。每个数据库只能有一个 bridge 进程；同一飞书应用必须只有一个事件消费者，或把桥接逻辑整合进原消费者。[OpenAI 官方宿主指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#choose-where-to-run-tunnel-client)要求 Tunnel 客户端位于可访问私有 MCP 的信任边界内，并列出 VM/systemd 与 Kubernetes 等部署方式。

2026 年 10 月 8–9 日的开发测试曾观察到 dot 云端会话消失和网络策略拒绝。这些是当时环境的已观察约束，不代表所有 dot 云端环境永久无法承载服务，也不构成长期开机或磁盘持久性的保证。

仅使用飞书 WebSocket 收信不需要公开 HTTPS 飞书事件回调；普通 Feishu API 调用仍需要相应凭据、权限和出站连通性。MCP Tunnel、公开 MCP 和 OAuth 的访问要求各自独立，见[部署指南](docs/DEPLOYMENT.md)。

## 快速检查

文字运行时需要 POSIX 主机（Linux/macOS）、Node.js 24+ 和 npm。图片运行时另外要求 Linux `/usr/bin/prlimit` 及锁定版本 `sharp` 0.35.5；预检不通过会停止，不回退到无资源限制的解码。

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

完整测试套件还需要 Linux、`/usr/bin/prlimit`、`openssl` 和 `mkfifo`（包括图片/维护/传输测试）；macOS 文字运行时支持不代表完整测试可在 macOS 执行。

演示使用独立临时实例、合成密钥和明确标记的模拟服务；测试中的 TCP/TLS 服务仅在本机 loopback 上运行，不连接真实飞书或 dot。测试不等于实网验收。

## 在自己的主机安装

```sh
npm run init:personal
```

主动运行此命令会生成私有 `.env`、单应用配置、固定安装 ID 和随机密钥；发现已有 `.env`、`config` 或 `data` 时拒绝覆盖。然后：

1. 在本机填写已核实的飞书 app/tenant 和现有 App Secret，确认唯一消费者后再启用 `websocketExclusiveConsumer`
2. 启动 `node --env-file=.env dist/src/main.js`，保持精确 loopback 监听
3. 按[个人部署指南](docs/DEPLOYMENT.md)配置本人专属官方 Tunnel，转发到 `http://127.0.0.1:3000/mcp` 并注入本地 `X-Bridge-Token`
4. 在已有 dot 中连接、检查工具目录、完成私聊配对，再明确授权事件订阅及回复/镜像范围

连接界面选择 “None” 仅表示不另走 OAuth。后端始终校验本机密钥；任何能使用这条 Tunnel 的人都会被视为安装主人。必须核实仅本人可用，不能分享为公共或多人插件。初始化不会创建 Tunnel、飞书应用、OAuth grant 或平台权限。

## 安全与运维边界

- 个人模式只监听 `127.0.0.1` 或 `::1`，无默认密钥或跳过认证开关；[OAuth 兼容模式](docs/OAUTH_COMPATIBILITY.md)需显式选择
- `INSTALLATION_ID` 决定固定主人；静态密钥不自动每小时过期，单次内部授权/订阅租期最多一小时
- 敏感凭据文字检测可能漏报或误报；图片去元数据不检测画面中的秘密，也不授权披露敏感内容
- SQLite 中的消息正文未做应用层加密。保护主机、私有文件、持久卷和备份；不要把生产秘密、消息或数据库放进仓库
- `.private/` 的忽略规则仅帮助避免误提交，不是加密，也不会清除已跟踪文件或 Git 历史
- schema v2 升级前取得一致备份。保留投递状态并优先修复升级后的代码，不要把旧二进制直接指向新数据库
- `uncertain` 必须先核对目的端，不盲目重发。解绑不能撤回已发送请求，且没有跨平台 exactly-once 保证
- [Linux 离线维护](docs/OFFLINE_MAINTENANCE.md)仅清理符合条件的旧收件历史；保留全部回执去重键和镜像行/正文，不是完整 30 天删除或隐私擦除

不支持群聊路由、ISV 分发、原生用户气泡复制、编辑/删除/已读同步、历史回填、全媒体镜像或多副本高可用。本项目也不提供 ChatGPT 原生消息捕获、通用启动器或持续会话监管；调用方需通过其支持的工具和明确授权完成文字镜像。

## 文档

- [本人事件读取](docs/OWNED_EVENT_READS.md)与[文字镜像](docs/TEXT_MIRROR_V1.md)
- [图片输入](docs/MEDIA_INPUT_CANDIDATE.md)与[富文本帖子](docs/RICH_POST_INPUT.md)
- [Callback 受控代理](docs/CLOUD_PROXY_CANDIDATE.md)、[连接池](docs/CALLBACK_POOL_CANDIDATE.md)与[飞书受控代理](docs/FEISHU_MANAGED_PROXY.md)
- [协议与信任边界](docs/PROTOCOL.md)、[验收](docs/ACCEPTANCE.md)与[维护](docs/OFFLINE_MAINTENANCE.md)

## 许可证

项目源码采用 [MIT](LICENSE)。图片依赖 `sharp` 使用 [Apache-2.0](https://github.com/lovell/sharp/blob/main/LICENSE)，上游 libvips 使用 [LGPL-2.1-or-later](https://github.com/libvips/libvips/blob/master/LICENSE)。这不等于预编译包的整体许可证：[锁文件](package-lock.json)中的 `@img/sharp-libvips-linux-x64` 1.3.4 声明为 `LGPL-3.0-or-later`，其他平台包也有各自或组合许可证，须以实际安装包的声明和 notices 为准。分发预装依赖、容器或其他二进制产物前，核对实际包含的第三方组件、许可证、声明及适用的源码/再链接义务；不能把整个二进制包视为仅 MIT。源码仓库不捆绑这些原生二进制。
