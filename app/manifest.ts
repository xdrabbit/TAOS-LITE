import type { MetadataRoute } from "next";

// Web app manifest — served at /manifest.webmanifest and linked automatically
// by Next's metadata system (no <link> needed in layout.tsx).
//
// This is what makes TAOS installable: "Add to Home Screen" gives a real app
// icon and a standalone window with no Safari chrome, which matters on a trip —
// the address bar and tab strip eat the vertical space the translation panel
// wants, and a home-screen tap beats typing a URL at a dinner table.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TAOS",
    short_name: "TAOS",
    description:
      "Speak and be understood instantly — live translation for the people in front of you.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    // Matches app/globals.css: --bg #120f0d, and the amber the UI is built on.
    background_color: "#120f0d",
    theme_color: "#120f0d",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Android/Chromium crops icons to the launcher's shape; the maskable one
      // keeps the glyph inside the safe zone so nothing gets shaved off.
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  };
}
