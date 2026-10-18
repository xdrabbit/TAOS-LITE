import type { FaceHandle, FaceProvider } from "../face";

/**
 * UNTESTED: no Anam key/avatar exists yet.
 *
 * Anam's current documented ElevenLabs integration does not accept the SDK's
 * private audio element. The server places an ElevenLabs signed URL inside an
 * Anam session token; Anam then owns microphone capture and the synchronized
 * audio/video WebRTC session. `receiveAudio` remains on the common interface
 * so another passthrough vendor can consume a MediaStream without changing
 * the scene shell.
 */
export const anamFaceProvider: FaceProvider = {
  async start(opts): Promise<FaceHandle> {
    if (!opts.anamSessionToken) throw new Error("Anam session token is missing.");

    const video = document.createElement("video");
    video.id = `practica-anam-${crypto.randomUUID()}`;
    video.autoplay = true;
    video.playsInline = true;
    video.className = "h-full w-full rounded-full object-cover";
    opts.container.replaceChildren(video);

    const { AnamEvent, createClient } = await import("@anam-ai/js-sdk");
    const client = createClient(opts.anamSessionToken);
    client.addListener(AnamEvent.CONNECTION_CLOSED, () => opts.onDisconnect?.());
    client.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, (event) => {
      if (event.role === "persona" && event.content) opts.onAgentMessage?.(event.content);
    });
    await client.streamToVideoElement(video.id);

    return {
      receiveAudio() {
        // TODO(Anam verification): if Anam adds a browser audio-passthrough
        // input for an already-running ElevenLabs SDK session, attach it here.
        // Today the documented integration is the server-mediated path above.
      },
      async stop() {
        await client.stopStreaming();
        opts.container.replaceChildren();
      }
    };
  }
};
