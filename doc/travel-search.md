# 多站旅行比价（骨架）

状态：结构已落盘，抓取/语音工具未启用。实现见
`apps/ui-tars/src/main/cyrvis/travel-search.ts`。

## 目标流程

```text
用户语音
  -> 搜索意图识别（search-intent.ts）
  -> 查询解析：出发地 / 目的地 / 日期 / 人数
  -> 并行调用站点适配器（携程 / 去哪儿 / 飞猪）
  -> 隐藏浏览器抓取结构化报价
  -> 推荐层：最低价 / 最快 / 综合
  -> 语音播报 + 可选打开最优结果
```

## 已实现

| 模块 | 内容 | 状态 |
|---|---|---|
| `TravelQuery` / `TravelOffer` / `TravelSearchResult` | 查询、报价、错误的数据契约 | 完成 |
| `resolveCityCode` | 中文城市名 / 三位码 -> IATA 城市码 | 完成 |
| `buildCtripFlightUrl` | 单程 / 往返 URL | 完成，待真机校验 |
| `buildQunarFlightUrl` | 单程 / 往返参数 | 完成，待真机校验 |
| `buildFliggyFlightUrl` | 飞猪参数 | 完成，URL 待校验 |
| `travelSearch` | 并行调用适配器、收集错误 | 完成 |
| `recommendTravelOffers` | 最低价 / 最快 / 综合分 | 完成（确定性初版） |
| 适配器 `search()` | 隐藏浏览器 + DOM 提取 | TODO |
| 语音工具 `travel_search` | 暴露给 VoiceBrain | TODO（抓取可用后再接） |

## 为什么先不暴露给模型

适配器的 `search()` 还是 `not implemented`。现在把 `travel_search`
加进 `CYRVIS_VOICE_TOOLS` 会让模型调用一个必然失败的工具。先用
`buildSearchUrl` 验证站点 URL，再接隐藏浏览器提取，最后把工具结果
交给语音模型推荐。

## 下一步

1. 用隐藏 `BrowserWindow` 或本机 Chrome CDP 打开三个 `buildSearchUrl`
   结果页，等待价格节点出现。
2. 每个站点写一个 DOM 提取器，输出 `TravelOffer`；失败时返回
   `TravelSiteError`，不要阻塞其他站点。
3. 真实报价上跑 `recommendTravelOffers`，再让 LLM 根据航司、行李、
   经停和用户偏好做二次推荐。
4. 接入 `VoiceBrain`：用户说“帮我比较携程和去哪儿的机票”时调用
   `travel_search`；预订/支付前必须二次确认。
5. 反爬/验证码失败时回退到可见浏览器 + GUI Agent，并明确告诉用户
   当前只拿到了哪些站点。
