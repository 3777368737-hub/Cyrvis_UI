# CYRVIS 动态感知与刷新

> 更新时间：2026-11-19
>
> 状态：通用感知调度、增量资源仓库和浏览器标签页 Provider 已实现
>
> 适用代码：`apps/ui-tars/src/main/cyrvis/context/perception/`

## 1. 定位

动态感知属于工具矩阵，不属于 Router。

```text
工具矩阵：
  采集状态 -> 生成资源 -> 发现能力 -> 创建绑定 -> 动态工具面 -> 执行验证

Router：
  判断用户意图 -> 选择工具/执行器 -> 规划多步骤任务
```

Router 只消费工具矩阵提供的资源、能力和绑定，不负责轮询浏览器、窗口、应用或系统。

## 2. 总体链路

```text
系统事件 / 应用事件 / 文件监听 / 周期探针
                    ↓
            PerceptionScheduler
                    ↓
          PerceptionProvider[]
                    ↓
           ResourceDescriptor[]
                    ↓
        IncrementalResourceStore
     增量更新、去重、TTL、变更事件
                    ↓
              ResourceCatalog
       与系统应用、窗口、最近文件合并
                    ↓
              BindingResolver
          资源能力 -> ToolRegistry 方法
                    ↓
              RelevanceEngine
                    ↓
               ToolSurface
         动态选择最多 24 个模型可见工具
                    ↓
         Qwen / Cascade / MCP / GUI
                    ↓
              ToolRegistry
                    ↓
          感知 Provider 再次验证
```

## 3. 核心模型

### 3.1 PerceptionProvider

每个应用感知器只负责观察资源：

```ts
interface PerceptionProvider {
  id: string;
  intervalMs: number;
  ttlMs?: number;
  timeoutMs?: number;
  triggerToolIds?: string[];
  refresh(
    context: PerceptionContext,
    signal: AbortSignal,
  ): Promise<ResourceDescriptor[]>;
  dispose?(): void | Promise<void>;
}
```

Provider 不负责：

- 判断用户意图；
- 选择工具或执行器；
- 组合多步骤任务；
- 绕过 ToolRegistry、权限或确认策略。

### 3.2 PerceptionContext

Provider 刷新时可以读取：

- 当前系统快照；
- 当前用户上下文；
- 当前前台窗口；
- 当前时间。

禁止直接读取密码、Token、Cookie、聊天正文或其他敏感数据。

### 3.3 ResourceDescriptor

动态资源必须有稳定身份：

```ts
interface ResourceDescriptor {
  id: string;
  kind: ResourceKind;
  name: string;
  aliases: string[];
  source: string;
  active: boolean;
  health: ResourceHealth;
  providerIds: string[];
  capabilities: string[];
  updatedAt: number;
  metadata: Record<string, string | number | boolean | null>;
  parentId?: string;
  lastSeenAt?: number;
  expiresAt?: number;
  confidence?: number;
  sensitivity?: ContextSensitivity;
}
```

标题只能作为别名，不能作为唯一 ID。

| 资源           | 推荐稳定身份                   |
| -------------- | ------------------------------ |
| 进程           | PID + 进程启动时间             |
| Windows 窗口   | `HWND`                         |
| 浏览器标签页   | DevTools target ID             |
| VS Code 工作区 | workspace URI                  |
| 文档           | 文件路径 + 文档实例 ID         |
| Provider 对象  | Provider ID + remote object ID |

## 4. 增量资源仓库

`IncrementalResourceStore` 负责：

- 按 Provider 保存资源；
- 新资源 upsert；
- 消失资源 remove；
- 内容未变化时不触发上下文变更；
- 每次成功刷新延长 TTL；
- Provider 失败时保留最后一次有效资源；
- TTL 到期后自动移除；
- 为变化生成 revision；
- 记录新增和移除的资源 ID。

浏览器标签页每次都返回完整快照，资源仓库负责转换为增量变化。

## 5. 调度与刷新

`PerceptionScheduler` 负责：

- 首次启动立即刷新；
- 按 Provider 周期独立刷新；
- 同一 Provider 禁止并发刷新；
- 超时中止；
- 失败指数退避；
- 成功后退避计数清零；
- 工具执行后按 `triggerToolIds` 立即刷新；
- 运行时注册和注销 Provider；
- 保留最近一次有效资源，直到 TTL 到期；
- 暴露 Provider 健康和刷新统计。

Provider 状态：

| 状态       | 含义                       |
| ---------- | -------------------------- |
| `idle`     | 已注册但尚未刷新           |
| `healthy`  | 最近一次刷新成功           |
| `degraded` | 最近一次刷新失败，仍在重试 |

失败重试间隔从正常周期开始，按指数增加，最高默认 60 秒。

## 6. 刷新频率

推荐采用“事件优先，周期对账”：

| 数据                    | 推荐策略                       |
| ----------------------- | ------------------------------ |
| 前台窗口                | Windows 原生事件，2 秒轮询兜底 |
| 进程和顶层窗口          | 5 至 10 秒                     |
| 浏览器标签页            | 1 至 2 秒或 CDP/扩展事件       |
| 当前编辑器/文档         | Provider 事件或 1 至 5 秒      |
| 用户动作                | 工具执行后立即                 |
| 文件变化                | 文件监听优先                   |
| 已安装应用、Steam、服务 | 启动全扫，之后 10 分钟         |
| 磁盘、电池、硬件        | 30 秒至 10 分钟                |
| Provider 健康           | 30 秒                          |

不是每次刷新都需要更新 LLM 工具表。

```text
资源变化：
  更新资源上下文和相关绑定

工具集合、schema、可用性变化：
  更新 Qwen/Cascade 工具表
```

`ToolSurface` 只在可见工具集合、可用性或语义签名变化时发布新版本。

## 7. LLM 上下文

LLM 使用两条通道：

1. 资源上下文
   当前应用、窗口、标签页、文件、设备、焦点、最近动作和任务相关资源。

2. 工具定义
   当前真正可用且相关的工具 schema。

完整系统快照和全部资源不会无条件写入每轮提示词。资源很多时，只发送：

- 活动资源；
- 最近资源；
- 当前任务相关资源；
- 动态能力绑定；
- Provider 健康摘要。

浏览器标签页在上下文中使用稳定 target ID，例如：

```text
Browser tabs:
  *tab-docs: Project Docs (https://docs.example.com/guide)
  -tab-mail: Inbox (https://mail.example.com)
```

URL 进入上下文前会移除用户名、密码、query 和 hash，降低 Token 或隐私参数泄漏风险。

## 8. 浏览器标签页 Provider

`BrowserPerceptionProvider` 读取本机 Chrome/Edge DevTools：

```env
CYRVIS_BROWSER_DEBUG_URL=http://127.0.0.1:9222
CYRVIS_BROWSER_STATE_REFRESH_MS=2000
```

Windows 可以使用项目脚本启动一个带调试端口的独立浏览器配置：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/cyrvis/start-debug-browser.ps1 -Browser edge
```

该脚本使用独立 profile，不会自动接管已经运行且未开启调试端口的浏览器。
配置环境变量后需要启动或重启 CYRVIS，默认矩阵才会实例化浏览器感知 Provider。

每个 `type=page` target 会转换为：

```text
id: tab:browser-debug:<targetId>
kind: tab
name: page title
providerIds: [browser-debug]
capabilities:
  - browser.activate_tab
  - browser.close_tab
metadata.tabId: <targetId>
metadata.url: sanitized URL
```

绑定后可直接执行：

```text
browser.close_tab(tabId="targetId")
```

关闭后重新读取 `/json/list`，只有目标 target 消失才算验证成功。

### 8.1 限制

- 已经启动且没有开启远程调试端口的浏览器不能事后直接通过 CDP 接入；
- 默认配置使用 `127.0.0.1:9222`；
- 只允许 loopback DevTools 地址；
- 当前 DevTools Provider 只提供标签页管理，不提供 DOM、Cookie、上传下载和表单自动化；
- HTTP `/json/list` 通常不提供可靠的可视标签顺序，因此不能把数组下标当作稳定身份；
- 如果多个标签页标题相同，服务端应结合 URL、用户指代或后续浏览器扩展消歧。

## 9. 安全与隐私

- 所有 Provider 输出先进入资源仓库，不能直接执行工具；
- 工具执行仍经过 `ToolRegistry`；
- 写入、删除、关闭标签页等操作保留风险和确认策略；
- Provider 必须设置 TTL；
- 资源 URL 在上下文中去除敏感 query；
- 动态上下文标记为不可信数据，不能当作指令执行；
- 高敏感资源默认不进入长期记忆；
- 外部 Provider 继续使用 manifest、权限、签名和健康检查。

## 10. 新增应用 Provider

新增感知能力时：

1. 实现 `PerceptionProvider`；
2. 为对象分配稳定 ID；
3. 返回单一应用域资源，不返回其他应用数据；
4. 明确 `intervalMs`、`ttlMs` 和 `timeoutMs`；
5. 声明资源能够绑定的稳定工具；
6. 为会改变资源的工具设置 `triggerToolIds`；
7. 路径、账号、Token 和隐私数据必须过滤；
8. Provider 失败时不能伪造资源；
9. 增加注册、刷新、失败、TTL 和工具执行后验证测试；
10. 更新本文件和 `tool-matrix-capability-map.md`。

## 11. 代码入口

| 文件                                     | 职责                         |
| ---------------------------------------- | ---------------------------- |
| `context/perception/types.ts`            | Provider、状态和变更类型     |
| `context/perception/resource-store.ts`   | 增量资源、TTL、变化检测      |
| `context/perception/scheduler.ts`        | 周期、超时、退避和运行时注册 |
| `context/perception/browser-provider.ts` | 浏览器标签页感知             |
| `context/browser-cdp.ts`                 | Chrome/Edge DevTools 客户端  |
| `context/dynamic-context.ts`             | 合并资源、绑定能力和发布变化 |
| `context/binding-resolver.ts`            | 资源能力到工具方法           |
| `context/tool-surface.ts`                | 动态工具面和 LLM 同步        |

## 12. 验证

```bash
cd apps/ui-tars
npx vitest run src/main/cyrvis/context
npm run typecheck
npm run build:dist
```

当前测试覆盖：

- 资源 upsert、remove、未变化刷新和 TTL；
- Provider 成功、失败和运行时注册/注销；
- DevTools 标签页过滤和当前标签识别；
- 标签页资源绑定 `browser.close_tab`；
- 动态工具面激活；
- 关闭标签页后的重新感知验证。
