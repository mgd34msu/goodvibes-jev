import { isIP } from 'node:net';
import type { RuntimeEndpointBinding } from './cli-endpoints.js';

export type BindPostureKind = 'local' | 'local-network' | 'custom-network';

export interface BindPosture {
  readonly kind: BindPostureKind;
  readonly label: string;
  readonly networkFacing: boolean;
}

/**
 * Whether a bind host is this machine only: the name localhost, an IPv4
 * address in 127.0.0.0/8, or the IPv6 loopback ::1 in any spelling
 * (including the IPv4-mapped ::ffff:127.x.y.z). The address is parsed rather
 * than prefix-matched, so a DNS name such as 127.example.com is not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost') return true;
  const family = isIP(normalized);
  if (family === 4) return normalized.split('.')[0] === '127';
  if (family !== 6) return false;
  const expanded = expandIpv6(normalized);
  if (expanded === null) return false;
  if (expanded.every((group, index) => group === (index === 7 ? 1 : 0))) return true;
  // ::ffff:a.b.c.d, an IPv4-mapped address: loopback when the IPv4 part is.
  const mapped = expanded.slice(0, 5).every((group) => group === 0) && expanded[5] === 0xffff;
  return mapped && expanded[6]! >> 8 === 127;
}

/** The eight 16-bit groups of an IPv6 address, or null when it cannot be read. */
function expandIpv6(address: string): number[] | null {
  let text = address;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const octets = tail[1]!.split('.').map(Number);
    text = `${text.slice(0, tail.index)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

export function classifyBindPosture(binding: Pick<RuntimeEndpointBinding, 'hostMode' | 'host'>): BindPosture {
  if (binding.hostMode === 'local' || isLoopbackHost(binding.host)) {
    return {
      kind: 'local',
      label: 'Local only',
      networkFacing: false,
    };
  }
  if (binding.hostMode === 'network' || binding.host === '0.0.0.0' || binding.host === '::') {
    return {
      kind: 'local-network',
      label: 'Local Network',
      networkFacing: true,
    };
  }
  return {
    kind: 'custom-network',
    label: 'Custom network',
    networkFacing: true,
  };
}

export function isNetworkFacing(
  enabled: unknown,
  binding: Pick<RuntimeEndpointBinding, 'hostMode' | 'host'>,
): boolean {
  return enabled === true && classifyBindPosture(binding).networkFacing;
}
