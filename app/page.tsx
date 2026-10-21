import { AppShell } from "@/components/AppShell";

export default function Home(): JSX.Element {
  return <AppShell googleTtsEnabled={process.env.TAOS_TTS_GOOGLE_ENABLED === "1"} />;
}
