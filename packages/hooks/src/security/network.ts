import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { HookSecurityError } from "../errors.js";

export interface HookResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HookDnsResolver = (hostname: string) => Promise<readonly HookResolvedAddress[]>;

const BLOCKED_ADDRESSES = createBlockedAddresses();

export async function resolvePublicHookAddresses(
  hostname: string,
  resolver: HookDnsResolver = defaultResolver,
): Promise<readonly HookResolvedAddress[]> {
  const normalized = hostname.trim().toLowerCase();

  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost")) {
    throw networkError("Hook HTTP hostname is not public.");
  }

  const literalFamily = isIP(normalized);
  const addresses =
    literalFamily === 0
      ? await resolver(normalized)
      : [{ address: normalized, family: literalFamily as 4 | 6 }];

  if (addresses.length === 0) {
    throw networkError("Hook HTTP hostname did not resolve to an address.");
  }

  const unique = new Map<string, HookResolvedAddress>();
  for (const address of addresses) {
    assertPublicHookAddress(address);
    unique.set(`${address.family}:${address.address}`, Object.freeze({ ...address }));
  }

  return Object.freeze([...unique.values()]);
}

export function assertPublicHookAddress(address: HookResolvedAddress): void {
  const detectedFamily = isIP(address.address);

  if (detectedFamily !== address.family || address.address.toLowerCase().startsWith("::ffff:")) {
    throw networkError("Hook HTTP resolver returned an invalid address family.");
  }

  const family = address.family === 4 ? "ipv4" : "ipv6";
  if (BLOCKED_ADDRESSES.check(address.address, family)) {
    throw networkError("Hook HTTP target resolves to a blocked network.");
  }
}

async function defaultResolver(hostname: string): Promise<readonly HookResolvedAddress[]> {
  const addresses = await lookup(hostname, {
    all: true,
    verbatim: true,
  });

  return addresses.map((address) => ({
    address: address.address,
    family: requireAddressFamily(address.family),
  }));
}

function createBlockedAddresses(): BlockList {
  const blockList = new BlockList();
  const ipv4Subnets: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  const ipv6Subnets: ReadonlyArray<readonly [string, number]> = [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32],
  ];

  for (const [network, prefix] of ipv4Subnets) {
    blockList.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of ipv6Subnets) {
    blockList.addSubnet(network, prefix, "ipv6");
  }

  return blockList;
}

function requireAddressFamily(family: number): 4 | 6 {
  if (family !== 4 && family !== 6) {
    throw networkError("Hook HTTP resolver returned an invalid address family.");
  }

  return family;
}

function networkError(message: string): HookSecurityError {
  return new HookSecurityError("HOOK_SECURITY_REJECTED", message, {
    executorType: "http",
  });
}
