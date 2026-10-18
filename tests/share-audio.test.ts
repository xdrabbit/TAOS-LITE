// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  shareAudioFile,
  type ShareAudioEnvironment
} from "@/lib/tts/shareAudio";

function environment(canShare: boolean, shareError?: unknown) {
  const share = vi.fn(async (_data: ShareData) => {
    if (shareError) throw shareError;
  });
  const click = vi.fn();
  const remove = vi.fn();
  const anchor = { href: "", download: "", hidden: false, click, remove } as unknown as HTMLAnchorElement;
  const appendChild = vi.fn();
  const createObjectURL = vi.fn(() => "blob:taos-audio");
  const revokeObjectURL = vi.fn();
  const env: ShareAudioEnvironment = {
    navigator: {
      canShare: vi.fn(() => canShare),
      share
    },
    document: {
      body: { appendChild } as unknown as HTMLElement,
      createElement: vi.fn(() => anchor)
    },
    url: { createObjectURL, revokeObjectURL }
  };
  return { env, share, click, appendChild, createObjectURL, revokeObjectURL, anchor };
}

const audio = () => new Blob([new Uint8Array([0xff, 0xfb])], { type: "audio/mpeg" });
const options = { fileName: "TAOS · Spanish.mp3", title: "TAOS · Spanish" };

describe("shareAudioFile", () => {
  it("shares one audio File with the requested name and response MIME", async () => {
    const { env, share, click } = environment(true);

    await expect(shareAudioFile(audio(), options, env)).resolves.toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    const data = share.mock.calls[0][0] as ShareData;
    expect(data.title).toBe("TAOS · Spanish");
    expect(data.files).toHaveLength(1);
    expect(data.files?.[0]).toBeInstanceOf(File);
    expect(data.files?.[0].name).toBe("TAOS · Spanish.mp3");
    expect(data.files?.[0].type).toBe("audio/mpeg");
    expect(env.navigator.canShare).toHaveBeenCalledWith({ files: [data.files?.[0]] });
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads the same file when file sharing is unsupported", async () => {
    const { env, share, click, appendChild, createObjectURL, revokeObjectURL, anchor } =
      environment(false);

    await expect(shareAudioFile(audio(), options, env)).resolves.toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(File));
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.download).toBe("TAOS · Spanish.mp3");
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:taos-audio");
  });

  it("swallows AbortError without starting a download", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    const { env, click } = environment(true, abort);

    await expect(shareAudioFile(audio(), options, env)).resolves.toBe("cancelled");
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads when the browser loses the tap before opening its share sheet", async () => {
    const denied = new DOMException("Share must be triggered by user activation", "NotAllowedError");
    const { env, click, revokeObjectURL } = environment(true, denied);

    await expect(shareAudioFile(audio(), options, env)).resolves.toBe("downloaded");
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:taos-audio");
  });
});
