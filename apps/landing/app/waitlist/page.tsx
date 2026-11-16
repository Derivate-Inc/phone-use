import type { Metadata } from "next";
import Link from "next/link";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import WaitlistForm from "@/components/site/WaitlistForm";
import "@/components/site/site.css";
import { fontVariables } from "../fonts";
import "./waitlist.css";

export const metadata: Metadata = {
  title: "Cloud phone waitlist · Phone Use",
  description:
    "Phone Use is free on your own machine. Cloud phones are on a waitlist: tell us what you would use one for.",
};

// The stable link `phone-use create` gives people: https://phoneuse.dev/waitlist
export default function Waitlist() {
  return (
    <div className={`site waitlist-page ${fontVariables}`}>
      <SiteNav />
      <main className="waitlist">
        <h1>Cloud phones are on a waitlist</h1>
        <p className="waitlist-lede">
          Phone Use is free on your own machine. It drives the iOS Simulator on your Mac, or an Android
          device or emulator over adb, and needs no account.{" "}
          <Link href="/docs/quickstart">Start with the local simulator</Link>.
        </p>
        <p className="waitlist-lede">
          Cloud phones run on our hardware and there are only a few of them. Tell us what you would use
          one for, and we will email you when there is one for you.
        </p>
        <WaitlistForm />
        <p className="waitlist-note">
          We keep your email and your answer, and use them only for this waitlist. See the{" "}
          <Link href="/privacy">privacy policy</Link>.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
