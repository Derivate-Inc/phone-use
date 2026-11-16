import type { Metadata } from "next";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import "@/components/site/site.css";
import { fontVariables } from "../fonts";
import "../legal.css";

export const metadata: Metadata = {
  title: "Terms of Service · Phone Use",
  description: "Terms of service for the phone-use cloud.",
};

export default function Terms() {
  return (
    <div className={`site legal-page ${fontVariables}`}>
      <SiteNav />
    <main className="legal">
      <h1>Terms of Service</h1>
      <p className="legal-updated">Last updated: November 3, 2026</p>

      <h2>The service</h2>
      <p>
        Phone Use provides cloud-hosted iOS simulators and Android emulators (“phones”) that you
        and your software agents can create, drive, and observe through our console, CLI, SDK, and
        API. Phones are
        ephemeral: each one expires on a timer, and its session credentials die when it closes.
      </p>

      <h2>Your account</h2>
      <p>
        You are responsible for activity under your account and API keys. Keys are shown once and
        stored hashed; treat them like passwords. We may apply fair-use limits (concurrent phones,
        request rates) to keep the service healthy for everyone.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Don’t use phones to break the law, to attack or defraud others, to violate third-party
        terms (including Apple’s and Google’s), to send spam, or to attempt to escape or abuse the underlying
        infrastructure. We may suspend accounts that do.
      </p>

      <h2>Billing</h2>
      <p>
        Usage is metered per minute of running phone. During the current early-access period the
        service is offered without charge; if that changes we’ll tell you before you owe anything.
      </p>

      <h2>No warranty</h2>
      <p>
        The service is provided “as is”, without warranties of any kind. Phones are simulated
        environments and may be reset, interrupted, or discontinued. To the maximum extent
        permitted by law, our liability for any claim is limited to the amount you paid us in the
        three months before the claim arose.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms; material changes will be announced on this page with a new
        date. Continuing to use the service after a change means you accept it.
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <a href="mailto:support@phoneuse.dev">support@phoneuse.dev</a>
      </p>
    </main>
      <SiteFooter />
    </div>
  );
}
