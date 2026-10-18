import { describe, expect, it } from "vitest";
import { practicaConfigured, practicaEnabled, practicaVisibleTo } from "@/lib/practica/access";

describe("Practica fails closed", () => {
  it("is not enabled when the flag is off", () => {
    expect(practicaEnabled(undefined)).toBe(false);
    expect(practicaEnabled("0")).toBe(false);
    expect(practicaVisibleTo("xdrabbit@gmail.com", false)).toBe(false);
  });

  it("is not enabled for a non-founder even when the flag is on", () => {
    expect(practicaVisibleTo("visitor@example.com", true)).toBe(false);
    expect(practicaVisibleTo(null, true)).toBe(false);
  });

  it("requires the flag, API key, and agent id before the page opens", () => {
    expect(
      practicaConfigured({
        TAOS_PRACTICA_ENABLED: "1",
        ELEVENLABS_API_KEY: "key",
        ELEVENLABS_AGENT_ID: "agent"
      })
    ).toBe(true);
    expect(
      practicaConfigured({ TAOS_PRACTICA_ENABLED: "1", ELEVENLABS_API_KEY: "key" })
    ).toBe(false);
  });

  it("requires the Anam keys and an explicit ZDR confirmation when Anam is selected", () => {
    const base = {
      TAOS_PRACTICA_ENABLED: "1",
      ELEVENLABS_API_KEY: "key",
      ELEVENLABS_AGENT_ID: "agent",
      TAOS_PRACTICA_FACE: "anam"
    };
    expect(practicaConfigured(base)).toBe(false);
    expect(
      practicaConfigured({
        ...base,
        ANAM_API_KEY: "anam-key",
        ANAM_AVATAR_ID: "avatar",
        ANAM_ZERO_DATA_RETENTION_CONFIRMED: "1"
      })
    ).toBe(true);
  });
});
