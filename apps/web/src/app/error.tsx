"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { useT } from "@/i18n/LanguageProvider";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="py-16 text-center">
      <p className="text-bone">{t("common.somethingWrong")}</p>
      <button className="btn-ghost mt-5" onClick={reset}>{t("common.tryAgain")}</button>
    </div>
  );
}
