export type FaceKind = "none" | "anam";

export interface AgentAudioSource {
  /** ElevenLabs exposes output level but not its internal audio element. */
  getLevel(): number;
}

export interface FaceStartOptions {
  container: HTMLElement;
  audio?: AgentAudioSource;
  /** Present only for Anam's server-side ElevenLabs integration. */
  anamSessionToken?: string;
  onDisconnect?: () => void;
  onAgentMessage?: (message: string) => void;
}

export interface FaceHandle {
  /** Attach or replace the agent-audio meter after the voice session starts. */
  receiveAudio(audio: AgentAudioSource): void;
  stop(): Promise<void>;
}

export interface FaceProvider {
  start(opts: FaceStartOptions): Promise<FaceHandle>;
}

export function selectFaceProvider(raw: string | null | undefined): FaceKind {
  return raw?.trim().toLowerCase() === "anam" ? "anam" : "none";
}

export async function faceProvider(kind: FaceKind): Promise<FaceProvider> {
  if (kind === "anam") {
    const { anamFaceProvider } = await import("./faces/anam");
    return anamFaceProvider;
  }
  const { noneFaceProvider } = await import("./faces/none");
  return noneFaceProvider;
}
