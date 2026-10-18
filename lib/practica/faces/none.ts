import type { AgentAudioSource, FaceHandle, FaceProvider } from "../face";

function silhouette(): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("aria-label", "Liz audio guide");
  el.className =
    "relative grid h-full w-full place-items-center overflow-hidden rounded-full bg-gradient-to-b from-amber-100/20 to-stone-950/80 text-amber-100";
  el.innerHTML =
    '<span aria-hidden="true" class="text-6xl opacity-70">●</span><span aria-hidden="true" class="absolute bottom-[-22%] h-[58%] w-[78%] rounded-[50%] bg-amber-100/35"></span>';
  return el;
}

export const noneFaceProvider: FaceProvider = {
  async start(opts): Promise<FaceHandle> {
    const frame = silhouette();
    opts.container.replaceChildren(frame);
    let audio: AgentAudioSource | undefined = opts.audio;
    let raf = 0;

    const tick = () => {
      const level = Math.max(0, Math.min(1, audio?.getLevel() ?? 0));
      frame.style.boxShadow = `0 0 0 ${4 + level * 11}px rgba(251,191,36,${0.2 + level * 0.65})`;
      frame.style.transform = `scale(${1 + level * 0.025})`;
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);

    return {
      receiveAudio(next) {
        audio = next;
      },
      async stop() {
        window.cancelAnimationFrame(raf);
        opts.container.replaceChildren();
      }
    };
  }
};
