import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConsoleFixtures, type FixtureState } from "../../../components/console/Fixtures";

export const metadata: Metadata = { title: "Console fixtures", robots: { index: false, follow: false } };

const STATES: FixtureState[] = ["main", "waiting", "control", "android", "preparing", "failed", "armed", "closed", "empty", "keys", "fresh-key", "usage"];

// Every console state with static data, for screenshots and review:
// /dev/console?state=main|waiting|control|android|preparing|failed|armed|closed|empty|keys|fresh-key|usage&theme=light|dark
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const query = await searchParams;
  const state = STATES.find((s) => s === query.state) ?? "main";
  const theme = query.theme === "dark" ? "dark" : query.theme === "light" ? "light" : "system";
  return <ConsoleFixtures state={state} theme={theme} />;
}
