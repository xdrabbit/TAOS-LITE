"use client";

import type { SourceLanguageCode, SupportedLanguageCode } from "./languages";
import type { ConnectionState, RawRealtimeEvent, TranslationSessionPayload } from "./types";

interface CreateTranslationSessionArgs {
  realtimeModel?: string;
  sourceLanguage: SourceLanguageCode;
  targetLanguage: SupportedLanguageCode;
}

interface StartRealtimeSessionArgs extends CreateTranslationSessionArgs {
  onConnectionStateChange?: (state: ConnectionState) => void;
  onError?: (message: string) => void;
  onEvent?: (event: RawRealtimeEvent) => void;
}

export interface MicrophoneCapabilityState {
  hasGetUserMedia: boolean;
  hasMediaDevices: boolean;
  isBrowser: boolean;
  isSecureContext: boolean;
  isLikelyIOSSafari: boolean;
  userAgent: string;
}

export interface ActiveRealtimeSession {
  dc: RTCDataChannel;
  localStream: MediaStream;
  pc: RTCPeerConnection;
  session: TranslationSessionPayload;
  stop: () => Promise<void>;
}

export const MICROPHONE_UNAVAILABLE_MESSAGE =
  "Microphone capture is unavailable in this browser context. Use HTTPS, localhost, or a trusted secure tunnel for microphone access. On iPhone Safari, open the app directly in Safari instead of an embedded webview when possible, and confirm microphone permission when prompted.";

export function getMicrophoneCapabilityState(): MicrophoneCapabilityState {
  const isBrowser = typeof window !== "undefined" && typeof navigator !== "undefined";
  const userAgent = isBrowser ? navigator.userAgent : "";
  const hasMediaDevices = isBrowser && typeof navigator.mediaDevices !== "undefined";
  const hasGetUserMedia = hasMediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";
  const hasTouchDocument = typeof document !== "undefined" && "ontouchend" in document;
  const isLikelyIOS = /iPad|iPhone|iPod/.test(userAgent) || (userAgent.includes("Mac") && hasTouchDocument);
  const isLikelySafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(userAgent);

  return {
    hasGetUserMedia,
    hasMediaDevices,
    isBrowser,
    isSecureContext: isBrowser ? window.isSecureContext : false,
    isLikelyIOSSafari: isLikelyIOS && isLikelySafari,
    userAgent
  };
}

async function createTranslationSession(
  args: CreateTranslationSessionArgs
): Promise<TranslationSessionPayload> {
  const response = await fetch("/api/realtime/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof json.details === "string"
        ? `${json.error ?? "Failed to create translation session."} ${json.details}`
        : (json.error as string) ?? "Failed to create translation session."
    );
  }

  return json as unknown as TranslationSessionPayload;
}

export async function startRealtimeSession(
  args: StartRealtimeSessionArgs
): Promise<ActiveRealtimeSession> {
  const { onConnectionStateChange, onError, onEvent, realtimeModel, sourceLanguage, targetLanguage } =
    args;

  let localStream: MediaStream | null = null;
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;

  const cleanup = async () => {
    onConnectionStateChange?.("stopping");

    if (dc && dc.readyState !== "closed") {
      dc.close();
    }

    if (pc) {
      pc.getSenders().forEach((sender) => sender.track?.stop());
      pc.close();
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }

    onConnectionStateChange?.("idle");
  };

  try {
    const micCapability = getMicrophoneCapabilityState();
    if (!micCapability.isBrowser || !micCapability.isSecureContext || !micCapability.hasGetUserMedia) {
      throw new Error(MICROPHONE_UNAVAILABLE_MESSAGE);
    }

    onConnectionStateChange?.("requesting_mic");
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    onConnectionStateChange?.("requesting_session");
    const session = await createTranslationSession({ realtimeModel, sourceLanguage, targetLanguage });

    pc = new RTCPeerConnection();
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }

    pc.ontrack = ({ track }) => {
      // No audible output in TAOS-LITE. Stop translated audio tracks immediately.
      track.stop();
    };

    pc.onconnectionstatechange = () => {
      if (!pc) {
        return;
      }

      if (pc.connectionState === "connected") {
        onConnectionStateChange?.("connected");
      }

      if (pc.connectionState === "failed") {
        const message = "Realtime peer connection failed.";
        onConnectionStateChange?.("error");
        onError?.(message);
      }
    };

    dc = pc.createDataChannel("oai-events");
    dc.onmessage = ({ data }) => {
      try {
        onEvent?.(JSON.parse(String(data)) as RawRealtimeEvent);
      } catch {
        onEvent?.({
          type: "client.parse_error",
          message: "Failed to parse realtime event payload."
        });
      }
    };

    dc.onerror = () => {
      onError?.("Realtime data channel error.");
    };

    onConnectionStateChange?.("connecting");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch(session.callUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.clientSecret}`,
        "Content-Type": "application/sdp"
      },
      body: offer.sdp ?? ""
    });

    if (!sdpResponse.ok) {
      const details = await sdpResponse.text();
      throw new Error(`Realtime SDP exchange failed (${sdpResponse.status}): ${details}`);
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text()
    });

    return {
      dc,
      localStream,
      pc,
      session,
      stop: cleanup
    };
  } catch (error) {
    await cleanup();
    const message = error instanceof Error ? error.message : "Failed to start realtime session.";
    onConnectionStateChange?.("error");
    onError?.(message);
    throw error;
  }
}
