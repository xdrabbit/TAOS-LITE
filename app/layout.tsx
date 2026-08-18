import type { Metadata, Viewport } from "next";
import "./globals.css";

const TITLE = "TAOS — Real-time translation & AI language tutor";
const DESCRIPTION =
  "Speak and be understood instantly, then learn the language with an AI tutor that talks back and fixes your pronunciation.";

export const metadata: Metadata = {
  metadataBase: new URL("https://taoslite.com"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "TAOS",
  // Installed-app metadata. The manifest itself is app/manifest.ts, which Next
  // links automatically; these are the iOS-only bits Safari reads instead.
  appleWebApp: {
    capable: true, // emits apple-mobile-web-app-capable — no Safari chrome
    title: "TAOS", // the name under the home-screen icon
    // Translucent lets the page's own dark gradient run under the clock and
    // battery. The layouts below already pad with env(safe-area-inset-*), and
    // viewportFit: "cover" (below) is what makes those insets non-zero.
    statusBarStyle: "black-translucent"
  },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  },
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

// themeColor tints the iOS status bar / Android task switcher to the app's own
// background instead of white. viewportFit "cover" draws under the notch and
// home indicator, which is what activates the env(safe-area-inset-*) padding
// the screens already use — without it those insets are 0 in standalone mode
// and the header sits under the clock.
export const viewport: Viewport = {
  themeColor: "#120f0d",
  viewportFit: "cover"
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
