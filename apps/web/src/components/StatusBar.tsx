"use client";

import { useChainStatus } from "@/lib/use-indexed-block";
import { useLang, useT } from "@/i18n/LanguageProvider";
import { isMessageKey } from "@/i18n";

export function StatusBar() {
  const status = useChainStatus();
  const t = useT();
  const { lang } = useLang();

  // The docs ship both languages; open the one the reader is using.
  const docsHref = lang === "zh" ? "/docs/zh-Hans/index.html" : "/docs/index.html";
  // Links first, so they show on every page even before the status loads or
  // when the chain is unreachable.
  const links = (
    <span className="ml-auto flex items-center gap-4">
      <a href={docsHref} className="text-bone-dim underline-offset-2 hover:text-signal hover:underline">
        {t("footer.docs")}
      </a>
      <a
        href="https://x.com/covstrade"
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("footer.xLabel")}
        title={t("footer.xLabel")}
        className="text-bone-dim hover:text-signal"
      >
        <XMark />
      </a>
      <a
        href="https://t.me/covstrade"
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t("footer.tgLabel")}
        title={t("footer.tgLabel")}
        className="text-bone-dim hover:text-signal"
      >
        <TelegramMark />
      </a>
    </span>
  );

  if (!status) {
    return (
      <footer className="border-t border-rule bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-xs text-bone-dim sm:px-6">
          {links}
        </div>
      </footer>
    );
  }

  const healthy = status.indexer.health === "HEALTHY";
  const coreOk = status.core.reachable;
  const healthKey = `health.${status.indexer.health.toLowerCase()}`;
  const health = isMessageKey(healthKey) ? t(healthKey) : status.indexer.health.toLowerCase();

  return (
    <footer className="border-t border-rule bg-bg/90 backdrop-blur" aria-live="polite">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-xs text-bone-dim sm:px-6">
        <span className="flex items-center gap-1.5">
          <Dot color={coreOk ? "bg-success" : "bg-danger"} /> {t("footer.core")} ·{" "}
          {coreOk ? t("footer.height", { height: status.core.height }) : t("footer.unavailable")}
        </span>
        <span className="flex items-center gap-1.5">
          <Dot color={healthy ? "bg-success" : "bg-danger"} /> {t("footer.indexer")} · {health}
          {status.indexer.lag !== "0" ? ` ${t("footer.lag", { lag: status.indexer.lag })}` : ""}
        </span>
        <span className="hidden items-center gap-1.5 sm:flex">
          <Dot color={status.guardian.configured ? "bg-success" : "bg-warning"} /> {t("footer.guardian")} ·{" "}
          {status.guardian.configured ? t("footer.available") : t("footer.notConfigured")}
        </span>
        {links}
        <span className="flex items-center gap-1.5">
          {status.market.enabled ? <Dot color="bg-success" /> : <Dot color="bg-gray-500" />} {t("footer.market")}{" "}
          {status.market.enabled ? t("footer.enabled") : t("footer.disabled")}
          <span className="text-bone-dim">· {status.network}</span>
        </span>
      </div>
    </footer>
  );
}

/** The X logo. */
function XMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** The Telegram paper plane. */
function TelegramMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}

function Dot({ color }: { color: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-hidden />;
}
