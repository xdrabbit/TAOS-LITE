// @vitest-environment jsdom
//
// The /call page gate, rendered, for the people the browser cannot recognise.
//
// CALL_ALLOWLIST_EMAILS is server-only (lib/release.ts), so an outside test
// pair's browser has no way to know its owner is allowed. FounderGate asks
// /api/call/access instead. What this file pins is the behaviour around that
// question, not the question: founders never wait on it, a "no" or a network
// failure bounces home (fail closed), and — the one that would hurt on a real
// call — Supabase's hourly token refresh does not re-ask and unmount a /call
// that is mid-conversation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

type Listener = (event: string, session: unknown) => void;
let currentSession: unknown = null;
let listener: Listener | null = null;
const replace = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: currentSession } }),
      onAuthStateChange: (cb: Listener) => {
        listener = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      }
    }
  }
}));

function session(email: string, token = "tok-1", id = "user-1") {
  return { access_token: token, user: { id, email } };
}

const fetchSpy = vi.fn();
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  currentSession = null;
  listener = null;
  replace.mockClear();
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});

async function renderGate(props: Record<string, unknown>) {
  const { FounderGate } = await import("@/components/FounderGate");
  return render(
    createElement(FounderGate, props as never, createElement("div", null, "CALL SCREEN"))
  );
}

describe("FounderGate with accessCheck (the /call page)", () => {
  it("lets a founder straight in without asking the server", async () => {
    currentSession = session("xdrabbit@gmail.com");
    await renderGate({ deny: "home", accessCheck: "/api/call/access" });
    expect(await screen.findByText("CALL SCREEN")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets a listed test pair in when the server says 204, sending the token", async () => {
    currentSession = session("ana@example.com");
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await renderGate({ deny: "home", accessCheck: "/api/call/access" });
    expect(await screen.findByText("CALL SCREEN")).toBeTruthy();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/call/access");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("bounces an unlisted person home on a 404", async () => {
    currentSession = session("customer@example.com");
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    await renderGate({ deny: "home", accessCheck: "/api/call/access" });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("CALL SCREEN")).toBeNull();
  });

  it("FAILS CLOSED when the check cannot be reached", async () => {
    currentSession = session("ana@example.com");
    fetchSpy.mockRejectedValue(new TypeError("Load failed"));
    await renderGate({ deny: "home", accessCheck: "/api/call/access" });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByText("CALL SCREEN")).toBeNull();
  });

  it("does not bounce while the server is still answering", async () => {
    currentSession = session("ana@example.com");
    let answer: (r: Response) => void = () => {};
    fetchSpy.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));
    await renderGate({ deny: "home", accessCheck: "/api/call/access" });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Loading…")).toBeTruthy();
    await act(async () => answer(new Response(null, { status: 204 })));
    expect(await screen.findByText("CALL SCREEN")).toBeTruthy();
  });

  it("signed out: bounced, and the server is never asked", async () => {
    await renderGate({ deny: "home", accessCheck: "/api/call/access" });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a token refresh mid-call neither re-asks nor unmounts the call", async () => {
    currentSession = session("ana@example.com", "tok-1");
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await renderGate({ deny: "home", accessCheck: "/api/call/access" });
    expect(await screen.findByText("CALL SCREEN")).toBeTruthy();
    const asked = fetchSpy.mock.calls.length;

    await act(async () => listener?.("TOKEN_REFRESHED", session("ana@example.com", "tok-2")));
    expect(screen.getByText("CALL SCREEN")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(fetchSpy.mock.calls.length).toBe(asked);
  });
});

describe("FounderGate without accessCheck (/video, /fast) is unchanged", () => {
  it("never asks the server, and a non-founder gets the card", async () => {
    currentSession = session("ana@example.com");
    await renderGate({});
    expect(await screen.findByText("Coming soon · Próximamente")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
