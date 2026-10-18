import { AppShell } from "@/components/AppShell";
import { practicaConfigured } from "@/lib/practica/access";

export default function Home(): JSX.Element {
  return <AppShell practicaEnabled={practicaConfigured()} />;
}
