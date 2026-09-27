"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "./WalletProvider";

const nav = [
  { href: "/explore", label: "Explore" },
  { href: "/launch", label: "Launch" },
  { href: "/market", label: "Market" },
  { href: "/activity", label: "Activity" },
  { href: "/wallet", label: "Wallet" },
];

export function Header() {
  const pathname = usePathname();
  const { connected, address, adapterId, connect, disconnect } = useWallet();

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-ink/95 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="group flex items-center gap-2.5">
          {/* A filled square, not a rounded app icon — the mark is a mark. */}
          <span className="h-3.5 w-3.5 bg-signal transition-colors group-hover:bg-[#F0A253]" />
          <span className="text-sm tracking-label text-bone">
            covs<span className="text-bone-dim">.trade</span>
          </span>
        </Link>

        <nav className="flex items-center gap-0.5">
          {nav.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "border-b-2 border-signal px-3 py-2 text-label uppercase tracking-label text-bone"
                    : "border-b-2 border-transparent px-3 py-2 text-label uppercase tracking-label text-bone-dim transition-colors hover:text-bone"
                }
              >
                {item.label}
              </Link>
            );
          })}

          {connected ? (
            <button
              onClick={disconnect}
              title={`${address} — click to disconnect`}
              className="group/w ml-3 hidden border border-rule px-2.5 py-1.5 text-label text-bone-dim transition-colors hover:border-rejected/40 hover:text-rejected sm:inline"
            >
              <span className="group-hover/w:hidden">
                {adapterId ? `${adapterId} · ` : ""}
                {address.slice(0, 6)}…{address.slice(-4)}
              </span>
              <span className="hidden group-hover/w:inline">Disconnect</span>
            </button>
          ) : (
            <button onClick={() => void connect()} className="btn ml-3 px-3 py-1.5 text-label">
              Connect
            </button>
          )}
        </nav>
      </div>
    </header>
  );
}
