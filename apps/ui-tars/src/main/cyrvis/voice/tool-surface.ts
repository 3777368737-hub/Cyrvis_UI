import { CYRVIS_VOICE_TOOLS, type QwenToolDefinition } from './tools';

// Keep richer voice navigation entry points. Their execution is delegated to
// the registry; the low-level names remain available to MCP and old callers.
export const NAVIGATION_TOOL_ALIASES: Record<string, string> = {
  'web.search': 'search_web',
  'web.open_url': 'open_url',
  'app.launch': 'open_app',
};

export const buildVoiceToolSurface = (
  dynamicTools: QwenToolDefinition[] = [],
): QwenToolDefinition[] => [
  ...dynamicTools.filter(
    (tool) =>
      !Object.keys(NAVIGATION_TOOL_ALIASES).some(
        (name) => tool.function.name === `cyrvis_${name.replaceAll('.', '_')}`,
      ),
  ),
  ...CYRVIS_VOICE_TOOLS,
];
