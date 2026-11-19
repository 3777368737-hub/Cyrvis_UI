import type {
  CapabilityAvailability,
  CapabilityDescriptor,
} from '../tools/types';
import type {
  CapabilityBinding,
  ResourceDescriptor,
  ResourceHealth,
} from './types';

const availabilityForResource = (
  capability: CapabilityDescriptor,
  resource: ResourceDescriptor,
): CapabilityAvailability => {
  if (resource.health === 'unavailable') {
    return 'unavailable';
  }
  if (
    capability.availability === 'available' &&
    resource.health === 'degraded'
  ) {
    return 'degraded';
  }
  if (
    capability.availability === 'available' &&
    resource.health === 'unknown'
  ) {
    return 'degraded';
  }
  return capability.availability;
};

const defaultArgsFor = (
  capabilityId: string,
  resource: ResourceDescriptor,
): Record<string, unknown> => {
  if (capabilityId === 'software.launch') {
    return { query: resource.name };
  }
  if (capabilityId === 'steam.launch_game') {
    const appId = resource.metadata.steamAppId;
    return typeof appId === 'string' ? { query: appId } : {};
  }
  if (capabilityId.startsWith('window.')) {
    return { query: resource.name };
  }
  if (
    capabilityId === 'browser.activate_tab' ||
    capabilityId === 'browser.close_tab'
  ) {
    const tabId = resource.metadata.tabId;
    return typeof tabId === 'string' ? { tabId } : {};
  }
  return {};
};

const resourceReason = (
  capability: CapabilityDescriptor,
  resource: ResourceDescriptor,
  availability: CapabilityAvailability,
): string[] => {
  const reasons: string[] = [];
  if (resource.active) {
    reasons.push('resource.active');
  }
  if (resource.providerIds.includes(capability.providerId)) {
    reasons.push('provider.resource_match');
  }
  if (availability !== 'available') {
    reasons.push(`availability.${availability}`);
  }
  return reasons;
};

export class BindingResolver {
  resolve(
    resources: ResourceDescriptor[],
    capabilities: CapabilityDescriptor[],
  ): CapabilityBinding[] {
    const byId = new Map(
      capabilities.map((capability) => [capability.id, capability]),
    );
    const bindings: CapabilityBinding[] = [];

    for (const resource of resources) {
      for (const capabilityId of resource.capabilities) {
        const capability = byId.get(capabilityId);
        if (!capability) {
          continue;
        }
        const availability = availabilityForResource(capability, resource);
        if (
          availability !== 'available' &&
          availability !== 'degraded' &&
          availability !== 'unknown'
        ) {
          continue;
        }
        bindings.push({
          id: `${resource.id}->${capabilityId}`,
          capabilityId,
          resourceId: resource.id,
          providerId: capability.providerId,
          method: capability.toolId,
          defaultArgs: defaultArgsFor(capabilityId, resource),
          availability,
          active: resource.active,
          reasons: resourceReason(capability, resource, availability),
          expiresAt: null,
        });
      }
    }

    return bindings.sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        left.capabilityId.localeCompare(right.capabilityId) ||
        left.id.localeCompare(right.id),
    );
  }
}

export const resourceHealthRank = (health: ResourceHealth): number => {
  if (health === 'available') return 3;
  if (health === 'degraded') return 2;
  if (health === 'unknown') return 1;
  return 0;
};
