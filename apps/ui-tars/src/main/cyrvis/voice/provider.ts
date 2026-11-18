/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { VoiceToolCall } from '../types';
import type { QwenToolDefinition } from './tools';

export type VoiceToolCallWithId = VoiceToolCall & { callId: string };

export interface VoiceProviderCallbacks {
  onReady?: () => void;
  onClose?: () => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  /**
   * Return true when a deterministic front-end layer consumed the transcript.
   * Cascade must then skip its own ASR -> LLM turn.
   */
  onTranscript?: (text: string, final: boolean) => boolean | void;
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
  setTools?(tools: QwenToolDefinition[]): void;
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
- 如果一句话里同时包含问候（如“Hello CYRVIS”）和操作请求（如“打开记事本”），必须按操作请求处理，优先选择匹配的本地工具，必要时再调用 start_gui_task，不要只回问候。
- 语音识别可能把 CYRVIS 识别成 service、sirvis、cervis、sirius，遇到这些词都当作你的名字。
- 优先使用名字以 cyrvis_ 开头的本地快速工具。文件、目录、应用、窗口、剪贴板、系统、进程和网页直达操作，只要本地工具参数足够，就不要调用 start_gui_task。
- 如果当前可见工具无法完成，但可能属于 CYRVIS 的深层能力，先调用 capability.search 或 capability.describe，再通过 capability.invoke 调用。不要因为工具没有直接暴露就立即转 GUI。
- 文件路径优先使用“桌面”“下载”“文档”“图片”“音乐”“视频”等别名；相对路径默认位于用户主目录，不是项目目录。不要从项目文件夹名推断 Windows 用户名，也不要凭空构造 C:/Users/... 路径。
- 用户明确给出的绝对路径可以访问整个系统中的非敏感区域；敏感目录或敏感文件仍会要求用户确认。
- 查询系统硬件、磁盘、进程、窗口、已安装软件或 Steam 游戏时，优先调用 system.snapshot、system.search_apps、software.list_installed、steam.list_games；启动已安装软件使用 software.launch。只有本地能力无法完成时才使用 GUI。
- 只有本地工具无法完成，或任务必须查看/点击现有界面、处理登录弹窗、拖拽和复杂多步 GUI 时，才调用 start_gui_task。
- 日常问候、闲聊、身份问题、感谢，且句子里没有操作请求时，直接用自然语言回答，绝对不要调用 GUI 工具。
- 用户说“停/取消/暂停/继续/到哪一步了”时，调用对应的控制工具。
- 指令不明确（例如“打开那个”“点左边那个”）时，先追问，不要调用 GUI 工具。
- 不要自己声称任务完成；任务状态以工具返回和系统事件为准。
- 回答简短、口语化，适合语音播报。`;
