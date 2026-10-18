import { describe, expect, it } from "vitest";
import { selectFaceProvider } from "@/lib/practica/face";

describe("Practica face selection", () => {
  it("defaults every absent or unknown value to the silhouette", () => {
    expect(selectFaceProvider(undefined)).toBe("none");
    expect(selectFaceProvider("")).toBe("none");
    expect(selectFaceProvider("simli")).toBe("none");
  });

  it("selects the untested Anam provider only explicitly", () => {
    expect(selectFaceProvider("anam")).toBe("anam");
    expect(selectFaceProvider(" ANAM ")).toBe("anam");
  });
});
