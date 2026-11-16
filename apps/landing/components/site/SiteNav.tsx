import Link from "next/link";
import Logo from "./Logo";

export const GITHUB_URL = "https://github.com/Derivate-Inc/phone-use";

type Section = "docs" | "benchmark";

// The one navigation bar, sticky, on every page. It links to the docs and the
// source; the benchmark page and the console are reached from the page itself.
export default function SiteNav({ current, home = "/" }: { current?: Section; home?: string }) {
  return (
    <header className="site-nav">
      <div className="site-wrap site-nav-inner">
        <Link href={home} className="site-brand" aria-label="Phone Use home">
          <Logo />
          <span>phone-use</span>
        </Link>
        <nav className="site-nav-links" aria-label="Main">
          <Link href="/docs" aria-current={current === "docs" ? "page" : undefined}>
            Docs
          </Link>
          <a href={GITHUB_URL}>GitHub</a>
        </nav>
        <div className="site-nav-end">
          {/* Getting started needs no account: it is the local quick start. */}
          <Link href="/docs/quickstart" className="site-btn site-btn-sm">
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
