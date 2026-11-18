/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

const TOOL_TRIGGER_PATTERN =
  /打开|关闭|点击|双击|输入|搜索|查找|查询|浏览器|网页|页面|网址|读取|文件|目录|桌面|创建|新建|写入|移动|重命名|下载|安装|运行|执行|设置|切换|取消|暂停|恢复|继续|进度|状态|第几步|记住|记忆|当前窗口|前台窗口|天气|新闻|最新|实时|价格|股价|open |close |click |type |search |browser|url|file|folder|desktop|create |write |move |rename|download|install|run |setting|cancel|pause|resume|status|remember|weather|news|latest|price|active window/i;

export const shouldUseCascadeTools = (text: string) =>
  TOOL_TRIGGER_PATTERN.test(text);

export const shouldDisableThinking = (baseURL: string, model: string) => {
  const normalized = model.trim().toLowerCase();
  // Qwen3 plus models default to reasoning, which added 30-48s before the
  // first voice token in the cascade path. Voice replies need a direct answer.
  if (normalized.startsWith('qwen3') || normalized.startsWith('deepseek-')) {
    return true;
  }
  try {
    return new URL(baseURL).hostname.endsWith('deepseek.com');
  } catch {
    return false;
  }
};
