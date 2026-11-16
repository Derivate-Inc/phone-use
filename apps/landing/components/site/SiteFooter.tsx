import Link from "next/link";
import Logo from "./Logo";

export default function SiteFooter({ home = "/" }: { home?: string }) {
  return (
    <footer className="site-footer">
      <div className="site-wrap site-footer-inner">
        <Link href={home} className="site-brand" aria-label="Phone Use home">
          <Logo />
          <span>phone-use</span>
        </Link>
        <div className="site-footer-end">
          <nav aria-label="Legal">
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </nav>
          <small>© 2026 Derivate, Inc.</small>
        </div>
      </div>
    </footer>
  );
}
