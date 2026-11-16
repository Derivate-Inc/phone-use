import Link from "next/link";
import Logo from "./Logo";

export const APP_URL = "https://app.phoneuse.dev";
export const GITHUB_URL = "https://github.com/Derivate-Inc/phone-use";

type Section = "docs" | "benchmark";

// The one navigation bar, sticky, on every page
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
          <Link href="/benchmark" aria-current={current === "benchmark" ? "page" : undefined}>
            Benchmark
          </Link>
          <a href={GITHUB_URL}>GitHub</a>
        </nav>
        <div className="site-nav-end">
          <a href={APP_URL} className="site-nav-signin">
            Sign in
          </a>
          <a href={APP_URL} className="site-btn site-btn-sm">
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}
