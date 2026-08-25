/**
 * 渡口 (mcp-ferry) v2 —— 把外部 MCP 工具接进 Roche 对话
 *
 * v2 相比 v1 的根本改变:改用 Roche 未文档化但官方实现的 `chat` 扩展点。
 *
 * 该扩展点通过 register({ chat: {...} }) 注册,宿主在**每次向 LLM 发请求前**
 * 调用它。已对混淆后的 bundle 解码逐条核实(ai-core-Dacn8Sph.js):
 *   - 注册:  W?.["chat"]&&typeof W["chat"]==="object"&&uR["set"](...)
 *   - 消费:  promptOnly(静态串) / await preflight(ctx) / await contextProvider(ctx)
 *   - 注入:  XW&&(jo+="\n\n"+XW)   ← 追加到主 system prompt 最末尾
 *   - 渲染:  【插件：<name>】\n<content>
 *   - 作用域: bR(scope, ctx) 支持 conversationIds / conversationTypes
 *   - 工具:  模型输出 <roche-plugin-call>{"tool":"<pluginId>:<toolId>","arguments":{}}</roche-plugin-call>
 *            宿主执行 execute(args, ctx),结果作为 role:"user" 的
 *            【插件工具结果】追加进 messages,再发第二轮
 *
 * 因此 v2:
 *   ✅ 记忆模式是**真·发送前注入**,不再是 v1 那种"下一轮才生效"的预取
 *   ✅ 工具走宿主原生协议,不再需要把提示词粘进人设、不再需要轮询监控
 *   ✅ 执行范围用宿主原生 scope
 *   ✅ 完全不写 IndexedDB —— 直写主库的三个坑(UI 不刷新 / 云同步覆盖 /
 *      字段写错致消息消失)因此全部不存在
 */
(function () {
  "use strict";

  var PLUGIN_ID = "mcp-ferry";
  var APP_ID = "mcp-ferry-home";
  var VERSION = "2.0.0";
  var CLIENT_INFO = { name: "roche-mcp-ferry", version: VERSION };
  var PROTOCOL_CANDIDATES = ["2025-06-18", "2025-03-26", "2024-11-05"];

  var DEFAULT_SETTINGS = {
    proxyUrl: "",
    timeoutMs: 30000,
    toolTimeoutMs: 120000,
    maxResultChars: 1200,
    maxInjectChars: 6000   // 注入总长度上限,防止多插件叠加吃爆 token
  };

  var G = {
    roche: null,
    servers: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    conns: {},
    sseConns: {},
    resultCache: {},
    logLines: [],
    onLogChange: null,
    rpcSeq: 1,
    // 诊断用:记录扩展点是否真被宿主调用过
    hostCalled: { preflight: 0, contextProvider: 0, toolExec: 0, lastAt: 0 },
    lastInjectChars: 0
  };

  function log(text) {
    var line = "[" + new Date().toLocaleTimeString() + "] " + text;
    G.logLines.unshift(line);
    if (G.logLines.length > 200) G.logLines.length = 200;
    if (G.onLogChange) G.onLogChange(G.logLines.join("\n"));
  }

  function makeId() { return Math.random().toString(36).slice(2, 10); }
  function nextRpcId() { return G.rpcSeq++; }

  // ============================================================
  // 配置模型 —— 字段对齐用户原本的 MCP 连接工具
  // ============================================================
  function emptyServer() {
    return {
      id: makeId(),
      name: "",
      enabled: true,
      url: "",
      transport: "streamable-http",

      authType: "bearer",            // none | bearer | header
      bearerToken: "",
      headerName: "",
      headerValue: "",

      mode: "tools",                 // tools | memory | all

      injectPersona: false,
      skipProxy: false,
      cacheResults: true,

      contextToolName: "",           // 记忆模式调用的 tool
      retrieveCount: 5,
      trimRecap: false,

      scopeType: "all",              // all | selected
      scopeConversationIds: [],
      scopeConversationTypes: [],    // 空 = 不限单聊/群聊

      toolsEnabled: null,
      cachedTools: []
    };
  }

  function migrateServer(s) {
    var base = emptyServer();
    if (!s || typeof s !== "object") return base;
    var out = Object.assign(base, s);
    if (!out.bearerToken && s.token) {
      out.bearerToken = s.token;
      out.authType = "bearer";
    }
    if (Array.isArray(s.headers) && s.headers.length) {
      var auth = null;
      for (var i = 0; i < s.headers.length; i++) {
        var h = s.headers[i];
        if (h && h.key && String(h.key).toLowerCase() === "authorization") { auth = h; break; }
      }
      if (auth && !out.bearerToken) {
        var v = String(auth.value || "");
        if (/^bearer\s+/i.test(v)) { out.authType = "bearer"; out.bearerToken = v.replace(/^bearer\s+/i, ""); }
        else { out.authType = "header"; out.headerName = auth.key; out.headerValue = v; }
      } else if (!auth && s.headers[0] && s.headers[0].key) {
        out.authType = "header";
        out.headerName = s.headers[0].key;
        out.headerValue = s.headers[0].value || "";
      }
    }
    // v1 的 scopeCharacterIds 迁移到 scopeConversationIds
    if (Array.isArray(s.scopeCharacterIds) && s.scopeCharacterIds.length && !out.scopeConversationIds.length) {
      out.scopeConversationIds = s.scopeCharacterIds.slice();
    }
    if (!out.id) out.id = makeId();
    delete out.token; delete out.authScheme; delete out.headers;
    delete out.scopeCharacterIds; delete out.storeRaw; delete out.storeSummary;
    delete out.confirmBeforeCall;
    return out;
  }

  // ============================================================
  // 持久化
  // ============================================================
  function loadJson(roche, key, fallback) {
    return roche.storage.get(key).then(function (v) {
      return v === undefined || v === null ? fallback : v;
    }).catch(function () { return fallback; });
  }
  function saveServers(roche) { return roche.storage.set("servers", G.servers); }
  function saveSettings(roche) { return roche.storage.set("settings", G.settings); }

  // ============================================================
  // 错误类型
  // ============================================================
  function HttpError(status, body) {
    this.name = "HttpError";
    this.status = status;
    this.body = body || "";
    this.message = "HTTP " + status + (body ? " — " + String(body).slice(0, 200) : "");
  }
  HttpError.prototype = Object.create(Error.prototype);

  function RpcError(code, message, data) {
    this.name = "RpcError";
    this.code = code;
    this.data = data;
    this.message = "MCP 错误 " + code + ": " + message;
  }
  RpcError.prototype = Object.create(Error.prototype);

  function usingProxy(server) {
    return !!(G.settings.proxyUrl && String(G.settings.proxyUrl).trim() && !server.skipProxy);
  }

  function effectiveUrl(server) {
    if (!usingProxy(server)) return server.url;
    var base = String(G.settings.proxyUrl).trim().replace(/\/+$/, "");
    return base + "/?target=" + encodeURIComponent(server.url);
  }

  function classifyNetworkError(err, server) {
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      return new Error("请求超时。服务器没在规定时间内回应。");
    }
    if (err instanceof HttpError || err instanceof RpcError) return err;
    var isMixed = false;
    try { isMixed = location.protocol === "https:" && /^http:\/\//i.test(effectiveUrl(server) || ""); } catch (e) {}
    if (isMixed) {
      return new Error("混合内容被浏览器拦截:https 页面不允许请求 http:// 地址。请配 https 域名或用代理。");
    }
    if (usingProxy(server)) {
      return new Error("连不上代理。检查「设置 → 代理地址」、代理是否在跑、目标域名是否在白名单里。");
    }
    return new Error(
      "请求没发出去或被浏览器拦掉了(通常是 CORS 跨域)。" +
      "浏览器会先发不带 Authorization 的 OPTIONS 预检,被暗号锁判成 401。" +
      "解法:① 在「设置」填代理地址;② 改服务器 Caddy 放行预检。点「诊断」确认。"
    );
  }

  function safeText(resp) { return resp.text().catch(function () { return ""; }); }

  // ============================================================
  // SSE 帧解析
  // ============================================================
  function parseSseBlock(block) {
    if (!block || !block.trim()) return null;
    var lines = block.split("\n");
    var event = "message";
    var dataLines = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.charAt(0) === ":") continue;
      var idx = line.indexOf(":");
      var field = idx === -1 ? line : line.slice(0, idx);
      var value = idx === -1 ? "" : line.slice(idx + 1);
      if (value.charAt(0) === " ") value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
    }
    if (!dataLines.length) return null;
    return { event: event, data: dataLines.join("\n") };
  }

  function isResponseFor(obj, wantId) {
    if (!obj || typeof obj !== "object") return false;
    if (!("result" in obj) && !("error" in obj)) return false;
    if (wantId === undefined || wantId === null) return true;
    return obj.id === wantId;
  }

  function readSseUntilResponse(resp, wantId) {
    if (!resp.body || typeof resp.body.getReader !== "function") {
      return safeText(resp).then(function (text) {
        var blocks = text.replace(/\r\n/g, "\n").split("\n\n");
        for (var i = 0; i < blocks.length; i++) {
          var f = parseSseBlock(blocks[i]);
          if (!f) continue;
          try {
            var obj = JSON.parse(f.data);
            if (isResponseFor(obj, wantId)) return obj;
          } catch (e) {}
        }
        throw new Error("服务器返回了事件流,但里面没有对应这次请求的结果。");
      });
    }
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buf = "";
    function step() {
      return reader.read().then(function (r) {
        if (r.done) {
          var tail = parseSseBlock(buf);
          if (tail) {
            try {
              var obj = JSON.parse(tail.data);
              if (isResponseFor(obj, wantId)) return obj;
            } catch (e) {}
          }
          throw new Error("连接已结束,但没有收到这次请求的结果。");
        }
        buf = (buf + decoder.decode(r.value, { stream: true })).replace(/\r\n/g, "\n");
        var idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          var block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          var frame = parseSseBlock(block);
          if (!frame) continue;
          try {
            var parsed = JSON.parse(frame.data);
            if (isResponseFor(parsed, wantId)) return parsed;
          } catch (e) {}
        }
        return step();
      });
    }
    return step().then(function (v) {
      try { reader.cancel(); } catch (e) {}
      return v;
    }, function (e) {
      try { reader.cancel(); } catch (e2) {}
      throw e;
    });
  }

  // ============================================================
  // 请求头
  // ============================================================
  function buildHeaders(server, conn, isSseGet) {
    var h = {};
    // ★ MCP Streamable HTTP 要求同时接受两种类型,少了必回 406
    h["Accept"] = isSseGet ? "text/event-stream" : "application/json, text/event-stream";
    if (!isSseGet) h["Content-Type"] = "application/json";
    if (server.authType === "bearer") {
      var tk = String(server.bearerToken || "").trim();
      if (tk) h["Authorization"] = "Bearer " + tk;
    } else if (server.authType === "header") {
      var hn = String(server.headerName || "").trim();
      if (hn) h[hn] = String(server.headerValue === undefined ? "" : server.headerValue);
    }
    if (conn) {
      if (conn.sessionId) h["Mcp-Session-Id"] = conn.sessionId;
      if (conn.protocolVersion) h["MCP-Protocol-Version"] = conn.protocolVersion;
    }
    return h;
  }

  function getConn(server) {
    if (!G.conns[server.id]) G.conns[server.id] = { sessionId: null, protocolVersion: null, initialized: false };
    return G.conns[server.id];
  }

  function resetConn(server) {
    G.conns[server.id] = { sessionId: null, protocolVersion: null, initialized: false };
    closeSse(server.id);
    return G.conns[server.id];
  }

  // ============================================================
  // Streamable HTTP
  // ============================================================
  function rpcStreamable(server, conn, payload, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || G.settings.timeoutMs);
    var settled = false;
    function done() { if (!settled) { settled = true; clearTimeout(timer); } }

    return fetch(effectiveUrl(server), {
      method: "POST",
      headers: buildHeaders(server, conn),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      mode: "cors",
      credentials: "omit"
    }).catch(function (e) {
      done();
      throw classifyNetworkError(e, server);
    }).then(function (resp) {
      var sid = resp.headers.get("mcp-session-id");
      if (sid) conn.sessionId = sid;

      if (resp.status === 202 || resp.status === 204) {
        return safeText(resp).then(function () { done(); return null; });
      }
      if (!resp.ok) {
        return safeText(resp).then(function (body) { done(); throw new HttpError(resp.status, body); });
      }

      var ct = (resp.headers.get("content-type") || "").toLowerCase();
      var isNotification = payload.id === undefined || payload.id === null;

      if (ct.indexOf("text/event-stream") !== -1) {
        // 通知没有 id,服务器不会回响应帧。绝不能等流,否则挂到超时。
        if (isNotification) {
          try { if (resp.body && resp.body.cancel) resp.body.cancel(); } catch (e) {}
          done();
          return null;
        }
        return readSseUntilResponse(resp, payload.id).then(function (obj) {
          done();
          return unwrapRpc(obj, payload.id);
        }, function (e) { done(); throw e; });
      }

      return safeText(resp).then(function (text) {
        done();
        if (!text) return null;
        if (isNotification) return null;
        var data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error("服务器返回的不是合法 JSON,前 200 字:" + text.slice(0, 200)); }
        return unwrapRpc(data, payload.id);
      });
    });
  }

  function unwrapRpc(data, wantId) {
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        if (isResponseFor(data[i], wantId)) { data = data[i]; break; }
      }
    }
    if (!data || typeof data !== "object") return null;
    if (data.error) throw new RpcError(data.error.code, data.error.message || JSON.stringify(data.error), data.error.data);
    return data.result;
  }

  // ============================================================
  // 传统 HTTP+SSE
  // ============================================================
  function closeSse(serverId) {
    var c = G.sseConns[serverId];
    if (!c) return;
    try { c.ctrl.abort(); } catch (e) {}
    c.dead = true;
    c.pending.forEach(function (p) { p.reject(new Error("SSE 连接已关闭")); });
    c.pending.clear();
    delete G.sseConns[serverId];
  }

  function ensureSseConn(server) {
    var existing = G.sseConns[server.id];
    if (existing && !existing.dead) return existing.ready.then(function () { return existing; });

    var c = { ctrl: new AbortController(), postUrl: null, pending: new Map(), dead: false };
    G.sseConns[server.id] = c;

    c.ready = new Promise(function (resolve, reject) {
      var handshakeTimer = setTimeout(function () {
        c.dead = true;
        try { c.ctrl.abort(); } catch (e) {}
        reject(new Error("SSE 握手超时:20 秒内没收到 endpoint 事件。这个地址可能其实是 Streamable HTTP。"));
      }, 20000);

      fetch(effectiveUrl(server), {
        method: "GET",
        headers: buildHeaders(server, null, true),
        signal: c.ctrl.signal,
        mode: "cors",
        credentials: "omit"
      }).catch(function (e) {
        clearTimeout(handshakeTimer);
        c.dead = true;
        reject(classifyNetworkError(e, server));
        throw e;
      }).then(function (resp) {
        if (!resp) return;
        if (!resp.ok) {
          return safeText(resp).then(function (b) {
            clearTimeout(handshakeTimer);
            c.dead = true;
            reject(new HttpError(resp.status, b));
          });
        }
        if (!resp.body || typeof resp.body.getReader !== "function") {
          clearTimeout(handshakeTimer);
          c.dead = true;
          reject(new Error("这个浏览器不支持流式读取,无法使用传统 SSE。"));
          return;
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) throw new Error("stream-ended");
            buf = (buf + decoder.decode(r.value, { stream: true })).replace(/\r\n/g, "\n");
            var idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              var block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              var frame = parseSseBlock(block);
              if (!frame) continue;
              if (frame.event === "endpoint") {
                try {
                  var abs = new URL(frame.data, server.url).href;
                  c.postUrl = usingProxy(server)
                    ? String(G.settings.proxyUrl).trim().replace(/\/+$/, "") + "/?target=" + encodeURIComponent(abs)
                    : abs;
                } catch (e) { c.postUrl = frame.data; }
                clearTimeout(handshakeTimer);
                resolve();
                continue;
              }
              try {
                var obj = JSON.parse(frame.data);
                if (obj && obj.id !== undefined && c.pending.has(obj.id)) {
                  var p = c.pending.get(obj.id);
                  c.pending.delete(obj.id);
                  try { p.resolve(unwrapRpc(obj, obj.id)); } catch (err) { p.reject(err); }
                }
              } catch (e) {}
            }
            return pump();
          });
        }
        pump().catch(function () {
          clearTimeout(handshakeTimer);
          c.dead = true;
          c.pending.forEach(function (p) { p.reject(new Error("SSE 连接中断")); });
          c.pending.clear();
          if (G.sseConns[server.id] === c) delete G.sseConns[server.id];
        });
      }).catch(function () {});
    });

    return c.ready.then(function () { return c; });
  }

  function rpcSse(server, conn, payload, timeoutMs) {
    return ensureSseConn(server).then(function (c) {
      var isNotification = payload.id === undefined || payload.id === null;
      var waiter = null;
      if (!isNotification) {
        waiter = new Promise(function (resolve, reject) {
          c.pending.set(payload.id, { resolve: resolve, reject: reject });
          setTimeout(function () {
            if (c.pending.has(payload.id)) {
              c.pending.delete(payload.id);
              reject(new Error("等待 SSE 响应超时"));
            }
          }, timeoutMs || G.settings.timeoutMs);
        });
      }
      return fetch(c.postUrl, {
        method: "POST",
        headers: buildHeaders(server, conn),
        body: JSON.stringify(payload),
        mode: "cors",
        credentials: "omit"
      }).catch(function (e) {
        throw classifyNetworkError(e, server);
      }).then(function (resp) {
        if (!resp.ok) return safeText(resp).then(function (b) { throw new HttpError(resp.status, b); });
        return safeText(resp);
      }).then(function () {
        return isNotification ? null : waiter;
      });
    });
  }

  function rpc(server, conn, payload, timeoutMs) {
    return server.transport === "sse"
      ? rpcSse(server, conn, payload, timeoutMs)
      : rpcStreamable(server, conn, payload, timeoutMs);
  }

  // ============================================================
  // MCP 握手
  // ============================================================
  function doInitialize(server, conn, protoIdx) {
    protoIdx = protoIdx || 0;
    if (protoIdx >= PROTOCOL_CANDIDATES.length) {
      return Promise.reject(new Error("所有协议版本都被服务器拒绝,可能不是标准 MCP 服务。"));
    }
    var version = PROTOCOL_CANDIDATES[protoIdx];
    return rpc(server, conn, {
      jsonrpc: "2.0", id: nextRpcId(), method: "initialize",
      params: { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO }
    }).then(function (result) {
      conn.protocolVersion = (result && result.protocolVersion) || version;
      conn.serverInfo = (result && result.serverInfo) || null;
      return rpc(server, conn, { jsonrpc: "2.0", method: "notifications/initialized", params: {} })
        .catch(function (e) { log("⚠️ notifications/initialized 未被接受(" + e.message + ")"); });
    }).then(function () {
      conn.initialized = true;
      return conn;
    }).catch(function (e) {
      var versionRejected = (e instanceof RpcError) ||
        (e instanceof HttpError && e.status === 400 && /protocol|version/i.test(e.body || ""));
      if (versionRejected && protoIdx + 1 < PROTOCOL_CANDIDATES.length) {
        log("协议 " + version + " 被拒,降级到 " + PROTOCOL_CANDIDATES[protoIdx + 1]);
        conn.sessionId = null;
        return doInitialize(server, conn, protoIdx + 1);
      }
      throw e;
    });
  }

  function ensureInitialized(server) {
    var conn = getConn(server);
    if (conn.initialized) return Promise.resolve(conn);
    if (conn.initializing) return conn.initializing;
    conn.initializing = doInitialize(server, conn).then(function (c) {
      conn.initializing = null; return c;
    }, function (e) { conn.initializing = null; throw e; });
    return conn.initializing;
  }

  function normalizeTools(list) {
    return ((list && list.tools) || []).map(function (t) {
      return {
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || { type: "object", properties: {} }
      };
    });
  }

  function listTools(server, conn) {
    var tools = [];
    function page(cursor) {
      return rpc(server, conn, {
        jsonrpc: "2.0", id: nextRpcId(), method: "tools/list",
        params: cursor ? { cursor: cursor } : {}
      }).then(function (result) {
        tools = tools.concat(normalizeTools(result));
        if (result && result.nextCursor) return page(result.nextCursor);
        return tools;
      });
    }
    return page(null);
  }

  function testAndListTools(server) {
    var started = Date.now();
    var probe = JSON.parse(JSON.stringify(server));
    probe.id = "probe-" + makeId();
    var conn = { sessionId: null, protocolVersion: null, initialized: false };
    return doInitialize(probe, conn).then(function () {
      return listTools(probe, conn);
    }).then(function (tools) {
      closeSse(probe.id);
      return {
        tools: tools, latency: Date.now() - started,
        serverInfo: conn.serverInfo, protocolVersion: conn.protocolVersion,
        sessionVisible: !!conn.sessionId
      };
    }, function (e) { closeSse(probe.id); throw e; });
  }

  function rawCallTool(server, toolName, args) {
    return ensureInitialized(server).then(function (conn) {
      return rpc(server, conn, {
        jsonrpc: "2.0", id: nextRpcId(), method: "tools/call",
        params: { name: toolName, arguments: args || {} }
      }, G.settings.toolTimeoutMs);
    }).catch(function (e) {
      var retryable = (e instanceof HttpError && (e.status === 404 || e.status === 400)) ||
        /会话|session/i.test(e.message || "");
      if (!retryable) throw e;
      log("会话可能已过期,重新握手后重试 " + toolName);
      resetConn(server);
      return ensureInitialized(server).then(function (c) {
        return rpc(server, c, {
          jsonrpc: "2.0", id: nextRpcId(), method: "tools/call",
          params: { name: toolName, arguments: args || {} }
        }, G.settings.toolTimeoutMs);
      });
    });
  }

  function callServerTool(server, toolName, args) {
    if (!server.cacheResults) return rawCallTool(server, toolName, args);
    var key = server.id + "|" + toolName + "|" + JSON.stringify(args || {});
    var hit = G.resultCache[key];
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
      log("♻️ 命中 5 分钟缓存: " + toolName);
      return Promise.resolve(hit.result);
    }
    return rawCallTool(server, toolName, args).then(function (r) {
      G.resultCache[key] = { at: Date.now(), result: r };
      var keys = Object.keys(G.resultCache);
      if (keys.length > 100) delete G.resultCache[keys[0]];
      return r;
    });
  }

  // ============================================================
  // 模式 / 工具启用判定
  // ============================================================
  function modeAllowsTools(s) { return s.mode === "tools" || s.mode === "all"; }
  function modeAllowsMemory(s) { return s.mode === "memory" || s.mode === "all"; }

  function isToolEnabled(server, toolName) {
    var f = server.toolsEnabled;
    return f === null || f === undefined || f.indexOf(toolName) !== -1;
  }

  // 单个服务器是否作用于当前会话。宿主的 scope 过滤是整个插件级的,
  // 而我们要的是每个 server 独立范围,所以在这里自己判。
  function serverAppliesTo(server, ctx) {
    if (!server.enabled) return false;
    if (server.scopeType !== "selected") return true;
    var ids = server.scopeConversationIds || [];
    var types = server.scopeConversationTypes || [];
    if (ids.length && ctx && ids.indexOf(String(ctx.conversationId)) === -1) return false;
    if (types.length && ctx && types.indexOf(ctx.conversationType) === -1) return false;
    if (!ids.length && !types.length) return false; // 选了"指定"却什么都没勾 = 不生效
    return true;
  }

  function describeSchema(schema) {
    if (!schema || !schema.properties) return "无参数";
    var required = schema.required || [];
    var keys = Object.keys(schema.properties);
    if (!keys.length) return "无参数";
    return keys.map(function (k) {
      var p = schema.properties[k] || {};
      var type = p.type || (p.enum ? "enum" : "any");
      var bits = [k, "(" + type + (required.indexOf(k) !== -1 ? ", 必填" : ", 可选") + ")"];
      if (p.enum) bits.push("取值: " + p.enum.join("/"));
      if (p.description) bits.push("— " + String(p.description).replace(/\s+/g, " ").slice(0, 120));
      return bits.join(" ");
    }).join("; ");
  }

  // ============================================================
  // 结果格式化
  // ============================================================
  function formatToolResult(result) {
    if (result === null || result === undefined) return "(无返回内容)";
    var parts = [];
    if (Array.isArray(result.content)) {
      result.content.forEach(function (c) {
        if (!c) return;
        if (c.type === "text") parts.push(c.text || "");
        else if (c.type === "image") parts.push("[图片]");
        else if (c.type === "audio") parts.push("[音频]");
        else if (c.type === "resource") parts.push((c.resource && (c.resource.text || c.resource.uri)) || "[资源]");
        else parts.push("[" + c.type + "]");
      });
    }
    var text = parts.filter(Boolean).join("\n").trim();
    if (!text && result.structuredContent) text = JSON.stringify(result.structuredContent);
    if (!text) text = JSON.stringify(result);
    if (result.isError) text = "⚠️ 工具报错: " + text;
    var limit = G.settings.maxResultChars;
    if (text.length > limit) text = text.slice(0, limit) + "\n…(已截断,共 " + text.length + " 字)";
    return text;
  }

  // 结果里是不是一次失败。工具本身调通了、但业务上失败的情况（ok:false），
  // 原本和成功一样打 ✅，看着像成功了 —— 这里把它认出来。
  function looksLikeFailure(text) {
    var t = String(text || "");
    if (/"ok"\s*:\s*false/.test(t)) return true;
    if (/^\s*(❌|⚠️)/.test(t)) return true;
    if (/工具报错|失败[：:]/.test(t)) return true;
    return false;
  }

  // 失败信息要看全 —— 不截断、保留换行（服务端的诊断是多行的）。
  // 成功信息仍然压成一行，避免刷屏。
  function logToolResult(name, text) {
    if (looksLikeFailure(text)) {
      log("⚠️ " + name + " → \n" + text);
    } else {
      var one = String(text).replace(/\n/g, " ");
      log("✅ " + name + " → " + (one.length > 200 ? one.slice(0, 200) + "…" : one));
    }
  }

  function trimRecapText(text) {
    if (!text) return text;
    var lines = String(text).split("\n");
    var kept = [];
    var skipping = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*(#+\s*)?(RECAP|回顾|前情提要|SUMMARY OF|CONTEXT RECAP)\b/i.test(line)) {
        skipping = true;
        kept.push(line.trim());
        continue;
      }
      if (skipping) {
        if (!line.trim() || /^\s*#{1,6}\s/.test(line)) { skipping = false; kept.push(line); }
        continue;
      }
      kept.push(line);
    }
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // 注入角色身份:只在 schema 真的声明了对应字段时才注入
  var PERSONA_KEYS = ["persona", "character", "speaker", "user", "user_name", "username", "role", "identity", "who"];

  function injectPersonaArgs(server, tool, args, ctx) {
    if (!server.injectPersona) return args;
    var props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
    var target = null;
    for (var i = 0; i < PERSONA_KEYS.length; i++) {
      if (Object.prototype.hasOwnProperty.call(props, PERSONA_KEYS[i])) { target = PERSONA_KEYS[i]; break; }
    }
    if (!target) return args;
    if (args[target] !== undefined && args[target] !== "") return args;
    var name = "";
    if (ctx && ctx.userPersona) name = ctx.userPersona.name || ctx.userPersona.handle || "";
    if (!name && ctx && ctx.conversation) name = ctx.conversation.name || ctx.conversation.handle || "";
    if (!name) return args;
    var copy = Object.assign({}, args);
    copy[target] = name;
    return copy;
  }

  function pickArgKey(props, candidates, fallback) {
    for (var i = 0; i < candidates.length; i++) {
      if (Object.prototype.hasOwnProperty.call(props, candidates[i])) return candidates[i];
    }
    return fallback;
  }

  // ============================================================
  // ★ chat 扩展点 —— 宿主每轮发请求前调用
  // ============================================================

  // 记忆模式:真·发送前注入。宿主会 await 这个函数,返回的字符串
  // 直接进本轮 system prompt,不是"下一轮才生效"。
  function contextProvider(ctx) {
    G.hostCalled.contextProvider++;
    G.hostCalled.lastAt = Date.now();

    var query = String((ctx && ctx.latestUserMessage) || "").trim();
    if (!query) return "";

    var jobs = [];
    G.servers.forEach(function (server) {
      if (!modeAllowsMemory(server)) return;
      if (!serverAppliesTo(server, ctx)) return;
      var toolName = String(server.contextToolName || "").trim();
      if (!toolName) return;

      var tool = null;
      var list = server.cachedTools || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === toolName) { tool = list[i]; break; }
      }
      var props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
      var qKey = pickArgKey(props, ["query", "q", "question", "text", "keyword", "search"], "query");
      var nKey = pickArgKey(props, ["limit", "top_k", "topK", "n", "count", "k"], "limit");

      var args = {};
      args[qKey] = query;
      var n = parseInt(server.retrieveCount, 10);
      args[nKey] = isNaN(n) ? 5 : n;
      args = injectPersonaArgs(server, tool, args, ctx);

      jobs.push(
        callServerTool(server, toolName, args).then(function (result) {
          // 工具报错时不要把错误文本注入 prompt —— 那是给模型看的噪音,
          // 可能让它照着错误信息瞎编。记进日志即可。
          if (result && result.isError) {
            log("⚠️ 记忆检索 " + (server.name || toolName) + " 返回错误,已跳过注入");
            return null;
          }
          var text = formatToolResult(result);
          if (server.trimRecap) text = trimRecapText(text);
          if (!text || text === "(无返回内容)") return null;
          log("🔎 " + (server.name || toolName) + " 注入 " + text.length + " 字");
          return "◆ " + (server.name || toolName) + "\n" + text;
        }).catch(function (e) {
          log("❌ 记忆检索失败 " + (server.name || toolName) + ": " + e.message);
          return null;  // 失败不影响这轮对话
        })
      );
    });

    if (!jobs.length) return "";

    return Promise.all(jobs).then(function (parts) {
      var body = parts.filter(Boolean).join("\n\n");
      if (!body) return "";
      var out = "【检索到的相关信息】\n" + body;
      var cap = G.settings.maxInjectChars;
      if (out.length > cap) out = out.slice(0, cap) + "\n…(注入内容已截断)";
      G.lastInjectChars = out.length;
      return out;
    });
  }

  // 工具模式:声明给宿主,由模型自行决定何时调用
  function buildTools() {
    var out = [];
    G.servers.forEach(function (server) {
      if (!modeAllowsTools(server)) return;
      if (!server.enabled) return;
      (server.cachedTools || []).forEach(function (tool) {
        if (!isToolEnabled(server, tool.name)) return;
        out.push({
          // 宿主会自动加 pluginId: 前缀,这里只给自己的部分。
          // 用 serverId 前缀避免多个服务器有同名工具时撞车。
          id: server.id + "__" + tool.name,
          description: (server.name ? "[" + server.name + "] " : "") +
            (tool.description || tool.name),
          parameters: tool.inputSchema || { type: "object", properties: {} },
          execute: function (args, ctx) {
            G.hostCalled.toolExec++;
            G.hostCalled.lastAt = Date.now();
            // 执行时再判范围 —— scope 是插件级的,server 级要自己判
            if (!serverAppliesTo(server, ctx)) {
              return "该工具在当前会话不可用(执行范围限制)。";
            }
            var finalArgs = injectPersonaArgs(server, tool, args || {}, ctx);
            log("🔧 " + tool.name + " ← " + JSON.stringify(finalArgs).slice(0, 80));
            return callServerTool(server, tool.name, finalArgs).then(function (result) {
              var text = formatToolResult(result);
              if (server.trimRecap) text = trimRecapText(text);
              logToolResult(tool.name, text);
              return text;
            }).catch(function (e) {
              log("❌ " + tool.name + " 失败: " + e.message);
              return "工具调用失败: " + e.message;
            });
          }
        });
      });
    });
    return out;
  }

  // ============================================================
  // UI
  // ============================================================
  var CSS = [
    ".ferry-root{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;height:100%;overflow-y:auto;background:#111214;color:#eee;padding:12px;box-sizing:border-box;-webkit-overflow-scrolling:touch}",
    ".ferry-root *{box-sizing:border-box}",
    ".ferry-nav{display:flex;align-items:center;gap:6px;margin-bottom:14px;flex-wrap:wrap}",
    ".ferry-title{font-size:17px;font-weight:600;flex:1;min-width:0}",
    ".ferry-navbtn{background:#2a2b2f;color:#eee;border:none;border-radius:8px;padding:6px 11px;font-size:13px;cursor:pointer;font-family:inherit}",
    ".ferry-navbtn.active{background:#3b6ef0}",
    ".ferry-empty{color:#666;font-size:13px;text-align:center;padding:36px 0;line-height:1.6;white-space:pre-line}",
    ".ferry-card{background:#1b1c1f;border-radius:12px;padding:12px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px}",
    ".ferry-card-info{flex:1;min-width:0;cursor:pointer}",
    ".ferry-name{font-size:14px;font-weight:600}",
    ".ferry-url{font-size:12px;color:#888;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".ferry-meta{font-size:11px;color:#666;margin-top:3px;line-height:1.5}",
    ".ferry-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px}",
    ".ferry-dot.on{background:#4ade80}.ferry-dot.off{background:#666}",
    ".ferry-tabs{display:flex;border-bottom:1px solid #2a2b2f;margin-bottom:16px}",
    ".ferry-tab{flex:1;text-align:center;padding:10px 0;font-size:14px;color:#999;cursor:pointer}",
    ".ferry-tab.active{color:#6ea8fe;border-bottom:2px solid #3b6ef0;font-weight:600}",
    ".ferry-field{margin-bottom:16px}",
    ".ferry-label{font-size:15px;font-weight:600;display:block;margin-bottom:2px}",
    ".ferry-hint{font-size:12px;color:#888;margin-bottom:8px;display:block;line-height:1.55}",
    ".ferry-input{width:100%;background:#1b1c1f;color:#eee;border:1px solid #333;border-radius:10px;padding:11px;font-size:14px;font-family:inherit}",
    ".ferry-input:focus{outline:none;border-color:#3b6ef0}",
    "textarea.ferry-input{min-height:90px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;resize:vertical}",
    ".ferry-switch{position:relative;width:44px;height:24px;flex-shrink:0;display:inline-block}",
    ".ferry-switch input{opacity:0;width:0;height:0}",
    ".ferry-slider{position:absolute;cursor:pointer;inset:0;background:#444;border-radius:24px;transition:.15s}",
    ".ferry-slider:before{content:'';position:absolute;height:18px;width:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}",
    ".ferry-switch input:checked+.ferry-slider{background:#3b6ef0}",
    ".ferry-switch input:checked+.ferry-slider:before{transform:translateX(20px)}",
    ".ferry-seg{display:flex;border:1px solid #333;border-radius:10px;overflow:hidden}",
    ".ferry-segbtn{flex:1;text-align:center;padding:10px 6px;font-size:13px;background:#1b1c1f;color:#ccc;cursor:pointer}",
    ".ferry-segbtn.active{background:#2a3a6e;color:#9ec2ff}",
    ".ferry-check{display:flex;align-items:flex-start;gap:9px;padding:9px 0;cursor:pointer}",
    ".ferry-check input{margin:2px 0 0;width:17px;height:17px;flex-shrink:0;accent-color:#3b6ef0}",
    ".ferry-check-body{flex:1;min-width:0}",
    ".ferry-check-title{font-size:13.5px;line-height:1.4}",
    ".ferry-check-note{font-size:11.5px;color:#888;margin-top:2px;line-height:1.5}",
    ".ferry-btnrow{display:flex;gap:8px;margin-top:18px}",
    ".ferry-btn{flex:1;border:none;border-radius:10px;padding:12px;font-size:14px;cursor:pointer;font-family:inherit}",
    ".ferry-btn.primary{background:#3b6ef0;color:#fff}",
    ".ferry-btn.secondary{background:#2a2b2f;color:#eee}",
    ".ferry-btn.danger{background:#7a2a2a;color:#fff}",
    ".ferry-btn.wide{width:100%;flex:none}",
    ".ferry-status{font-size:13px;margin-top:10px;line-height:1.6;white-space:pre-wrap;word-break:break-word}",
    ".ferry-status.success{color:#4ade80}.ferry-status.error{color:#f87171}.ferry-status.testing{color:#fbbf24}",
    ".ferry-step{background:#1b1c1f;border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:13px;line-height:1.6}",
    ".ferry-step-title{font-weight:600}",
    ".ferry-step.ok .ferry-step-title{color:#4ade80}",
    ".ferry-step.bad .ferry-step-title{color:#f87171}",
    ".ferry-step-detail{color:#aaa;font-size:12px;margin-top:2px;word-break:break-word}",
    ".ferry-step-hint{color:#fbbf24;font-size:12px;margin-top:5px;word-break:break-word}",
    ".ferry-tool{background:#1b1c1f;border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:8px}",
    ".ferry-tool-name{font-size:13px;font-weight:600;font-family:ui-monospace,monospace}",
    ".ferry-tool-desc{font-size:11px;color:#888;margin-top:2px;line-height:1.5}",
    ".ferry-log{font-size:11px;white-space:pre-wrap;max-height:240px;overflow:auto;background:#1b1c1f;border-radius:10px;padding:10px;margin:0;font-family:ui-monospace,monospace;line-height:1.6}",
    ".ferry-pre{font-size:11px;white-space:pre;overflow-x:auto;background:#0d0e10;border:1px solid #2a2b2f;border-radius:10px;padding:10px;margin:8px 0 0;font-family:ui-monospace,monospace;line-height:1.55}",
    ".ferry-note{background:#1b1c1f;border-left:3px solid #3b6ef0;border-radius:0 8px 8px 0;padding:10px 12px;font-size:12px;color:#bbb;line-height:1.7;margin-bottom:12px;white-space:pre-line}",
    ".ferry-note.warn{border-left-color:#fbbf24}",
    ".ferry-note.bad{border-left-color:#f87171;color:#f8a0a0}",
    ".ferry-note.ok{border-left-color:#4ade80}",
    ".ferry-sec{font-size:12px;color:#6ea8fe;font-weight:600;margin:20px 0 8px;padding-bottom:5px;border-bottom:1px solid #2a2b2f}"
  ].join("");

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function makeSwitch(checked, onChange) {
    var label = el("label", "ferry-switch");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    cb.onchange = function (e) { onChange(e.target.checked); };
    label.appendChild(cb);
    label.appendChild(el("span", "ferry-slider"));
    return label;
  }

  function makeCheck(title, note, checked, onChange) {
    var wrap = el("label", "ferry-check");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    cb.onchange = function (e) { onChange(e.target.checked); };
    wrap.appendChild(cb);
    var body = el("div", "ferry-check-body");
    body.appendChild(el("div", "ferry-check-title", title));
    if (note) body.appendChild(el("div", "ferry-check-note", note));
    wrap.appendChild(body);
    return wrap;
  }

  function fallbackCopy(text, done, roche) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (e) { roche.ui.toast("复制失败,请手动长按选中"); }
  }

  function copyText(roche, text, okMsg) {
    var done = function () { roche.ui.toast(okMsg || "已复制"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done, roche); });
    } else fallbackCopy(text, done, roche);
  }

  function schemaSkeleton(schema) {
    if (!schema || !schema.properties) return "{}";
    var obj = {};
    Object.keys(schema.properties).forEach(function (k) {
      var p = schema.properties[k] || {};
      if (p.enum && p.enum.length) obj[k] = p.enum[0];
      else if (p.type === "number" || p.type === "integer") obj[k] = 0;
      else if (p.type === "boolean") obj[k] = false;
      else if (p.type === "array") obj[k] = [];
      else if (p.type === "object") obj[k] = {};
      else obj[k] = "";
    });
    return JSON.stringify(obj, null, 2);
  }

  // ============================================================
  // 诊断
  // ============================================================
  function diagnose(server) {
    var steps = [];
    function add(title, ok, detail, hint) {
      steps.push({ title: title, ok: ok, detail: detail || "", hint: hint || "" });
    }
    return Promise.resolve().then(function () {
      var u = null;
      try { u = new URL(server.url); }
      catch (e) {
        add("URL 格式", false, server.url || "(空)", "地址要以 http:// 或 https:// 开头并带路径,例如 https://xxx.example.com/mcp");
        throw new Error("STOP");
      }
      add("URL 格式", true, u.href);
      if (u.pathname === "/" || u.pathname === "") {
        add("端点路径", false, "只填了域名,没有路径", "MCP 端点通常是 /mcp,少数是 /mcp-http 或 /sse。");
      } else add("端点路径", true, u.pathname);

      if (location.protocol === "https:" && u.protocol === "http:") {
        add("混合内容", false, "https 页面请求 http 地址", "浏览器会直接拦掉。配 https 域名或用代理。");
      } else add("混合内容", true, "协议匹配");

      add("连接方式", true, usingProxy(server)
        ? "经由代理 " + String(G.settings.proxyUrl).trim()
        : "浏览器直连(需要服务器支持 CORS)");
      return u;
    }).then(function (u) {
      if (usingProxy(server)) { add("服务器可达", true, "走代理,可达性由代理侧负责"); return true; }
      return fetch(u.origin, { method: "GET", mode: "no-cors", cache: "no-store" }).then(function () {
        add("服务器可达", true, "网络层能连上 " + u.origin);
        return true;
      }, function () {
        add("服务器可达", false, "连 " + u.origin + " 都连不上",
          "域名解析失败 / 服务没起来 / 证书问题。先在浏览器新标签页直接打开这个域名。");
        return false;
      });
    }).then(function (reachable) {
      return testAndListTools(server).then(function (info) {
        add(usingProxy(server) ? "代理转发" : "跨域与预检", true, "请求成功抵达服务器");
        add("身份认证", true, "服务器接受了当前认证方式(" + server.authType + ")");
        add("MCP 握手", true, "协议 " + info.protocolVersion +
          (info.serverInfo ? " · " + (info.serverInfo.name || "") + " " + (info.serverInfo.version || "") : "") +
          " · " + info.latency + "ms");
        add("会话 ID", true, info.sessionVisible ? "能读到 Mcp-Session-Id" : "此服务器无状态(正常)");
        add("工具列表", info.tools.length > 0, "拉到 " + info.tools.length + " 个工具",
          info.tools.length === 0 ? "连接通了但服务器没暴露工具。" : "");
        return { steps: steps, tools: info.tools, ok: true };
      }, function (e) {
        if (e instanceof HttpError) {
          if (e.status === 401 || e.status === 403) {
            add("请求抵达", true, "请求发出去了");
            add("身份认证", false, "HTTP " + e.status,
              "暗号不对或认证方式选错。Bearer 模式只填 token 本身(不带 Bearer 前缀)。");
          } else if (e.status === 404) {
            add("请求抵达", true, "请求发出去了");
            add("端点存在", false, "HTTP 404", "路径写错。常见是 /mcp,钓鱼服务是 /mcp-http。");
          } else if (e.status === 406) {
            add("Accept 头", false, "HTTP 406", "插件已自动发送正确的 Accept,若仍 406 说明中间层改了请求头。");
          } else if (e.status === 405) {
            add("传输类型", false, "HTTP 405", "这个端点可能是传统 SSE,到基础页切换传输类型。");
          } else if (e.status === 502 && usingProxy(server)) {
            add("代理转发", false, "HTTP 502 — " + String(e.body).slice(0, 160),
              "代理连不上目标。检查目标域名是否在代理的白名单里。");
          } else {
            add("HTTP 响应", false, "HTTP " + e.status + " — " + String(e.body).slice(0, 160), "看服务端日志。");
          }
        } else if (e instanceof RpcError) {
          add("请求抵达", true, "请求发出去了");
          add("MCP 协议", false, e.message, "服务器返回 MCP 层错误。");
        } else if (/CORS|跨域|代理/.test(e.message)) {
          add(usingProxy(server) ? "代理转发" : "跨域与预检", false, e.message,
            usingProxy(server) ? "检查代理地址和部署状态。"
              : (reachable
                ? "服务器通,问题在 CORS。浏览器先发不带 Authorization 的 OPTIONS 预检,被暗号锁判成 401。解法:① 设置里填代理地址;② 用下面的按钮复制 Caddy 配置。"
                : "服务器本身连不上,先解决可达性。"));
        } else add("连接", false, e.message, "");
        return { steps: steps, tools: null, ok: false };
      });
    }).catch(function (e) {
      if (e && e.message === "STOP") return { steps: steps, tools: null, ok: false };
      add("诊断异常", false, (e && e.message) || String(e), "");
      return { steps: steps, tools: null, ok: false };
    });
  }

  function buildCaddySnippet(server) {
    var host = "your-mcp.example.com", path = "/mcp";
    try { var u = new URL(server.url); host = u.host; path = u.pathname || "/mcp"; } catch (e) {}
    var token = (server.authType === "bearer" && String(server.bearerToken || "").trim()) ||
      (server.authType === "header" && String(server.headerValue || "").trim()) || "你的暗号";
    var pathPrefix = path.replace(/\/+$/, "") || "/mcp";
    return [
      host + " {",
      "\t# ① 先放行 CORS 预检 —— 浏览器发的 OPTIONS 不带 Authorization,",
      "\t#    必须排在暗号检查之前,否则一律 401。",
      "\t@preflight method OPTIONS",
      "\thandle @preflight {",
      "\t\theader Access-Control-Allow-Origin \"*\"",
      "\t\theader Access-Control-Allow-Methods \"GET, POST, DELETE, OPTIONS\"",
      "\t\theader Access-Control-Allow-Headers \"Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID\"",
      "\t\theader Access-Control-Max-Age \"86400\"",
      "\t\trespond 204",
      "\t}",
      "",
      "\t# ② 暗号锁(只挡真实请求)",
      "\t@blocked {",
      "\t\tpath " + pathPrefix + "*",
      "\t\tnot header Authorization \"*" + token + "*\"",
      "\t}",
      "\trespond @blocked 401",
      "",
      "\t# ③ 必须 expose 会话头,否则 JS 读不到 Mcp-Session-Id",
      "\theader {",
      "\t\tAccess-Control-Allow-Origin \"*\"",
      "\t\tAccess-Control-Expose-Headers \"Mcp-Session-Id, MCP-Protocol-Version\"",
      "\t}",
      "",
      "\treverse_proxy 127.0.0.1:端口号 {",
      "\t\tflush_interval -1   # SSE 不缓冲,必须加",
      "\t}",
      "}"
    ].join("\n");
  }

  var MODE_LABEL = { tools: "工具", memory: "记忆", all: "全部" };
  var AUTH_LABEL = { none: "无", bearer: "Bearer", header: "Header" };

  if (!window.RochePlugin || typeof window.RochePlugin.register !== "function") {
    console.error("[" + PLUGIN_ID + "] 找不到 window.RochePlugin,插件无法注册");
    return;
  }

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: "渡口",
    version: VERSION,

    // ★★★ 未文档化但官方实现的扩展点 ★★★
    chat: {
      // 不设 scope,插件级全局生效;每个 server 的范围在内部各自判定
      contextProvider: contextProvider,
      get tools() { return buildTools(); }
    },

    apps: [{
      id: APP_ID,
      name: "渡口",
      icon: "extension",
      iconImage: "",

      mount: function (container, roche) {
        G.roche = roche;

        var state = {
          view: "list",
          editing: null,
          editTab: "basic",
          testStatus: "idle",
          testMessage: "",
          diagSteps: null,
          diagRunning: false,
          testTool: null,
          testArgs: "",
          testOutput: "",
          conversations: []
        };

        var style = document.createElement("style");
        style.textContent = CSS;
        container.appendChild(style);
        var root = el("div", "ferry-root");
        container.appendChild(root);

        function persist() { return saveServers(roche); }

        function renderNav() {
          var nav = el("div", "ferry-nav");
          nav.appendChild(el("div", "ferry-title", "渡口"));
          [
            ["服务器", ["list", "edit"], function () { state.view = "list"; render(); }],
            ["状态", ["status"], function () { state.view = "status"; render(); }],
            ["设置", ["settings"], function () { state.view = "settings"; render(); }]
          ].forEach(function (item) {
            var b = el("button", "ferry-navbtn" + (item[1].indexOf(state.view) !== -1 ? " active" : ""), item[0]);
            b.onclick = item[2];
            nav.appendChild(b);
          });
          var close = el("button", "ferry-navbtn", "返回");
          close.onclick = function () { roche.ui.closeApp(); };
          nav.appendChild(close);
          root.appendChild(nav);
        }

        function renderList() {
          var add = el("button", "ferry-btn primary wide", "+ 添加 MCP 服务");
          add.style.marginBottom = "12px";
          add.onclick = function () { openEdit(null); };
          root.appendChild(add);

          if (!G.servers.length) {
            root.appendChild(el("div", "ferry-empty",
              "还没有添加 MCP 服务。\n点上方按钮添加,填好后一定要先「测试连接」把工具列表拉下来。"));
          }

          G.servers.forEach(function (server) {
            var card = el("div", "ferry-card");
            var info = el("div", "ferry-card-info");
            info.appendChild(el("div", "ferry-name", server.name || "未命名"));
            info.appendChild(el("div", "ferry-url", server.url || "(未填地址)"));
            var count = (server.cachedTools || []).length;
            var enabledCount = (server.toolsEnabled === null || server.toolsEnabled === undefined)
              ? count : server.toolsEnabled.length;
            var meta = el("div", "ferry-meta");
            meta.appendChild(el("span", "ferry-dot " + (server.enabled ? "on" : "off")));
            meta.appendChild(document.createTextNode(
              (server.enabled ? "已启用" : "已禁用") +
              " · " + (MODE_LABEL[server.mode] || server.mode) +
              " · " + (AUTH_LABEL[server.authType] || server.authType) +
              " · " + (count ? enabledCount + "/" + count + " 个工具" : "未拉取工具") +
              (server.scopeType === "selected" ? " · 限定范围" : "") +
              (usingProxy(server) ? " · 走代理" : "")
            ));
            info.appendChild(meta);
            info.onclick = function () { openEdit(server); };
            card.appendChild(info);
            card.appendChild(makeSwitch(server.enabled, function (v) {
              server.enabled = v;
              persist().then(render);
            }));
            root.appendChild(card);
          });

          if (G.servers.length) {
            root.appendChild(el("div", "ferry-note ok",
              "✅ 无需再把提示词粘进人设。\n" +
              "工具会自动声明给模型,记忆会在每次发送前自动注入。\n" +
              "去「状态」页确认宿主是否真的在调用本插件。"));
          }
        }

        function openEdit(server) {
          state.editing = server ? JSON.parse(JSON.stringify(server)) : emptyServer();
          if (!state.editing.cachedTools) state.editing.cachedTools = [];
          if (!state.editing.scopeConversationIds) state.editing.scopeConversationIds = [];
          if (!state.editing.scopeConversationTypes) state.editing.scopeConversationTypes = [];
          state.editTab = "basic";
          state.diagSteps = null;
          state.testTool = null;
          state.testOutput = "";
          if (state.editing.cachedTools.length) {
            state.testStatus = "success";
            state.testMessage = "上次已缓存 " + state.editing.cachedTools.length + " 个工具,点「测试连接」可刷新";
          } else { state.testStatus = "idle"; state.testMessage = ""; }
          state.view = "edit";
          if (!state.conversations.length) {
            roche.conversation.list().then(function (list) {
              state.conversations = list || [];
              if (state.view === "edit") render();
            }).catch(function () {});
          }
          render();
        }

        function doTest() {
          if (!state.editing.url) {
            state.testStatus = "error";
            state.testMessage = "请先填服务 URL";
            return render();
          }
          state.testStatus = "testing";
          state.testMessage = "连接中…";
          render();
          testAndListTools(state.editing).then(function (info) {
            state.editing.cachedTools = info.tools;
            state.testStatus = "success";
            state.testMessage = "✅ 连接成功 · 延迟 " + info.latency + "ms · 协议 " + info.protocolVersion +
              (info.serverInfo ? "\n服务端: " + (info.serverInfo.name || "?") + " " + (info.serverInfo.version || "") : "") +
              "\n发现 " + info.tools.length + " 个工具" +
              (info.tools.length ? ",切到「工具」页可逐个开关和试运行" : "(服务器没有暴露工具)");
            render();
          }).catch(function (e) {
            state.testStatus = "error";
            state.testMessage = "❌ 连接失败\n" + e.message + "\n\n切到「诊断」页可以逐步定位。";
            render();
          });
        }

        function saveEditing() {
          if (!String(state.editing.name || "").trim()) return roche.ui.toast("请填名称");
          if (!String(state.editing.url || "").trim()) return roche.ui.toast("请填服务 URL");
          if (state.editing.authType === "bearer" && !String(state.editing.bearerToken || "").trim())
            return roche.ui.toast("身份验证选了 Bearer,请填 token");
          if (state.editing.authType === "header" && !String(state.editing.headerName || "").trim())
            return roche.ui.toast("身份验证选了 Header,请填 header 名称");
          if (modeAllowsMemory(state.editing) && !String(state.editing.contextToolName || "").trim())
            return roche.ui.toast("记忆模式需要填「调用的 tool 名」");
          state.editing.url = String(state.editing.url).trim();
          var idx = -1;
          for (var i = 0; i < G.servers.length; i++) {
            if (G.servers[i].id === state.editing.id) { idx = i; break; }
          }
          if (idx === -1) G.servers.push(state.editing);
          else G.servers[idx] = state.editing;
          resetConn(state.editing);
          persist().then(function () {
            state.view = "list";
            roche.ui.toast("已保存");
            render();
          });
        }

        function deleteEditing() {
          roche.ui.confirm({
            title: "删除这个服务?",
            message: '将删除 "' + (state.editing.name || "未命名") + '",不可撤销。'
          }).then(function (ok) {
            if (!ok) return;
            var id = state.editing.id;
            G.servers = G.servers.filter(function (s) { return s.id !== id; });
            delete G.conns[id];
            closeSse(id);
            persist().then(function () { state.view = "list"; render(); });
          });
        }

        function renderEdit() {
          root.appendChild(el("div", "ferry-title", state.editing.name || "新 MCP 服务"));
          var tabs = el("div", "ferry-tabs");
          tabs.style.marginTop = "12px";
          [["basic", "基础"], ["mode", "模式"], ["tools", "工具"], ["diag", "诊断"]].forEach(function (t) {
            var tab = el("div", "ferry-tab" + (state.editTab === t[0] ? " active" : ""), t[1]);
            tab.onclick = function () { state.editTab = t[0]; render(); };
            tabs.appendChild(tab);
          });
          root.appendChild(tabs);

          if (state.editTab === "basic") renderBasic();
          else if (state.editTab === "mode") renderMode();
          else if (state.editTab === "tools") renderTools();
          else renderDiag();

          var row = el("div", "ferry-btnrow");
          var exists = G.servers.some(function (s) { return s.id === state.editing.id; });
          if (exists) {
            var del = el("button", "ferry-btn danger", "删除");
            del.onclick = deleteEditing;
            row.appendChild(del);
          }
          var back = el("button", "ferry-btn secondary", "返回");
          back.onclick = function () { state.view = "list"; render(); };
          row.appendChild(back);
          var save = el("button", "ferry-btn primary", "保存");
          save.onclick = saveEditing;
          row.appendChild(save);
          root.appendChild(row);
        }

        function field(labelText, hintText) {
          var f = el("div", "ferry-field");
          if (labelText) f.appendChild(el("span", "ferry-label", labelText));
          if (hintText) f.appendChild(el("span", "ferry-hint", hintText));
          return f;
        }

        function textField(labelText, hintText, value, placeholder, onInput) {
          var f = field(labelText, hintText);
          var input = el("input", "ferry-input");
          input.placeholder = placeholder || "";
          input.value = value || "";
          input.oninput = function (e) { onInput(e.target.value); };
          f.appendChild(input);
          return f;
        }

        function segField(labelText, hintText, options, current, onPick) {
          var f = field(labelText, hintText);
          var seg = el("div", "ferry-seg");
          options.forEach(function (o) {
            var b = el("div", "ferry-segbtn" + (current === o[0] ? " active" : ""),
              (current === o[0] ? "✓ " : "") + o[1]);
            b.onclick = function () { onPick(o[0]); render(); };
            seg.appendChild(b);
          });
          f.appendChild(seg);
          return f;
        }

        function renderBasic() {
          var ef = el("div", "ferry-field");
          ef.style.display = "flex";
          ef.style.alignItems = "center";
          ef.style.justifyContent = "space-between";
          var left = el("div");
          left.appendChild(el("span", "ferry-label", "启用"));
          var h = el("span", "ferry-hint", "关掉后这个服务不参与任何调用");
          h.style.marginBottom = "0";
          left.appendChild(h);
          ef.appendChild(left);
          ef.appendChild(makeSwitch(state.editing.enabled, function (v) { state.editing.enabled = v; }));
          root.appendChild(ef);

          root.appendChild(textField("名称", "随便起,会显示给模型看", state.editing.name, "例如 视频识别",
            function (v) { state.editing.name = v; }));
          root.appendChild(textField("服务 URL",
            "要带完整路径。常见是 /mcp,有些是 /mcp-http 或 /sse。只填域名一定连不上。",
            state.editing.url, "https://xxx.example.com/mcp", function (v) { state.editing.url = v; }));
          root.appendChild(segField("传输类型", "先试 Streamable HTTP,连不上再切 SSE",
            [["streamable-http", "Streamable HTTP"], ["sse", "传统 SSE"]],
            state.editing.transport, function (v) { state.editing.transport = v; }));

          root.appendChild(el("div", "ferry-sec", "身份验证"));
          root.appendChild(segField("", "", [["none", "无"], ["bearer", "Bearer"], ["header", "Header"]],
            state.editing.authType, function (v) { state.editing.authType = v; }));

          if (state.editing.authType === "bearer") {
            root.appendChild(textField("Bearer Token",
              "只填 token 本身,不要带 Bearer 前缀 —— 插件会自动拼",
              state.editing.bearerToken, "粘贴你的暗号", function (v) { state.editing.bearerToken = v; }));
          } else if (state.editing.authType === "header") {
            root.appendChild(textField("Header 名称", "例如 X-API-Key",
              state.editing.headerName, "X-API-Key", function (v) { state.editing.headerName = v; }));
            root.appendChild(textField("Header 值", "",
              state.editing.headerValue, "值", function (v) { state.editing.headerValue = v; }));
          }

          var testBtn = el("button", "ferry-btn primary wide",
            (state.editing.cachedTools || []).length ? "重新测试连接" : "测试连接并拉取工具列表");
          testBtn.style.marginTop = "8px";
          testBtn.onclick = doTest;
          root.appendChild(testBtn);

          if (state.testMessage) root.appendChild(el("div", "ferry-status " + state.testStatus, state.testMessage));
        }

        function renderMode() {
          root.appendChild(segField("模式设置", "",
            [["tools", "工具"], ["memory", "记忆"], ["all", "全部"]],
            state.editing.mode, function (v) { state.editing.mode = v; }));

          if (state.editing.mode === "tools") {
            root.appendChild(el("div", "ferry-note ok",
              "工具会被声明给宿主,模型自行决定何时调用,结果自动回填进本轮对话。\n" +
              "走的是 Roche 原生工具协议,不需要 LLM 支持 function calling。"));
          } else if (state.editing.mode === "memory") {
            root.appendChild(el("div", "ferry-note ok",
              "每次发送前自动 query 并注入 system prompt —— 这是真·发送前注入,当轮即生效。\n" +
              "适用于向量记忆和长期事实库,所有 LLM 通用。"));
          } else {
            root.appendChild(el("div", "ferry-note ok",
              "工具声明 + 发送前记忆注入,两者都启用。"));
          }

          root.appendChild(el("div", "ferry-sec", "通用选项"));
          root.appendChild(makeCheck("注入角色身份",
            "调用时把当前用户人设名填进参数。只在工具 schema 真的声明了 persona/user/speaker 这类字段时才注入,否则乱塞会被服务端拒绝。",
            state.editing.injectPersona, function (v) { state.editing.injectPersona = v; }));
          root.appendChild(makeCheck("跳过代理(直连,需 server 支持)",
            G.settings.proxyUrl
              ? "当前配了代理。勾上本服务改为浏览器直连 —— 需要服务器自己放行 CORS 预检。"
              : "当前没配代理,本来就是直连。要用代理请先去「设置」填地址。",
            state.editing.skipProxy, function (v) { state.editing.skipProxy = v; render(); }));
          root.appendChild(makeCheck("工具结果缓存 5 分钟",
            "相同工具 + 相同参数在 5 分钟内直接复用上次结果。",
            state.editing.cacheResults, function (v) { state.editing.cacheResults = v; }));

          if (modeAllowsMemory(state.editing)) {
            root.appendChild(el("div", "ferry-sec", "记忆模式参数"));
            var toolNames = (state.editing.cachedTools || []).map(function (t) { return t.name; });
            root.appendChild(textField("context 模式:调用的 tool 名",
              toolNames.length ? "已发现: " + toolNames.join(", ") : "先在「基础」页测试连接",
              state.editing.contextToolName, "例如 search_memory",
              function (v) { state.editing.contextToolName = v; }));

            var rc = field("检索条数", "传给该工具的 limit / top_k 参数,默认 5");
            var rcInput = el("input", "ferry-input");
            rcInput.type = "number";
            rcInput.value = state.editing.retrieveCount;
            rcInput.onchange = function (e) {
              var n = parseInt(e.target.value, 10);
              state.editing.retrieveCount = isNaN(n) ? 5 : Math.min(100, Math.max(1, n));
            };
            rc.appendChild(rcInput);
            root.appendChild(rc);

            root.appendChild(makeCheck("自动精简内建 RECAP 细节",
              "把返回内容里 RECAP / 前情提要 段落的细节压掉,只留标题。启发式实现,不保证适配所有格式。",
              state.editing.trimRecap, function (v) { state.editing.trimRecap = v; }));
          }

          root.appendChild(el("div", "ferry-sec", "执行范围"));
          root.appendChild(segField("", "", [["all", "全部会话"], ["selected", "指定范围"]],
            state.editing.scopeType, function (v) { state.editing.scopeType = v; }));

          if (state.editing.scopeType === "selected") {
            root.appendChild(el("div", "ferry-note warn",
              "按会话类型和/或具体会话限定。两者都留空 = 这个服务不会生效。"));

            var types = state.editing.scopeConversationTypes || [];
            root.appendChild(makeCheck("仅单聊", "", types.indexOf("direct") !== -1, function (c) {
              var s = (state.editing.scopeConversationTypes || []).filter(function (x) { return x !== "direct"; });
              if (c) s.push("direct");
              state.editing.scopeConversationTypes = s;
            }));
            root.appendChild(makeCheck("仅群聊", "", types.indexOf("group") !== -1, function (c) {
              var s = (state.editing.scopeConversationTypes || []).filter(function (x) { return x !== "group"; });
              if (c) s.push("group");
              state.editing.scopeConversationTypes = s;
            }));

            var lbl = el("div", "ferry-label", "指定会话");
            lbl.style.marginTop = "12px";
            root.appendChild(lbl);
            if (!state.conversations.length) {
              root.appendChild(el("div", "ferry-empty", "正在读取会话列表…"));
            } else {
              state.conversations.forEach(function (c) {
                var ids = state.editing.scopeConversationIds || [];
                root.appendChild(makeCheck(
                  (c.name || c.title || c.handle || c.id) + (c.isGroup ? " (群聊)" : ""), "",
                  ids.indexOf(c.id) !== -1, function (checked) {
                    var s = (state.editing.scopeConversationIds || []).filter(function (x) { return x !== c.id; });
                    if (checked) s.push(c.id);
                    state.editing.scopeConversationIds = s;
                  }));
              });
            }
          }
        }

        function renderTools() {
          var tools = state.editing.cachedTools || [];
          if (!tools.length) {
            root.appendChild(el("div", "ferry-empty", "还没有工具列表。\n先回「基础」页测试连接。"));
            return;
          }
          var bulk = el("div", "ferry-btnrow");
          bulk.style.marginTop = "0";
          bulk.style.marginBottom = "12px";
          var all = el("button", "ferry-btn secondary", "全部启用");
          all.onclick = function () { state.editing.toolsEnabled = null; render(); };
          var none = el("button", "ferry-btn danger", "全部禁用");
          none.onclick = function () { state.editing.toolsEnabled = []; render(); };
          bulk.appendChild(all); bulk.appendChild(none);
          root.appendChild(bulk);

          tools.forEach(function (tool) {
            var row = el("div", "ferry-tool");
            var info = el("div");
            info.style.flex = "1";
            info.style.minWidth = "0";
            info.appendChild(el("div", "ferry-tool-name", tool.name));
            info.appendChild(el("div", "ferry-tool-desc", tool.description || "(无描述)"));
            info.appendChild(el("div", "ferry-tool-desc", "参数: " + describeSchema(tool.inputSchema)));
            var run = el("button", "ferry-navbtn", "试运行");
            run.style.marginTop = "6px";
            run.onclick = function () {
              state.testTool = tool;
              state.testArgs = schemaSkeleton(tool.inputSchema);
              state.testOutput = "";
              render();
            };
            info.appendChild(run);
            row.appendChild(info);
            row.appendChild(makeSwitch(isToolEnabled(state.editing, tool.name), function (checked) {
              if (state.editing.toolsEnabled === null || state.editing.toolsEnabled === undefined) {
                state.editing.toolsEnabled = tools.map(function (t) { return t.name; });
              }
              var set = state.editing.toolsEnabled.filter(function (n) { return n !== tool.name; });
              if (checked) set.push(tool.name);
              state.editing.toolsEnabled = set;
              render();
            }));
            root.appendChild(row);
          });

          if (state.testTool) {
            var box = field("试运行 " + state.testTool.name, "改好参数 JSON 后点执行");
            var ta = el("textarea", "ferry-input");
            ta.value = state.testArgs;
            ta.oninput = function (e) { state.testArgs = e.target.value; };
            box.appendChild(ta);
            var go = el("button", "ferry-btn primary wide", "执行");
            go.style.marginTop = "8px";
            go.onclick = function () {
              var args;
              try { args = JSON.parse(state.testArgs || "{}"); }
              catch (e) { state.testOutput = "参数不是合法 JSON: " + e.message; return render(); }
              state.testOutput = "执行中…";
              render();
              var probe = JSON.parse(JSON.stringify(state.editing));
              probe.id = "probe-" + makeId();
              probe.cacheResults = false;
              callServerTool(probe, state.testTool.name, args).then(function (r) {
                state.testOutput = formatToolResult(r);
                delete G.conns[probe.id]; closeSse(probe.id); render();
              }).catch(function (e) {
                state.testOutput = "失败: " + e.message;
                delete G.conns[probe.id]; closeSse(probe.id); render();
              });
            };
            box.appendChild(go);
            if (state.testOutput) {
              var out = el("pre", "ferry-pre", state.testOutput);
              out.style.whiteSpace = "pre-wrap";
              box.appendChild(out);
            }
            root.appendChild(box);
          }
        }

        function renderDiag() {
          root.appendChild(el("div", "ferry-note",
            "逐步测试:地址格式 → 混合内容 → 服务器可达 → 跨域/代理 → 身份认证 → MCP 握手 → 工具列表。"));
          var runBtn = el("button", "ferry-btn primary wide", state.diagRunning ? "诊断中…" : "开始诊断");
          runBtn.disabled = state.diagRunning;
          runBtn.onclick = function () {
            state.diagRunning = true;
            state.diagSteps = null;
            render();
            diagnose(state.editing).then(function (r) {
              state.diagRunning = false;
              state.diagSteps = r.steps;
              if (r.tools) state.editing.cachedTools = r.tools;
              render();
            });
          };
          root.appendChild(runBtn);

          if (state.diagSteps) {
            state.diagSteps.forEach(function (s) {
              var box = el("div", "ferry-step " + (s.ok ? "ok" : "bad"));
              box.appendChild(el("div", "ferry-step-title", (s.ok ? "✅ " : "❌ ") + s.title));
              if (s.detail) box.appendChild(el("div", "ferry-step-detail", s.detail));
              if (s.hint) box.appendChild(el("div", "ferry-step-hint", "→ " + s.hint));
              root.appendChild(box);
            });
          }

          var lbl = el("div", "ferry-label", "Caddy 反代修复配置");
          lbl.style.marginTop = "18px";
          root.appendChild(lbl);
          root.appendChild(el("span", "ferry-hint", "不想用代理、想让浏览器直连,就用这段替换 Caddyfile 里对应域名的配置。"));
          var snippet = buildCaddySnippet(state.editing);
          root.appendChild(el("pre", "ferry-pre", snippet));
          var copyBtn = el("button", "ferry-btn secondary wide", "复制 Caddy 配置");
          copyBtn.style.marginTop = "8px";
          copyBtn.onclick = function () { copyText(roche, snippet, "已复制"); };
          root.appendChild(copyBtn);
        }

        // ---------- 状态页:确认宿主真的在调用本插件 ----------
        function renderStatus() {
          var hc = G.hostCalled;
          var everCalled = hc.contextProvider > 0 || hc.toolExec > 0;
          var hasMemoryServer = G.servers.some(function (s) { return modeAllowsMemory(s) && s.enabled; });

          if (everCalled) {
            root.appendChild(el("div", "ferry-note ok",
              "✅ 宿主扩展点正常工作\n" +
              "发送前注入被调用 " + hc.contextProvider + " 次\n" +
              "工具被执行 " + hc.toolExec + " 次\n" +
              (hc.lastAt ? "最近一次: " + new Date(hc.lastAt).toLocaleString() : "")));
          } else if (hasMemoryServer) {
            root.appendChild(el("div", "ferry-note warn",
              "⏳ 还没观察到宿主调用\n" +
              "去任意会话发一条消息,再回来看这里。\n" +
              "如果发了消息仍然是 0,说明这个 Roche 版本的 chat 扩展点不可用。"));
          } else {
            root.appendChild(el("div", "ferry-note",
              "还没有启用「记忆」或「全部」模式的服务,发送前注入不会被触发。\n" +
              "纯「工具」模式要等模型真的调用工具才会计数。"));
          }

          var tools = buildTools();
          root.appendChild(el("div", "ferry-sec", "当前声明给模型的工具 (" + tools.length + ")"));
          if (!tools.length) {
            root.appendChild(el("div", "ferry-empty", "没有工具。\n检查服务是否启用、模式是否含「工具」、工具开关是否打开。"));
          } else {
            tools.forEach(function (t) {
              var row = el("div", "ferry-tool");
              var info = el("div");
              info.style.flex = "1";
              info.style.minWidth = "0";
              info.appendChild(el("div", "ferry-tool-name", t.id));
              info.appendChild(el("div", "ferry-tool-desc", t.description));
              row.appendChild(info);
              root.appendChild(row);
            });
          }

          root.appendChild(el("div", "ferry-sec", "注入长度"));
          root.appendChild(el("div", "ferry-note",
            "上次注入 " + G.lastInjectChars + " 字(上限 " + G.settings.maxInjectChars + ")。\n" +
            "注入内容会占用 token。装了多个插件时各自的注入会累加。"));

          root.appendChild(el("div", "ferry-sec", "运行日志"));
          var pre = el("pre", "ferry-log", G.logLines.join("\n") || "(暂无日志)");
          root.appendChild(pre);
          G.onLogChange = function (t) { pre.textContent = t; };
          var clear = el("button", "ferry-btn secondary wide", "清空日志");
          clear.style.marginTop = "8px";
          clear.onclick = function () { G.logLines = []; render(); };
          root.appendChild(clear);
        }

        function renderSettings() {
          root.appendChild(el("div", "ferry-sec", "代理"));
          root.appendChild(el("div", "ferry-note",
            "Roche 是纯前端应用,插件在浏览器里直连 MCP 会撞上 CORS 预检" +
            "(浏览器发的 OPTIONS 不带 Authorization,被暗号锁判成 401)。\n" +
            "填代理地址后请求绕代理走一圈,不用改服务器。留空 = 全部直连。\n" +
            "⚠️ 暗号会经过这个代理,只填你自己部署的。"));
          root.appendChild(textField("代理地址", "例如 https://ferry.your-domain.com",
            G.settings.proxyUrl, "留空表示直连", function (v) {
              G.settings.proxyUrl = v;
              saveSettings(roche);
            }));

          root.appendChild(el("div", "ferry-sec", "超时与限制"));
          function numField(labelText, hintText, key, min, max) {
            var f = field(labelText, hintText);
            var input = el("input", "ferry-input");
            input.type = "number";
            input.value = G.settings[key];
            input.onchange = function (e) {
              var v = parseInt(e.target.value, 10);
              if (isNaN(v)) return;
              G.settings[key] = Math.min(max, Math.max(min, v));
              saveSettings(roche);
            };
            f.appendChild(input);
            return f;
          }
          root.appendChild(numField("普通请求超时(毫秒)", "握手和拉工具列表用,默认 30000", "timeoutMs", 3000, 120000));
          root.appendChild(numField("工具调用超时(毫秒)",
            "视频识别这类慢工具要调大,默认 120000。注意:发送前注入是阻塞的,这个值太大会让你的消息迟迟发不出去。",
            "toolTimeoutMs", 5000, 600000));
          root.appendChild(numField("单个结果最大字数", "超出会截断,默认 1200", "maxResultChars", 200, 20000));
          root.appendChild(numField("注入总长度上限", "所有记忆服务加起来的上限,默认 6000", "maxInjectChars", 500, 50000));

          var reset = el("button", "ferry-btn danger wide", "重置所有连接会话");
          reset.style.marginTop = "18px";
          reset.onclick = function () {
            Object.keys(G.conns).forEach(function (k) { delete G.conns[k]; });
            Object.keys(G.sseConns).forEach(closeSse);
            G.resultCache = {};
            roche.ui.toast("已重置,下次调用会重新握手");
          };
          root.appendChild(reset);
        }

        function render() {
          root.innerHTML = "";
          renderNav();
          if (state.view === "list") renderList();
          else if (state.view === "edit") renderEdit();
          else if (state.view === "status") renderStatus();
          else renderSettings();
        }

        root.appendChild(el("div", "ferry-empty", "加载中…"));
        return Promise.all([
          loadJson(roche, "servers", []),
          loadJson(roche, "settings", {})
        ]).then(function (r) {
          G.servers = (Array.isArray(r[0]) ? r[0] : []).map(migrateServer);
          G.settings = Object.assign({}, DEFAULT_SETTINGS, (r[1] && typeof r[1] === "object") ? r[1] : {});
          container.__ferryCleanup = function () { style.remove(); };
          render();
        });
      },

      unmount: function (container) {
        G.onLogChange = null;
        if (container.__ferryCleanup) {
          container.__ferryCleanup();
          delete container.__ferryCleanup;
        }
        container.replaceChildren();
      }
    }]
  });

  // 插件页面没打开时也要能工作 —— 从 storage 预加载配置
  if (window.Roche && window.Roche.storage) {
    Promise.all([
      loadJson(window.Roche, "servers", []),
      loadJson(window.Roche, "settings", {})
    ]).then(function (r) {
      if (!G.servers.length) G.servers = (Array.isArray(r[0]) ? r[0] : []).map(migrateServer);
      G.settings = Object.assign({}, DEFAULT_SETTINGS, (r[1] && typeof r[1] === "object") ? r[1] : {});
      log("配置已预加载: " + G.servers.length + " 个服务");
    }).catch(function () {});
  }

  window.__mcpFerry = {
    state: G,
    contextProvider: contextProvider,
    buildTools: buildTools,
    testAndListTools: testAndListTools,
    callServerTool: callServerTool,
    diagnose: diagnose,
    trimRecapText: trimRecapText,
    migrateServer: migrateServer,
    formatToolResult: formatToolResult,
    serverAppliesTo: serverAppliesTo
  };
})();
