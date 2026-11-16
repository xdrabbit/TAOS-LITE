import { AppShell } from "@/components/AppShell";
import { homeMaxTurnFreeMs, homeMaxTurnMs } from "@/lib/translate/longTurn";

export default function Home(): JSX.Element {
  // The home turn's caps are server envs read here and handed down, so
  // changing one is not a rebuild: TAOS_HOME_MAX_TURN_MS for paying users and
  // founders (ten minutes unset), TAOS_HOME_MAX_TURN_FREE_MS for everyone else
  // (five minutes unset). Which one applies is decided where the profile is —
  // TranslatorShell.
  const maxTurnMs = homeMaxTurnMs(process.env.TAOS_HOME_MAX_TURN_MS);
  return (
    <AppShell
      googleTtsEnabled={process.env.TAOS_TTS_GOOGLE_ENABLED === "1"}
      maxTurnMs={maxTurnMs}
      maxTurnFreeMs={homeMaxTurnFreeMs(process.env.TAOS_HOME_MAX_TURN_FREE_MS, maxTurnMs)}
    />
  );
}
