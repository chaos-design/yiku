import { describe, expect, it } from "vitest";
import { HookSecurityError } from "../../src/errors.js";
import {
  assertPublicHookAddress,
  type HookDnsResolver,
  resolvePublicHookAddresses,
} from "../../src/security/network.js";

describe("Hook HTTP network policy", () => {
  it("accepts and deduplicates public IPv4 and IPv6 addresses", async () => {
    const resolver: HookDnsResolver = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];

    await expect(resolvePublicHookAddresses("example.test", resolver)).resolves.toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("rejects localhost, private, link-local, reserved, multicast, and mixed DNS", async () => {
    await expect(resolvePublicHookAddresses("localhost", async () => [])).rejects.toBeInstanceOf(
      HookSecurityError,
    );

    for (const address of [
      { address: "10.0.0.1", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
      { address: "169.254.1.1", family: 4 as const },
      { address: "192.168.1.1", family: 4 as const },
      { address: "203.0.113.1", family: 4 as const },
      { address: "224.0.0.1", family: 4 as const },
      { address: "::1", family: 6 as const },
      { address: "fc00::1", family: 6 as const },
      { address: "fe80::1", family: 6 as const },
      { address: "ff00::1", family: 6 as const },
      { address: "2001:db8::1", family: 6 as const },
    ]) {
      expect(() => assertPublicHookAddress(address)).toThrow("blocked network");
    }

    await expect(
      resolvePublicHookAddresses("mixed.example", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("blocked network");
  });

  it("rejects empty DNS results and invalid address families", async () => {
    await expect(resolvePublicHookAddresses("empty.example", async () => [])).rejects.toThrow(
      "did not resolve",
    );
    expect(() => assertPublicHookAddress({ address: "8.8.8.8", family: 6 })).toThrow(
      "invalid address family",
    );
  });

  it("handles literal public addresses and rejects hostname and mapped-address variants", async () => {
    await expect(resolvePublicHookAddresses("8.8.4.4")).resolves.toEqual([
      { address: "8.8.4.4", family: 4 },
    ]);
    await expect(resolvePublicHookAddresses("2606:4700:4700::1001")).resolves.toEqual([
      { address: "2606:4700:4700::1001", family: 6 },
    ]);
    await expect(resolvePublicHookAddresses(" ")).rejects.toThrow("not public");
    await expect(resolvePublicHookAddresses("service.localhost")).rejects.toThrow("not public");
    expect(() => assertPublicHookAddress({ address: "::ffff:8.8.8.8", family: 6 })).toThrow(
      "invalid address family",
    );
  });
});
