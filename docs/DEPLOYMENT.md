# 部署与配置

## 1. 准备信任边界

这是有真实消息数据的服务。建议先在自己的测试企业和测试账号验收，完成独立安全审查后才开放给其他用户。使用独立域名、可信 TLS 证书、持续安全更新、私有数据库卷及定期备份。不要把 `/mcp` 放到无认证公网，也不要使用 wildcard callback 许可。

只运行一个 bridge 进程/worker，单 SQLite 数据库。Docker Compose 也是单副本。服务只适合这一规模；扩容前迁移到数据库事务领取/分布式队列，而不是直接把副本数改大。

## 2. OAuth 身份提供商

使用成熟的外部 OAuth2.1 IdP，要求：

- Authorization Code + PKCE S256，发布 OAuth/OIDC discovery metadata
- 按 OpenAI 管理页给出的精确 redirect URI 注册客户端；支持预配置客户端，或合规 CIMD/DCR
- 接受 OAuth `resource`，签发给 `https://你的域名/mcp` 的 access token audience
- RS256 或 ES256 JWT，必须有 `iss`、`sub`、`iat`、`exp`、`scope`；包含 `bridge:use`，有效期最多 1 小时
- `OAUTH_ISSUER` 必须与 JWT issuer 精确一致；`OAUTH_JWKS_URL` 必须是管理员核实的 HTTPS 地址
- 允许用户各自注册/登录、撤销授权与刷新 token

项目不会接收 ID token 作为替代品，不转发用户的 OAuth token 给飞书，不接收客户端指定 JWKS。它不实现登录页、注册页、授权码交换或 DCR，这些由 IdP 完成。IdP 若发行 opaque token、其他算法或多种 scope claim 格式，需实现独立验证适配器并补测试。

订阅到期时间不超过调用者 JWT exp，刷新订阅需要新有效 token。离线 JWT 验证无法即时发现 IdP 中途撤销；默认最坏延迟为剩余 token 生命周期（最多一小时）。公开服务建议补 IdP 撤销 webhook/introspection。紧急吊销可停服务后执行维护脚本 `revoke <principal-hash>`；principal 是 SHA256(JSON.stringify([issuer, subject]))，不要使用邮件或用户自行提供的 owner ID。

## 3. 飞书 / Lark 应用

1. 在对应官方开放平台创建企业自建应用、开启机器人并限制可用范围
2. 启用用户发给机器人的单聊消息接收与发送/回复所需的最小权限。权限名称以控制台当前版本为准，不开群聊/文件/通讯录权限作为捷径
3. 订阅 `im.message.receive_v1`，启用消息加密，配置 Encrypt Key 和 Verification Token
4. 事件回调填 `https://你的域名/feishu/events/<真实appId>`；确认官方 URL verification challenge 验证通过
5. 在受控配置中设置准确 tenant key。该值需从管理员/官方已认证事件核实，不能从未验证的请求自动注册租户
6. 配置 `config/feishu-apps.json`。文件中只有凭证环境变量名，实际秘密放在私有环境或 secret manager

每个 app ID 只允许一项配置与一个 tenant key。需要多个企业时，分别配置每个企业自己的自建应用；不支持同一 ISV app 在多个企业安装后自动换取 tenant token。

本实现刻意要求签名和加密。若你所在 Feishu 部署的 challenge/签名行为不同，先通过官方沙箱核实并修改适配器/测试，不能为了通过配置而关闭认证。

## 4. 配置和启动

复制 `.env.example`、`examples/feishu-apps.json`。生成 32 字节 STORAGE_KEY：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

仅把结果放进 secret manager/本地 .env，不保存到源码。密钥加密数据库中的 callback 签名密钥。更换 STORAGE_KEY 必须先解密并重加密已有数据；直接替换会无法读取旧订阅。

- PUBLIC_URL：服务的 HTTPS origin，不含路径
- ALLOWED_HOSTS：代理传递的精确 Host 值，包括非标准端口（如果使用）；默认 PUBLIC_URL 主机
- ALLOWED_ORIGINS：允许的浏览器 Origin 精确列表。缺少 Origin 的服务到服务请求仍需 OAuth/签名
- CALLBACK_HOSTS：实际订阅回调的精确 HTTPS 主机白名单。请从官方连接流程核实后配置，禁止猜测及 wildcard；DNS 每次连接还会校验公共地址
- HOST 默认 127.0.0.1；生产只通过反向代理开放 HTTPS，不要直接暴露明文监听

```sh
npm ci --ignore-scripts
npm test
npm run build
node --env-file=.env dist/src/main.js
```

或：

```sh
docker compose up --build -d
```

这里仅提供 Dockerfile/Compose；构建及部署仍需你在有 Docker 的环境实际验证。容器以非 root 运行，根文件系统只读，持久化 SQLite 卷单独可写。

## 5. 反向代理和网络

将 HTTPS `/mcp`、`/.well-known/oauth-protected-resource/mcp`、`/feishu/events/*` 转发到 localhost:3000。保留原始请求 body，不可反序列化再序列化飞书请求，签名依赖原始字节。保留 Authorization、MCP-Protocol-Version、Mcp-Method、Mcp-Name、x-lark-* 头。

限制 body 为 256 KiB，配置每 IP/账号速率限制、请求超时与并发上限。不要日志记录 Authorization、请求/响应正文、callback URL 路径、配对码或消息。除 fail-closed 配置诊断中的 callback hostname 外，程序只输出固定事件标签。内置每来源 IP 每分钟 600 请求限制是基础防护，反代后的来源识别/分账户限流仍由网关配置；不盲目信任 X-Forwarded-For。

需要出站 HTTPS：IdP JWKS、官方 Feishu/Lark API、实际 callback 白名单域。callback 不跟随重定向，不允许私网/元数据 IP。不要用允许任意访问的转发代理绕开这些校验。

## 6. 连接已有 dot

在 OpenAI 插件管理中按当前界面添加 `https://你的域名/mcp`，配置 OAuth，连接测试账号并重新扫描工具和事件。要求该账号/工作区允许 MCP Events。每个用户在自己的 dot 中单独连接、配对、授权订阅；不会把一个操作者的 dot 共享给所有飞书用户。

首次可保持 `.env.example` 的 `CALLBACK_HOSTS=callback.invalid`（RFC 保留无效域名，始终 fail-closed）。真实用户完成 OAuth 和配对后，请 dot 订阅一次：它会因主机未获准而失败，服务仅输出 `callback_host_not_allowed` 与规范化的 hostname，不输出完整 URL/路径/query/secret。管理员核对该次已认证请求确实来自预期 ChatGPT 连接，确认这是官方回调目的地，然后把精确 hostname 加入配置，重启服务并重新订阅。不要仅因日志出现就自动批准主机。不要为便利放开任意公网 callback。参考 README 的用户配对流程。

## 7. 运维与数据保留

SQLite 存储用户标识、消息正文、回复正文、callback URL 和加密签名密钥。消息正文不是应用级加密，必须提供卷加密、文件访问控制及加密备份。进程设置 umask 077；数据库文件 0600。密钥与数据库备份分开保管。

推荐 30 天消息/回执保留策略，本项目提供离线 purge 脚本；它**不会自动运行**。管理员应配置运维窗口，先停止服务、备份，再运行：

```sh
node --env-file=.env dist/scripts/maintenance.js purge
```

此命令删除 30 天前正文/任务/回执及过期临时数据，并清理已停用且无关联数据的绑定。`revoke` 紧急取消账号访问、绑定和订阅。两项操作都只能在服务停止后使用（Store 启动恢复逻辑不支持多进程并发）。根据用户删除请求，需另行实现/审核更细粒度的隐私删除流程。

备份应停服务后复制 SQLite，或使用 SQLite 一致性备份 API；不要在运行中只复制 .sqlite 而忽略 WAL。应监控磁盘、pending/dead/uncertain 数量、订阅到期、签名拒绝率，不采集正文。当前 `/healthz` 只说明进程存活。

发送失败最多 8 次，指数退避，dead 保留供人工排查。不要删除幂等记录后盲目重发；uncertain 先在飞书核实。解绑无法撤回已离开进程的请求，正在飞行中的一次发送可能完成。
