# 动态工具 Provider

> 状态：2026-11-18 已实现基础 Provider 生命周期。

## 1. 能力

CYRVIS 可从 manifest 动态加载 Provider，并根据系统状态启用或停用：

- `builtin`：把声明的要求和权限应用到已有工具，不启动新进程。
- `stdio`：启动独立 MCP Provider 进程，提供进程隔离。
- `streamable-http` / `sse`：连接远程 MCP Provider。

Provider 未满足要求时不会连接，但 manifest 中声明的工具仍以不可用能力进入
CapabilityCatalog，可由 `capability.search` 查看原因。

## 2. 默认目录

运行时会扫描：

```text
%APPDATA%\ui-tars-desktop\cyrvis\providers
<resources>/cyrvis/providers
CYRVIS_PROVIDER_MANIFEST_DIRS 中配置的目录
```

多个额外目录使用分号分隔：

```env
CYRVIS_PROVIDER_MANIFEST_DIRS=D:\providers;E:\team-providers
```

## 3. Manifest 示例

```json
{
  "schemaVersion": 1,
  "toolApiVersion": 1,
  "id": "local-echo",
  "name": "Local Echo Provider",
  "version": "1.0.0",
  "trust": "trusted",
  "signature": "ed25519:<base64-signature>",
  "enabled": true,
  "permissions": ["process.spawn", "remote.tools"],
  "requirements": {
    "platforms": ["win32"],
    "applications": ["Visual Studio Code"],
    "environment": ["EXAMPLE_TOKEN"]
  },
  "transport": {
    "type": "stdio",
    "command": "node",
    "args": ["D:\\providers\\echo-server.js"],
    "env": {
      "EXAMPLE_MODE": "safe"
    }
  },
  "tools": [
    {
      "remoteName": "echo",
      "domain": "system",
      "risk": "low",
      "tier": 2,
      "activation": "state",
      "priority": 60,
      "permissions": ["process.spawn", "remote.tools"]
    }
  ],
  "healthCheckIntervalMs": 30000
}
```

外部 Provider 必须显式列出允许暴露的远程工具。未在 `tools` 中声明的 MCP
工具不会注册。

## 4. 信任与签名

- `trusted`：必须配置 `CYRVIS_PROVIDER_PUBLIC_KEY`，并验证 manifest 签名。
- `untrusted`：默认拒绝。仅开发环境可设置
  `CYRVIS_ALLOW_UNTRUSTED_PROVIDERS=1`。
- `builtin`：保留给随 CYRVIS 发布的 manifest，外部目录不能声明此信任级别。

签名覆盖去除 `signature` 字段后的规范化 JSON。支持：

```text
ed25519:<base64>
rsa-sha256:<base64>
```

## 5. 权限

当前权限标识：

```text
filesystem.read
filesystem.write
desktop.app
desktop.window
clipboard.read
clipboard.write
system.read
system.process
network
office
process.spawn
remote.tools
```

可通过环境变量全局禁用：

```env
CYVRIS_DENIED_TOOL_PERMISSIONS=filesystem.write;process.spawn
```

被禁用权限对应的能力会保留在目录中，但标记为不可用。

## 6. 生命周期

```text
manifest 扫描/验证
  -> ProviderRegistry
  -> 预注册声明工具
  -> 系统要求/权限检查
  -> 连接外部 MCP
  -> ToolRegistry.replaceProvider
  -> ToolSurface 刷新
  -> Qwen/Cascade/MCP 工具面更新
```

启停触发条件包括：

- 应用安装、卸载或系统状态刷新；
- 环境变量、权限策略变化后重新加载；
- Provider 健康检查失败；
- manifest 新增、升级、损坏或删除；
- Provider 连接失败后的退避重试。

## 7. 使用统计与审计

工具调用会持久化到：

```text
%APPDATA%\ui-tars-desktop\cyrvis-tool-usage.json
%APPDATA%\ui-tars-desktop\cyrvis-tool-audit.jsonl
```

统计包含成功、失败、连续失败、最后调用时间和错误。ToolSurface 会使用近期
使用频率对工具顺序做小幅动态调整，但不会突破 Tier、权限或最大工具数限制。

## 8. 安全边界

- 外部 stdio Provider 使用独立子进程，不在 Electron 主进程执行外部代码。
- 不允许 manifest 直接提供任意 JavaScript 或 shell 字符串。
- 所有 MCP 工具调用仍经过 ToolRegistry、工具风险和确认策略。
- 未声明工具、未声明权限、错误 schema 版本和签名失败的 Provider 会被拒绝。
- 远程 HTTP/SSE Provider 只允许 `http` 或 `https` URL。
