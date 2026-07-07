import type { Metadata } from "next";
import "./globals.css";

const TITLE = "TAOS — Real-time translation & AI language tutor";
const DESCRIPTION =
  "Speak and be understood instantly, then learn the language with an AI tutor that talks back and fixes your pronunciation.";

// Resolve the site origin for metadata (og:url, OG-image resolution) from the
// CURRENT deployment instead of hardcoding production. A preview/branch build
// otherwise advertises the production domain in its social + canonical tags.
// This is metadata only — every in-app link is relative, so navigation always
// stays on whatever host is serving the page (preview alias, prod, custom domain).
function siteOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.startsWith("http") ? explicit : `https://${explicit}`;
  // Vercel system env: production → the project's production domain; preview →
  // this deploy's branch/deploy URL, so nothing points back at prod.
  const host =
    process.env.VERCEL_ENV === "production"
      ? process.env.VERCEL_PROJECT_PRODUCTION_URL
      : process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
  if (host) return `https://${host}`;
  return "https://taoslite.com"; // local/dev fallback
}

const SITE_ORIGIN = siteOrigin();

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "TAOS",
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_ORIGIN,
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
