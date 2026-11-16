import localFont from "next/font/local";

// Geist and Geist Mono (SIL OFL), self-hosted. Every page sets both variables
// on its .site root; components read --site-sans and --site-mono.
export const geistSans = localFont({ src: "./fonts/Geist-Variable.woff2", variable: "--site-sans", weight: "100 900", display: "swap" });
export const geistMono = localFont({ src: "./fonts/GeistMono-Variable.woff2", variable: "--site-mono", weight: "100 900", display: "swap" });

export const fontVariables = `${geistSans.variable} ${geistMono.variable}`;
