import type { Metadata } from "next";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import "@/components/site/site.css";
import { fontVariables } from "../fonts";
import "../legal.css";

export const metadata: Metadata = {
  title: "Privacy Policy · Phone Use",
  description: "Privacy policy for the phone-use cloud.",
};

export default function Privacy() {
  return (
    <div className={`site legal-page ${fontVariables}`}>
      <SiteNav />
    <main className="legal">
      <h1>Privacy Policy</h1>

      <h2>What we collect</h2>
      <p>
        Account data: your email, name, and — if you sign in with Google — the basic profile
        Google shares (email, name). Usage data: phones you create, session durations, and API
        request logs (with request IDs and IP addresses) kept for operating and securing the
        service.
      </p>

      <h2>What happens on a phone</h2>
      <p>
        Phones are ephemeral simulated devices. Whatever you or your agent does on a phone —
        screenshots, streams, typed input — passes through our infrastructure to serve your
        session and its live view. We don’t sell it, mine it, or use it to train models. When a
        phone closes, its device state is destroyed.
      </p>

      <h2>Services we rely on</h2>
      <p>
        Railway (API hosting), Vercel (web hosting), Scaleway (device hosts and backups), Resend
        (transactional email), and Google (optional sign-in). Each receives only what it needs to
        do its job.
      </p>

      <h2>Your choices</h2>
      <p>
        You can rotate your API key at any time, close phones early, or delete your account by
        emailing us — we’ll remove your account data within 30 days, except minimal records we
        must keep for security or legal reasons.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions: <a href="mailto:support@phoneuse.dev">support@phoneuse.dev</a>
      </p>
    </main>
      <SiteFooter />
    </div>
  );
}
