import { AtomShell } from "@/components/AtomShell";

export const metadata = {
  title: "TAOS·ATOM — free translator",
  description: "A free, no-sign-up live translator. Hand it to a friend and talk."
};

// Anonymous, no auth gate — this is the free funnel into TAOS-LITE.
export default function TryPage(): JSX.Element {
  return <AtomShell />;
}
