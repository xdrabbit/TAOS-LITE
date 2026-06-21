import type { Metadata } from "next";
import "./globals.css";

const TITLE = "TAOS — Real-time translation & AI language tutor";
const DESCRIPTION =
  "Speak and be understood instantly, then learn the language with an AI tutor that talks back and fixes your pronunciation.";

export const metadata: Metadata = {
  metadataBase: new URL("https://taoslite.com"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "TAOS",
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://taoslite.com",
    siteName: "TAOS",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
