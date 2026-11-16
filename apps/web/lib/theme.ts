"use client";
import { useEffect, useState } from "react";

// Light by default; dark on request or when the system asks for it. The choice
// lives on <html data-theme>, set before paint by the inline script in
// app/layout.tsx so a dark-theme user never sees a white flash.

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "phone-use-theme";

export const themeBootScript = `(function(){try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

export function useTheme(): [ThemeChoice, (next: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") setChoice(saved);
    } catch {
      /* storage blocked: stay on system */
    }
  }, []);
  const apply = (next: ThemeChoice) => {
    setChoice(next);
    const root = document.documentElement;
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage blocked: the choice still holds for this page */
    }
  };
  return [choice, apply];
}
