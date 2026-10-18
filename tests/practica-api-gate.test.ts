import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { guardSpend } = vi.hoisted(() => ({ guardSpend: vi.fn() }));

vi.mock("@/lib/spendGuard", () => ({ guardSpend }));

import { POST } from "@/app/api/practica/session/route";

const ORIGINAL = {
  enabled: process.env.TAOS_PRACTICA_ENABLED,
  key: process.env.ELEVENLABS_API_KEY,
  agent: process.env.ELEVENLABS_AGENT_ID,
  founders: process.env.NEXT_PUBLIC_FOUNDER_EMAILS
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function request(): NextRequest {
  return new NextRequest("https://taoslite.com/api/practica/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tripId: "llegada-a-utah", sceneIndex: 0 })
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TAOS_PRACTICA_FACE;
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_AGENT_ID = "agent-test";
  process.env.NEXT_PUBLIC_FOUNDER_EMAILS = "";
});

afterAll(() => {
  restore("TAOS_PRACTICA_ENABLED", ORIGINAL.enabled);
  restore("ELEVENLABS_API_KEY", ORIGINAL.key);
  restore("ELEVENLABS_AGENT_ID", ORIGINAL.agent);
  restore("NEXT_PUBLIC_FOUNDER_EMAILS", ORIGINAL.founders);
});

describe("POST /api/practica/session gate", () => {
  it("flag off returns not enabled before auth or ElevenLabs", async () => {
    delete process.env.TAOS_PRACTICA_ENABLED;
    const provider = vi.spyOn(globalThis, "fetch");

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_enabled" });
    expect(guardSpend).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    provider.mockRestore();
  });

  it("a signed-in non-founder returns not enabled without calling ElevenLabs", async () => {
    process.env.TAOS_PRACTICA_ENABLED = "1";
    guardSpend.mockResolvedValue({
      ok: true,
      anonymous: false,
      user: { id: "visitor", email: "visitor@example.com" }
    });
    const provider = vi.spyOn(globalThis, "fetch");

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_enabled" });
    expect(provider).not.toHaveBeenCalled();
    provider.mockRestore();
  });
});
