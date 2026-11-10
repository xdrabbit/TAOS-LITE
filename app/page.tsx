import { AppShell } from "@/components/AppShell";
import { practicaConfigured } from "@/lib/practica/access";

export default function Home(): JSX.Element {
  return (
    <AppShell
      googleTtsEnabled={process.env.TAOS_TTS_GOOGLE_ENABLED === "1"}
      practicaEnabled={practicaConfigured()}
    />
  );
}
