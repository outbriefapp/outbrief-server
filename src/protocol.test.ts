import { describe, expect, it } from "vitest";
import { MAX_SEALED_CHARS, SettingsRelayInput } from "./protocol.ts";

describe("SettingsRelayInput", () => {
  const requestId = "0b6d8f0e-2f7a-4c55-9d62-3f1b7f0c9a11";
  const sealedOf = (chars: number) => `ob1.0123456789abcdef.AAAAAAAAAAAAAAAA.${"A".repeat(chars)}`;

  it("takes a dispatch image, far beyond a report's sealed size (YOUT-226)", () => {
    const sealed = sealedOf(MAX_SEALED_CHARS * 10);
    expect(SettingsRelayInput.safeParse({ requestId, sealed }).success).toBe(true);
  });

  it("still has a limit, and only takes sealed text", () => {
    expect(SettingsRelayInput.safeParse({ requestId, sealed: sealedOf(181_000_000) }).success).toBe(
      false,
    );
    expect(SettingsRelayInput.safeParse({ requestId, sealed: "plain text" }).success).toBe(false);
  });
});
