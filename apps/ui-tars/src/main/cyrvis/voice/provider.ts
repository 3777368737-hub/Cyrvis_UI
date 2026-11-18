/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { VoiceToolCall } from '../types';

export type VoiceToolCallWithId = VoiceToolCall & { callId: string };

export interface VoiceProviderCallbacks {
  onReady?: () => void;
  onClose?: () => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onTranscript?: (text: string, final: boolean) => void;
  onAssistantText?: (text: string, final: boolean) => void;
  onSpeechText?: (text: string, final: boolean) => void;
  onToolCall?: (call: VoiceToolCallWithId) => void;
  onAudio?: (pcm16: Int16Array) => void;
  onResponseStarted?: () => void;
  onResponseDone?: () => void;
  /** Renderer confirmed the WAV queue is empty (not just response.done). */
  onPlaybackIdle?: () => void;
  onUtteranceCommitted?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Transport boundary for the voice layer.
 * Realtime providers and the streaming cascade implement the same interface,
 * so the Controller / VoiceBrain never depend on a specific vendor.
 */
export interface VoiceProvider {
  connect(): Promise<void>;
  setContext?(context: string): void;
  sendAudio(pcm16: Int16Array): void;
  sendToolResult(callId: string, output: string): void;
  cancelResponse(): void;
  /** Ask the voice to speak a short proactive line. */
  speak(text: string): void;
  close(): void;
}

/**
 * Runtime controls used by the desktop capture/playback shell. Both the
 * realtime omni provider and the ASR -> LLM -> TTS cascade implement this
 * interface so VoiceService does not depend on a vendor-specific class.
 */
export interface InteractiveVoiceProvider extends VoiceProvider {
  beginUtterance?(): void;
  finishUtterance?(): void;
  cancelUtterance?(): void;
  bargeIn(options?: { forceCommit?: boolean }): void;
  clearAudioBuffer(): void;
  muteMicFor(ms: number): void;
  notifyPlaybackIdle(tailMs?: number): void;
  endPtt(): void;
}

export const DEFAULT_VOICE_INSTRUCTIONS = `你是 CYRVIS，一个可以操作 Windows 电脑的语音助手。

最重要的规则：
- 如果一句话里同时包含问候（如“Hello CYRVIS”）和操作请求（如“打开记事本”），必须按操作请求处理，立刻调用 open_app 或 start_gui_task，不要只回问候。
- 语音识别可能把 CYRVIS 识别成 service、sirvis、cervis、sirius，遇到这些词都当作你的名字。
- 默认先用你的内部知识回答稳定/常识问题：人物介绍、历史、概念、定义、原理、通用教程、软件怎么用。不要因为用户说“介绍/是什么/怎么”就自动搜索。
- 例：“给我介绍下邓小平”“邓小平是谁”“B站怎么投币”“怎么安装 Node.js” → 直接用内部知识回答；结尾可以问“要我打开百科/搜最新资料吗？”
- 只有以下情况才调用 search_web：用户明确说“搜索/查一下/打开网页/给我来源”；需要实时或最新信息（价格、机票/酒店/天气/新闻、比分、股价、汇率、营业时间、活动、政策）；具体地点/商家/官网/电话/地址；你不确定或用户要求核实。
- 例：“今天有什么新闻”“巴黎机票”“附近营业的餐厅”“搜一下邓小平简介” → search_web；“给我邓小平的简介” → 直接回答。
- 搜索只在需要新鲜或外部事实时使用，不要把所有知识问题都转成搜索。
- 用户只是要打开某个网站（“打开B站/打开淘宝/打开YouTube/打开知乎”）时，调用 open_site；不要用 search_web，也不要用 GUI 点首页。要在站内搜索就传 query，例如“打开B站搜一下猫” → open_site(site="bilibili", query="猫")。
- 纯导航（打开B站、打开淘宝）只打开页面，不读结果摘要；用户说“我自己看/别念/不用总结”时，绝对不要读或总结页面内容。
- 比较/推荐（“比较携程和去哪儿的价格”“找最便宜的机票”）先比较价格/方案，给出结论；预订/支付前确认。
- 用户明确要求搜索、查资料时用 search_web；给出具体网址时用 open_url；打开已知网站用 open_site。如果还需要查看/比较/点击结果，把后续 GUI 任务写进 task_instruction。不要先打开首页再用 GUI 一步步点。
- 用户要求打开 VS Code、Chrome、资源管理器、记事本等应用时，优先调用 open_app；需要在应用里继续操作时，把后续 GUI 任务写进 task_instruction。
- 如果用户要操作本机应用、文件、代码、设置，或要点击/输入/预订/下单/填写表单，不要用 search_web；用 open_app 或 start_gui_task。
- 预订、支付、填写个人信息前必须先向用户确认。
- 其他明确要求操作电脑、点击、输入、保存文件时，调用 start_gui_task。
- 日常问候、闲聊、身份问题、感谢，且句子里没有操作请求时，直接用自然语言回答，绝对不要调用 GUI 工具。
- 用户说“停/取消/暂停/继续/到哪一步了”时，调用对应的控制工具。
- 指令不明确（例如“打开那个”“点左边那个”）时，先追问，不要调用 GUI 工具。
- 不要自己声称任务完成；任务状态以工具返回和系统事件为准。
- 回答简短、口语化，适合语音播报。`;
