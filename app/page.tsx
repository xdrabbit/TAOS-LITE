import { AppShell } from "@/components/AppShell";
import { homeMaxTurnMs } from "@/lib/translate/longTurn";

export default function Home(): JSX.Element {
  // The home turn's cap is a server env (TAOS_HOME_MAX_TURN_MS, ten minutes
  // unset) read here and handed down, so changing it is not a rebuild.
  return (
    <AppShell
      googleTtsEnabled={process.env.TAOS_TTS_GOOGLE_ENABLED === "1"}
      maxTurnMs={homeMaxTurnMs(process.env.TAOS_HOME_MAX_TURN_MS)}
    />
  );
}
