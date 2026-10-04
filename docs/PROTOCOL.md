# 协议依据与实现决策

核查日期：2026-10-04。在线规范会变化；升级依赖和协议前重新跑契约测试，并在真实测试账号验收。

## 官方来源

- OpenAI MCP Events：https://developers.openai.com/plugins/build/mcp-events
- OpenAI OAuth：https://developers.openai.com/plugins/build/auth
- MCP TypeScript SDK：https://github.com/modelcontextprotocol/typescript-sdk
- MCP 2026-07-28 HTTP：https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- MCP tools：https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP Events 草案：https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
- 飞书官方 Node SDK：https://github.com/larksuite/node-sdk
- 飞书官方 Channel SDK：https://github.com/larksuite/channel-sdk-node
- 飞书消息接收：https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
- 回复 API：https://open.feishu.cn/api-explorer?from=op_doc_tab&apiName=reply&project=im&resource=message&version=v1
- Standard Webhooks：https://github.com/standard-webhooks/standard-webhooks

## MCP2

使用官方 `@modelcontextprotocol/server` v2 的 `createMcpHandler`，拒绝 legacy 模式。不是把 events 方法硬塞入 v1 initialize/session 实现。SDK验证现代版本元数据、路由头与 JSON-RPC 方法对应关系；工具和事件在同一个 OAuth 端点。

Advertise `server/discover` 中 `tools:{}`、`events:{}`，实现 `events/list`、`events/subscribe`、`events/unsubscribe`。事件实现采用 OpenAI 文档中的 webhook 草案，目前自定义适配层集中在 `src/mcp.ts` 和 `src/bridge.ts`，便于协议升级。没有把内建 SSE `subscriptions/*` 当作此 webhook 机制。

订阅 identity = hash(已认证 owner + callback URL + event name + 规范化参数)。这里只允许固定 `{binding_id}` 参数结构。每次订阅校验所有权、签名密钥长度和 challenge；默认最多一小时、且不超过 access token exp。`ttlMs:null` 不授予无限期。无历史 replay，cursor 为 null。

回调使用新鲜随机 challenge、Standard Webhooks 签名、constant-time challenge 比较。发送时使用稳定 eventId、事件发生时间和 exact body 字节。私有应用数据只在 data 内。2xx 仅表示接收，410 停订阅，413 或其他非429的4xx进入 dead，瞬时失败有限重试。密钥轮换双签最多5分钟，同密钥刷新不延长旧密钥窗口。

## 飞书

选用官方 Node SDK 进行真实回复；入站使用小型严格 webhook 适配器，校验原始加密字节的 SHA256(timestamp+nonce+encryptKey+body)、5分钟新鲜度、AES256-CBC、verification token、固定 app/tenant、user+p2p+text。加密和签名实现与官方 SDK 对照，额外补原始字节与时间窗校验。

MVP 未采用 Channel SDK 的 WebSocket/批处理抽象：原始 webhook tenant/app 身份与数据库事务去重更易明确审查。官方 Channel SDK 已核查，可作为后续传输适配器；不能仅凭其 senderId 忽略 app/tenant 命名空间。

去重键为 app+tenant+message_id，不使用可在重试中变化的 event_id。消息文本不会变成绑定身份、callback地址或目标chat参数。配对命令不保存正文、不作为普通消息投递。

## 身份

OAuth 授权服务器验证用户，资源服务器用 issuer+subject 作不可由请求体伪造的 owner。飞书配对以两侧控制权证明实现：OAuth已认证生成随机码，飞书已验证用户私聊消耗码。不声称飞书签名本身证明 dot 所有权。

MCP `reply_to_feishu` 只接受 event_id/text；目标app/message从owner-scoped inbox取回。相同事件只允许一个回复任务。重复完全相同请求返回原状态，不同正文冲突。

## 已验证与未验证

本地使用真实 MCP2 SDK 与真实密码算法，外部点使用明确标记 MOCK 的适配器。包括磁盘重启恢复、回调签名、双用户隔离、协议头/Origin、JWT 错误场景。未验证实际 OpenAI OAuth UI、真实 callback DNS/TLS、真实 Feishu URL verification/reply、Docker 构建或公开部署；它们属于验收清单，不是已完成能力的证据。
