# 每人一套：个人主机部署

默认布局为同一可信主机上的 bridge 和官方 OpenAI `tunnel-client`。飞书使用官方 SDK 长连接入站；已有 dot 通过本人专属 Tunnel 调用 loopback MCP。只有显式 [OAuth 兼容模式](OAUTH_COMPATIBILITY.md)才需要外部身份服务。

## 1. 选择和检查主机

- 文字模式：Linux/macOS 等 POSIX 主机、Node.js 24+、npm
- 图片模式：另需 Linux `/usr/bin/prlimit`（通常由 util-linux 提供）、锁定的 sharp 原生依赖及足够内存
- 能长期运行 bridge 与 Tunnel，提供持久私有磁盘、进程监管、备份和故障告警
- 允许 Feishu API、WebSocket、OpenAI Tunnel 及已核实事件 callback 的必要出站连接；政策拒绝时联系环境管理员，不绕过网络限制
- 单个数据库只允许一个进程；单个飞书应用只允许一个事件消费者或原消费者中的组合处理器

[官方 Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#choose-where-to-run-tunnel-client)描述了在私有 MCP 信任边界内运行客户端的部署方式。临时开发会话的存活时间、磁盘和网络策略不能替代长期宿主验收，详见 [验收清单](ACCEPTANCE.md)。

飞书 WS 入站不需要公开 HTTPS 飞书回调；选择 webhook 入站才需让飞书能到达并验证其事件 URL。飞书 API 仍需有效凭据和权限。个人 MCP 由私有 Tunnel 接入，不开放公网监听。OAuth 身份服务及公开 MCP 的可达性需分别设计，不能从“WS 不需回调”推导出这些路径也无需访问配置。

## 2. 初始化私有配置

以下完整测试命令要求 Linux、`/usr/bin/prlimit`、`openssl` 和 `mkfifo`。macOS 可运行文字服务，但应在受支持的 Linux 环境执行完整验收测试。

```sh
npm ci --ignore-scripts
npm test
npm run init:personal
```

初始化只在主动调用时运行。它生成固定安装 ID、独立 256 位本机认证密钥与存储密钥，目录权限 `0700`、文件 `0600`，不打印秘密。已有 `.env`、`config` 或 `data` 时拒绝覆盖或采用旧实例。

默认生成/使用：

- `.env`：运行参数和私有密钥路径
- `config/feishu-app.json`：单个应用对象
- `config/bridge-token`：本机最后一跳密钥
- `config/storage-key`：加密数据库内 callback 签名密钥的密钥
- `data/personal.sqlite`：该安装的持久状态，首次启动时创建

配置、消息、数据库和备份不应提交 Git。`.private/` 等忽略规则仅避免一般误提交，不是加密，不能撤销已跟踪或已发布的数据。不要通过聊天、日志、命令参数或公开附件传递生产秘密。

在本机填写已核实的 `appId`、`tenantKey` 与现有 App Secret。每个秘密只能设置环境变量或相应 `_FILE` 之一；例如使用 `FEISHU_APP_SECRET_FILE` 前先删除空的 `FEISHU_APP_SECRET`。文件必须是本人所有、`0600` 的普通文件，不允许符号链接/FIFO。

## 3. 核实飞书消费者归属

初始化模板采用 `ingress: websocket`，并故意将 `websocketExclusiveConsumer` 设为 `false`。核实没有其他主机、容器或旧进程消费同一 app 后，才设为 `true`。配置值不证明远端消费者已被程序探测；同 app 多连接是分发，不是广播。

保持应用已有安全设置，不为 WS 重设 Encrypt Key 或 Verification Token。机器人仍需最小的私聊收信、发送/回复权限和 `im.message.receive_v1` 事件订阅。项目不会自动扩大权限。

若原应用还有其他事件、卡片或消息逻辑，应把 `authenticatedWebSocketMessageHandler` 与原消息 handler 组合，保留其他处理器；同名事件再次 `register` 会覆盖旧 handler。仅允许官方 SDK 的已认证 dispatcher 调用这个内部函数，不得挂成 HTTP 接口。先完成必要持久化再确认接收，不等待外部 dot 或发送 API。WS app 的 HTTP 事件入口返回 404。

## 4. 启动 bridge

```sh
node --env-file=.env dist/src/main.js
```

个人模式只允许精确 `127.0.0.1` 或 `::1`，默认端口 3000。`0.0.0.0`、`::`、`localhost`、LAN 或公网地址均被拒绝。手动 `ALLOWED_HOSTS` 必须与 loopback 地址和端口完全一致。

不得混用 `PUBLIC_URL`、OAuth 配置或 `FEISHU_APPS_FILE` 多应用数组。个人数据库若含其他 owner/app/tenant，会停止而不接管。迁移必须保留身份和一致状态，先停旧消费者，再启动新消费者。

`/healthz` 只表示进程存活。启动等待 WS `onReady`；终止性 SDK 错误会停止所有入口并非零退出，临时断线才由 SDK 重连。用主机已有的 systemd 等进程管理器监管 bridge 和 Tunnel，并验证重启策略；不要运行互相竞争的副本。

可选图片模式：

```sh
# 写入私有 .env；缺省值为 disabled
FEISHU_MEDIA_INPUT=images-v1
```

其他值均拒绝。此开关不代替图片处理/披露授权。启动前执行合成像素预检，缺少解码器或 Linux 资源限制即停止；详见 [图片输入](MEDIA_INPUT_CANDIDATE.md)。音频和转写不支持。

## 5. 配置本人专属官方 Tunnel

从[官方入口](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)取得和配置 `tunnel-client`。在官方安全流程中创建所需 Tunnel/runtime key，并核实关联的组织、工作区及使用者确实只有本人。此项目不会创建凭据或权限。

在 Tunnel 自己的私有配置中指定：

```sh
MCP_SERVER_URL=http://127.0.0.1:3000/mcp
MCP_EXTRA_HEADERS="X-Bridge-Token: file:/absolute/private/config/bridge-token"
```

以上路径是占位符，应替换为本机生成的密钥文件路径。它不是 bridge 环境变量。官方配置支持 file/env-backed 静态头，限定于本机 MCP origin；转发的同名请求头可能覆盖静态值，所以错误或伪造值必须得到 401。核对当前客户端行为并实测，不因认证失败删除校验。[配置依据](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)

Tunnel runtime key 和 `X-Bridge-Token` 是不同秘密。静态头只识别安装实例，不识别每位 OpenAI 请求用户；共享 Tunnel 会破坏单主人假设。数据仍经过 OpenAI，不能声称完全离线。

原生 Node 加同主机 Tunnel 是本指南的布局。仓库 Docker/Compose 模板仅适用于显式 OAuth 模式；不要为容器互通而放开个人模式的 loopback。个人容器网络布局须另行设计并验收。当前文档不声称容器构建或部署已通过。

## 6. 连接、配对与订阅

在产品支持的界面添加该 Tunnel。认证 “None” 表示不另走 OAuth，而非关闭后端密钥。实际账号须支持 MCP Events 组合；遇到不支持，停在具体兼容问题，不能改成无认证服务。

核实实际可调用目录包含：`begin_binding`、`binding_status`、`unlink_binding`、`reply_to_feishu`、`delivery_status`、`list_pending_events`、`get_event`、`send_to_bound_feishu`、`mirror_delivery_status`、`get_event_handling`、`list_event_alerts`、`claim_event_processing`、`complete_event_handling`，共 13 个文字工具，以及 `feishu.message.created` 事件。图片模式另有 `get_event_image`。图片开启后共 14 个工具。界面计数不能代替实际调用验证。

让 dot 生成配对命令，由本人在五分钟内发到目标飞书机器人私聊，再检查绑定。其他人的私聊、机器人和群聊不会被路由给主人。随后明确授权订阅、回复范围和所需文字镜像；配对不是任意行动授权。

首次 callback 主机未知时可保留 `CALLBACK_HOSTS=callback.invalid`。订阅会拒绝，日志仅包含规范化主机名；先核实它来自预期连接流程和正确官方目的地，再设置精确 allowlist 并重试，不能自动信任日志中的任意域名或使用通配符。

默认 callback 为 `direct-pinned`。仅在确有符合要求的受控 loopback 代理时显式选择 [callback 代理](CLOUD_PROXY_CANDIDATE.md)和[飞书代理](FEISHU_MANAGED_PROXY.md)，并理解 DNS/上游 IP 控制权的不同。

## 7. 租期、备份与维护

静态认证密钥不自动每小时更换；每次认证的内部租期最多一小时，订阅不超过该租期。轮换密钥需同步 Tunnel 与 bridge，并保持 `INSTALLATION_ID` 不变。停止 Tunnel 或换密钥不会立即撤回已持久化的出站订阅；立即停止应先解绑或离线 revoke。

消息正文、标识与 callback URL 在 SQLite 中可读；只有 callback 签名密钥使用 storage-key 加密。保护磁盘与备份，不记录请求头、正文或完整 URL。直接更换 storage-key 会使旧加密数据不可读。

升级 schema v4 前停进程、取得一致私有备份，保留身份/配置/匹配密钥并演练恢复。不要仅复制可能带 WAL 的活动数据库主文件，也不要通过旧二进制、删表或降低版本号回滚。详见 [schema 恢复边界](TEXT_MIRROR_V1.md#schema-v2-upgrade-and-recovery)。

[离线维护](OFFLINE_MAINTENANCE.md)要求 Linux `/proc/self/fd`、私有文件和可信静止主机，执行前必须停所有数据库使用者及其自动重启。先预览再执行经授权的写入。它仅清理符合条件的旧收件历史；全部回执与镜像正文仍保留，无自动 30 天删除策略。

Schema v4 增加逐事件处理决策和有限租期。部署前核对[迁移和调用方契约](EVENT_HANDLING.md)。独立主机监管仅保持 bridge/Tunnel 运行，不会替 dot 生成或提交答案；调用方在唤醒时检查漏项并遍历全部告警页，没有独立自动补发调度器。断连恢复边界见 [README](../README.md#先试再长期运行)，真实短时验收见[验收记录](ACCEPTANCE.md#live-merged-text-check-2026-10-10)。

## 8. 断连与恢复的范围

主机进程监管使 bridge 和 Tunnel 能独立于临时开发会话运行；它不替 dot 生成或提交答案。临时飞书断线由 SDK 重连，终止性错误由监管器重启。`/healthz` 只表示进程存活，不能替代端到端收发检查。

数据库恢复仅适用于已持久化的事件和任务。callback 保留原有有限重试规则；重启时发送中的回复变为 `uncertain`，必须核对目的端，不能自动重发。文字镜像保留原有重试语义，不保证跨平台 exactly-once。断线期间未入库的消息没有历史回填保证；订阅到期需要重新授权，图片引用最长 15 分钟且重启后不可恢复。恢复读取和处理租期恢复本身均不发送回复。

调用方在被唤醒时检查所有告警页，记录每条输入的结果；没有全天独立漏项检查或自动补发调度器。等待授权、不回复及已被后续答案覆盖的输入不能按普通待回复事件补发。详见[处理契约](EVENT_HANDLING.md)。

开发测试曾观察到临时云端会话消失和网络政策拒绝；这只是具体环境的观察，不是产品永久限制。独立主机也要逐安装验证网络、持久性、监管和长时间在线表现，短时测试不能证明优于云端。

## 9. 可选传输与兼容模式

默认个人布局采用同主机 bridge 与官方 Tunnel。需要不同传输时先核对[callback 受控代理](CLOUD_PROXY_CANDIDATE.md)、[连接池](CALLBACK_POOL_CANDIDATE.md)与[飞书受控代理](FEISHU_MANAGED_PROXY.md)的要求，不更改安全策略来绕过网络拒绝。

[OAuth 兼容模式](OAUTH_COMPATIBILITY.md)需显式选择。Docker/Compose 模板适用于该兼容模式，不能直接当作个人 loopback 布局的即用部署；个人容器网络须另行设计和验收，不能通过放开监听来解决连接问题。
