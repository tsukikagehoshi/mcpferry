# 渡口 (mcp-ferry) v2

把外部 MCP 工具接进 Roche 对话。

---

## 安装

### 传 GitHub

```
mcp2/
  ferry/
    manifest.json
    plugin.js
```

`manifest.json` 的 `entry` 已指向 `.../main/ferry/plugin.js`，放别的路径就同步改。

### Roche 里填

```
https://raw.githubusercontent.com/你的GitHub用户名/你的仓库名/main/ferry/manifest.json
```

不要填 `github.com/.../blob/...` 页面链接。

**旧配置自动迁移**：v0 的 `headers` 数组、v1 的 `token` 字段、`scopeCharacterIds` 都会自动转成新格式，已废弃的 `storeRaw` 等字段会清掉。

---

## 怎么填

### 基础页

| 字段 | 填什么 |
|---|---|
| 名称 | 随便起，**会显示给模型看**（作为工具描述前缀） |
| 服务 URL | 要带完整路径，如 `https://xxx.xxxxxxx.xxx/mcp` |
| 传输类型 | 先试 Streamable HTTP，连不上再切 SSE |
| 身份验证 | **无** / **Bearer** / **Header** 三选一 |

Bearer 模式**只填 token 本身，不带 `Bearer ` 前缀**，插件自动拼。

填完点「测试连接并拉取工具列表」，走标准 MCP 的 `tools/list` 自动发现。

### 模式页

**模式设置**：工具 / 记忆 / 全部

- **工具** — 工具声明给宿主，模型自行决定何时调用，结果自动回填。走 Roche 原生协议，**不要求 LLM 支持 function calling**
- **记忆** — 每次发送前自动 query 并注入 system prompt，**当轮生效**
- **全部** — 两者都开

**通用选项**：
- 注入角色身份 — 只在工具 schema 真的声明了 `persona`/`user`/`speaker` 这类字段时才注入，否则乱塞会被服务端拒绝
- 跳过代理 — 配了代理时，让这个服务改为直连
- 工具结果缓存 5 分钟

**记忆模式参数**：调用的 tool 名、检索条数（自动映射到 schema 里的 `limit`/`top_k`/`n`）、自动精简 RECAP

**执行范围**：全部会话 / 指定范围（按会话类型 + 具体会话）


---

## 状态页

新增的。因为 `chat` 是未文档化的，**万一你某个 Roche 版本不支持，插件会静默不工作**——状态页就是用来发现这件事的。

它显示：
- 宿主调用扩展点的次数（发送前注入 N 次 / 工具执行 N 次）
- 当前声明给模型的工具列表
- 上次注入了多少字
- 运行日志

**装好后去随便发一条消息，再回来看这页**。如果计数一直是 0，说明扩展点没生效。

---

## 七、验证结果

全部实测通过：

```
语法检查              ✅
chat 扩展点契合度     12/12   有 chat 字段 · typeof===object · tools 有 execute · id 不含冒号
配置迁移              14/14   v0 headers · v1 token · scopeCharacterIds · 清废弃字段
协议层+参数映射        9/9    Accept头 · Bearer拼接 · 握手序列 · 通知不挂死 · query/limit映射 · 注入角色身份
记忆模式(发送前注入)   7/7    返回字符串 · 真的注入 · 空消息不注入 · 范围限定 · 服务器挂了不抛异常
```

**真实服务器端到端**（模拟宿主完整消费循环）：
```
真实服务器: 3个工具, 协议2025-06-18
宿主收集到工具: 3 个
  - mcp-ferry:srv1__image_recognition
  - mcp-ferry:srv1__audio_recognition
  - mcp-ferry:srv1__video_recognition
模拟模型调用 → execute 返回字符串且未抛出 ✅
```

**代理实测**（本地起服务打真实 MCP）：
```
CORS 预检 200        ✅  ← 关键：不带 Authorization 也放行
真实 MCP 握手        ✅  协议 2025-06-18，mcp-session-id 正常透传
SSE 流式             ✅  text/event-stream + chunked，没被缓冲
白名单外域名 403     ✅  不会变成公开代理
错误暗号识别         ✅  正确报 HTTP 401
```

测试中发现并修掉的问题：
- **工具报错文本会被注入 prompt** —— 那是给模型看的噪音，可能让它照着错误信息瞎编。改成只记日志，不注入。

---

## 装多个插件会互相影响吗

不会。宿主按 `pluginId` 独立注册，注入时遍历所有插件，各自用 `【插件：名字】` 分块。

两点注意：
1. **注入内容会累加** —— 装 N 个插件就是 N 段叠加，宿主不限长度，会吃 token。状态页能看到本插件注入了多少字
2. **`pluginId` 别撞车** —— 撞了会互相顶掉。渡口用 `mcp-ferry`

---

## 风险提示

- **插件是全信任 JS**，`new Function()` 在主页面 realm 里跑，无 iframe、无沙箱。装之前自己过一遍代码
- **`chat` 扩展点未文档化**。你说 Roche 已完结，所以改动风险基本没有；状态页可以确认它在不在工作
- **manifest 的 `permissions` 是纯装饰，运行时零校验**（我搜 `hasPermission`/`requirePermission` 只命中一处 Web-Push 检查，与插件无关）。这意味着**任何第三方插件都能悄悄往你每轮对话注入任意文本、读到你的人设和消息**。你自己写的没问题，以后装别人的插件值得留个心眼
- **发送前注入是阻塞的** —— 记忆模式会等 MCP 返回才发消息。「工具调用超时」设太大会让你的消息迟迟发不出去
- **暗号明文存在插件私有 storage**，同浏览器上其它全信任插件理论上读得到
- 用代理时**暗号会经过代理**（是你自己的机器）
