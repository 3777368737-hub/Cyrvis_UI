import type { CapabilityDescriptor } from '../tools/types';
import type { DynamicContextSnapshot, ResourceDescriptor } from './types';

const FALLBACK_CAPABILITIES = new Set([
  'screen.capture',
  'screen.ocr',
  'ui.inspect',
  'ui.action',
  'window.focus',
]);

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const tokens = (value: string): string[] =>
  normalize(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2);

const isUnknownActiveResource = (resource: ResourceDescriptor): boolean =>
  resource.active &&
  (resource.health === 'unknown' ||
    (resource.kind === 'application' && resource.providerIds.length === 0));

export class RelevanceEngine {
  fallbackCapabilities(snapshot: DynamicContextSnapshot): Set<string> {
    const fallbackResources = snapshot.resources.filter(
      isUnknownActiveResource,
    );
    if (!fallbackResources.length) {
      return new Set();
    }
    return new Set(
      fallbackResources.flatMap((resource) =>
        resource.capabilities.filter((capability) =>
          FALLBACK_CAPABILITIES.has(capability),
        ),
      ),
    );
  }

  score(
    capability: CapabilityDescriptor,
    snapshot: DynamicContextSnapshot,
    now = Date.now(),
  ): number {
    const activeResourceIds = new Set(snapshot.activeResourceIds);
    const activeBindings = snapshot.bindings.filter(
      (binding) =>
        binding.active &&
        binding.capabilityId === capability.id &&
        activeResourceIds.has(binding.resourceId || ''),
    );
    const recentResourceBindings = snapshot.bindings.filter(
      (binding) =>
        binding.capabilityId === capability.id &&
        snapshot.user.recentResourceIds.includes(binding.resourceId || ''),
    );
    let score = 0;

    if (
      capability.id.startsWith('context.') &&
      snapshot.activeResourceIds.length > 0
    ) {
      score += 30;
    }
    if (activeBindings.length) {
      score += 45;
    }
    if (recentResourceBindings.length) {
      score += 18;
    }
    if (
      activeBindings.some(
        (binding) => binding.providerId === capability.providerId,
      )
    ) {
      score += 10;
    }

    const fallback = this.fallbackCapabilities(snapshot);
    if (fallback.has(capability.id)) {
      score += 35;
    }

    const activeResources = snapshot.resources.filter((resource) =>
      activeResourceIds.has(resource.id),
    );
    const providerMatchesActiveResource = activeResources.some((resource) =>
      resource.providerIds.includes(capability.providerId),
    );
    if (providerMatchesActiveResource) {
      score += 25;
    }

    const contextText = [
      snapshot.user.recentRequest?.value || '',
      snapshot.user.currentTask?.instruction || '',
      snapshot.user.focusedControl?.value.name || '',
      ...activeResources.flatMap((resource) => [
        resource.name,
        ...resource.aliases,
      ]),
    ].join(' ');
    const contextTokens = new Set(tokens(contextText));
    const capabilityText = normalize(
      [
        capability.id,
        capability.description,
        ...capability.tags,
        capability.domain,
      ].join(' '),
    );
    if ([...contextTokens].some((token) => capabilityText.includes(token))) {
      score += 15;
    }

    const recent = snapshot.user.recentActions.find(
      (action) =>
        action.toolId === capability.id && now - action.at <= 10 * 60_000,
    );
    if (recent) {
      score += recent.ok ? 12 : -8;
    }
    if (capability.usage.lastUsedAt) {
      const ageMs = Math.max(0, now - capability.usage.lastUsedAt);
      if (ageMs <= 60 * 60_000) {
        score += 8;
      } else if (ageMs <= 24 * 60 * 60_000) {
        score += 3;
      }
    }

    if (capability.availability === 'degraded') {
      score -= 15;
    }
    if (capability.risk === 'high') {
      score -= 10;
    }
    return score;
  }
}
