// The viewfinder mark: two corner brackets and a diamond, from app/icon.svg
export default function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
      <path d="M14 32V17.5A3.5 3.5 0 0 1 17.5 14H32" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="square" strokeLinejoin="round" />
      <path d="M50 32v14.5a3.5 3.5 0 0 1-3.5 3.5H32" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="square" strokeLinejoin="round" />
      <rect x="28" y="28" width="8" height="8" rx="1" transform="rotate(45 32 32)" fill="currentColor" />
    </svg>
  );
}
