import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TAOS-LITE",
  description: "Minimal iPhone-tabletop realtime translator built for low-latency text display."
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
