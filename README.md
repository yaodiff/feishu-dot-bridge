# Feishu ↔ dot Bridge

让不同用户把自己的飞书私聊，安全地绑定到各自现有的 personal dot。

**状态：可运行的实验性开源 MVP。** 已完成本地 MOCK 集成与安全回归测试，尚未完成真实飞书 + ChatGPT/dot 的端到端验收。不是官方 OpenAI 或飞书项目，不应直接当作已审计的生产服务。源码采用 [MIT 许可](LICENSE)；使用时请遵守许可及依赖义务。

[English summary](README.en.md) · [部署](docs/DEPLOYMENT.md) · [安全边界](SECURITY.md) · [协议与证据](docs/PROTOCOL.md) · [上线验收](docs/ACCEPTANCE.md)

## 它如何工作

1. 每个人在自己的 dot 中连接本服务的 OAuth 插件账号
2. dot 调用 `begin_binding`，用户把一次性 `/bind …` 命令发到飞书机器人私聊
3. 桥接器用飞书验证过的 `(app_id, tenant_key, open_id)` 与 OAuth 的 `(issuer, subject)` 建立一对一关系
4. 用户让自己的 dot 订阅 `feishu.message.created`，并明确批准如何回复
5. 飞书文字消息经过持久化队列，通过 **MCP Events** 发给该 dot 所在订阅
6. dot 调用 `reply_to_feishu`，服务只能回复该账号收到的原始消息，不能任意指定收件人

这是事件订阅 + MCP 工具回传，不依赖假想的 “dot chat REST API”，也不启动另一个模型冒充用户原来的 dot。处理节奏由 dot 决定，不保证即时对话延迟。

## 当前支持

- 多用户各自绑定、各自订阅、各自回复；每个 OAuth 账号一条有效绑定，每条绑定一个有效订阅
- 多个显式配置的飞书/Lark **企业自建应用**；每个 app ID 固定一个已核实的 tenant key
- MVP 只处理用户发给机器人的 **p2p 文字消息**
- 官方 MCP v2 SDK `@modelcontextprotocol/server@2.3.0`，协议 `2026-07-28`
- 外部 OAuth2.1 身份提供商，JWT/JWKS 验证，scope `bridge:use`
- 飞书签名、密文、时间窗、tenant/app 校验；机器人消息与群消息直接忽略
- SQLite 持久化绑定、收件箱、订阅、发件队列；`message_id` 去重，按队列保持投递顺序，有限重试
- Standard Webhooks 签名与 challenge；callback HTTPS、明确主机白名单、公共 IP 校验、连接时 DNS 固定、拒绝重定向
- 取消绑定会取消未开始的任务；只读 `delivery_status` 区分 pending/sent/dead/uncertain

**不包含：** 飞书应用商店 ISV 安装授权/跨企业 token 管理、群聊映射、文件/图片/卡片、音频转写、原生实时语音通话、公开账号管理后台、多副本 worker、高可用数据库、完整监控和自动化 IdP 撤销通知。`AudioAdapter` 只是未来扩展接口，没有启用音频功能。

## 五分钟跑本地演示

需要 Node.js 24+ 和 npm。

```bash
npm ci --ignore-scripts
npm test
npm run demo
```

演示完全离线，使用明确标为 `MOCK` 的 dot 接收器和飞书发送器，不需要 API Key，不会访问真实账号或发送消息。19 项初始测试覆盖多用户路由、绑定、越权、JWT、SSRF、飞书签名、重放、轮换、取消、持久化和实际 MCP2 HTTP 契约；以当前 `npm test` 输出为准。

## 运行真实服务需要什么

```bash
cp .env.example .env
mkdir -p config
cp examples/feishu-apps.json config/feishu-apps.json
# 编辑本地配置；生成 STORAGE_KEY；通过秘密管理器提供真实密钥
npm ci --ignore-scripts
npm run build
node --env-file=.env dist/src/main.js
```

启动会拒绝缺失配置。没有 “跳过 OAuth” 或 “生产 mock mode” 开关。

你还需要自行准备：

- 一个域名、可信 HTTPS 与持久化磁盘
- 已开启机器人的飞书企业自建应用，以及事件订阅、加密密钥和最小消息权限
- 能完成 ChatGPT OAuth2.1 连接的身份提供商；本项目是资源服务器，不是 OAuth 授权服务器
- 支持 MCP Events 的 dot/工作区权限，手动配置并连接本 MCP 插件
- 来自实际 ChatGPT 订阅的 callback 主机名白名单；不要填猜测地址或 `*`

完整步骤与配置说明见 [部署指南](docs/DEPLOYMENT.md)。不要把 ChatGPT 密码、会话 cookie、OpenAI API Key 或飞书 App Secret 发到聊天里。

## 用户配对步骤

1. 在自己的 dot 中连接此插件，用自己的桥接账号完成 OAuth
2. 对 dot 说：“帮我绑定飞书，生成配对命令”
3. 只在目标飞书机器人私聊粘贴 dot 给出的命令；5 分钟内有效，一次使用，不要转发
4. 回到 dot 说：“检查我的飞书绑定状态”。MVP 不自动向飞书发送配对确认消息
5. 对 dot 说：“订阅我已绑定飞书的文字消息，并按我的要求通过原会话回复”。由你决定回复范围；敏感行动仍需要相应确认
6. 发一条非敏感测试消息，确认原来的 dot 收到事件，再检查飞书回复及 `delivery_status`

更换绑定应先请求 `unlink_binding`。同一个飞书身份不能被另一账号抢占。绑定码泄漏可能导致错误配对，应立即停止使用该码并在 dot 重新生成。

## MCP 接口

- POST `/mcp`：工具与事件方法，共用 OAuth 认证；只接受现代 MCP2 请求
- GET `/.well-known/oauth-protected-resource/mcp`：OAuth 资源元数据
- POST `/feishu/events/<appId>`：飞书加密事件
- GET `/healthz`：仅进程健康，不代表外部服务已连通

工具：`begin_binding`、`binding_status`、`unlink_binding`、`reply_to_feishu`、`delivery_status`

事件：`feishu.message.created`，订阅参数 `{ "binding_id": "..." }`

## 可靠性说明

`pending` 只表示入队，`sent` 表示对端已接受；dot callback 的 2xx 不代表 dot 已完成回复。消息采用至少一次投递，不能保证跨服务绝对 exactly-once。Feishu 回复使用稳定 uuid，并在首次发送 55 分钟后停止自动重试，防止超出上游去重窗口后盲目重发；`uncertain` 必须人工核实。

只支持单进程/单 worker 使用一个数据库，不能启动多个副本。队列保持每个订阅的投递顺序，以及回复入队顺序；不承诺 dot 异步任务完成顺序。事件没有协议级历史 replay（cursor 为 null），未订阅或订阅已过期时的消息不会在以后补推。

## 贡献与发布

先跑 `npm test`、`npm run demo`，遵循 [贡献说明](CONTRIBUTING.md)。仓库已提供 GitHub Actions 和 Docker 配置。公开源码不代表服务已部署或完成真实账号联调。仓库不包含真实账号密钥。

投入真实使用前请完成 [验收清单](docs/ACCEPTANCE.md)，并保留 [MIT 许可](LICENSE) 要求的版权及许可声明。
