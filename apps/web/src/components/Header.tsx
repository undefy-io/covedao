"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWallet } from "./WalletProvider";
import { useLang, useT } from "@/i18n/LanguageProvider";
import type { MessageKey } from "@/i18n";

const nav: { href: string; label: MessageKey }[] = [
  { href: "/explore", label: "nav.explore" },
  { href: "/launch", label: "nav.launch" },
  { href: "/market", label: "nav.market" },
  { href: "/activity", label: "nav.activity" },
  { href: "/wallet", label: "nav.wallet" },
];

export function Header({ protocolMode = "legacy" }: { protocolMode?: "legacy" | "crc-read-only" }) {
  const pathname = usePathname();
  const { connected, address, adapterId, connect, disconnect } = useWallet();
  const t = useT();
  const { lang, setLang } = useLang();
  const links = protocolMode === "legacy" ? nav : [
    { href: "/", label: "nav.explore" as MessageKey },
    { href: "/crc/launch", label: "nav.launch" as MessageKey },
    { href: "/crc/wallet", label: "nav.wallet" as MessageKey },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-ink/95 backdrop-blur">
      {/* Phones: logo and buttons on top, the page links on a second row. */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-y-1 px-4 pt-2 sm:h-14 sm:flex-nowrap sm:px-6 sm:pt-0">
        <Link href="/" aria-label={t("nav.home")} className="group flex items-center gap-2.5">
          <Image src="/logo.png" alt="covs" width={24} height={24} priority className="h-6 w-6 transition-transform group-hover:rotate-[-8deg]" />
          <span className="text-sm tracking-label text-bone">
            covs<span className="text-bone-dim">.trade</span>
          </span>
        </Link>

        <div className="flex items-center sm:order-last">
          {connected ? (
            <button
              onClick={disconnect}
              title={t("nav.disconnectTitle", { address })}
              className="group/w ml-3 hidden border border-rule px-2.5 py-1.5 text-label text-bone-dim transition-colors hover:border-rejected/40 hover:text-rejected sm:inline"
            >
              <span className="group-hover/w:hidden">
                {adapterId ? `${adapterId} · ` : ""}
                {address.slice(0, 6)}…{address.slice(-4)}
              </span>
              <span className="hidden group-hover/w:inline">{t("nav.disconnect")}</span>
            </button>
          ) : (
            <button onClick={() => void connect()} className="btn ml-3 px-3 py-1.5 text-label">
              {t("nav.connect")}
            </button>
          )}

          {/* EN / 中文: always visible, phones included. */}
          <button
            type="button"
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            aria-label={t("lang.switchLabel")}
            className="ml-2 border border-rule px-2 py-1.5 text-label text-bone-dim transition-colors hover:border-signal hover:text-signal"
          >
            {t("lang.switchTo")}
          </button>
        </div>

        <nav className="order-last -mx-2 flex w-full items-center gap-0.5 overflow-x-auto sm:order-none sm:mx-0 sm:ml-auto sm:w-auto sm:overflow-visible">
          {links.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "shrink-0 border-b-2 border-signal px-2 py-2 text-label uppercase tracking-label text-bone sm:px-3"
                    : "shrink-0 border-b-2 border-transparent px-2 py-2 text-label uppercase tracking-label text-bone-dim transition-colors hover:text-bone sm:px-3"
                }
              >
                {t(item.label)}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
