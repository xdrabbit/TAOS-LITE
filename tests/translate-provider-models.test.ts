import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptsTemperature, chatCompletion } from "@/lib/translateProvider";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function requestBody(model: string, jsonMode = false): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: jsonMode ? "{}" : "hola" } }] });
    })
  );
  await chatCompletion("test-key", {
    model,
    temperature: 0,
    jsonMode,
    messages: [{ role: "user", content: "hello" }]
  });
  return sent;
}

describe("model-specific chat request shape", () => {
  it("omits temperature for the gpt-5.6-luna /fast default", async () => {
    const body = await requestBody("gpt-5.6-luna", true);
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      response_format: { type: "json_object" }
    });
    expect(body).not.toHaveProperty("temperature");
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "response_format"]);
  });

  it("keeps the one-direction Luna path to model and messages only", async () => {
    const body = await requestBody("gpt-5.6-luna");
    expect(Object.keys(body).sort()).toEqual(["messages", "model"]);
  });

  it("keeps temperature for a legacy override that supports it", async () => {
    const body = await requestBody("gpt-4.1-mini");
    expect(body.temperature).toBe(0);
  });

  it("uses the existing reasoning-family rule for Luna and o-series models", () => {
    expect(acceptsTemperature("gpt-5.6-luna")).toBe(false);
    expect(acceptsTemperature("gpt-6-luna")).toBe(false);
    expect(acceptsTemperature("o3")).toBe(false);
    expect(acceptsTemperature("gpt-4.1-mini")).toBe(true);
  });
});
