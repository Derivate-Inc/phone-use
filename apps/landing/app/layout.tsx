import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.phoneuse.dev"),
  title: "Phone Use · Cloud phones for AI agents",
  description:
    "One open-source CLI creates an iOS simulator or an Android emulator in the cloud. Your agent reads the screen as named elements and is told whether each action worked.",
  openGraph: {
    title: "Phone Use",
    description: "Cloud phones for AI agents.",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Phone Use",
    description: "Cloud phones for AI agents.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#fafafa",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
