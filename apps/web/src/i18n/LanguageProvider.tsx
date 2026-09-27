"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LANG_COOKIE, parseLang, setCurrentLang, translate, htmlLang, type Lang, type MessageKey, type Vars } from "./index";

interface LanguageContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/**
 * The reader's language. The server layout reads the cookie and passes it in
 * as `initial`, so the first paint is already in the right language; `?lang=zh`
 * (or `?lang=en`) switches it and is remembered.
 */
export function LanguageProvider({ initial, children }: { initial: Lang; children: React.ReactNode }) {
  const router = useRouter();
  const [lang, setLangState] = useState<Lang>(initial);
  setCurrentLang(lang);

  const setLang = useCallback(
    (next: Lang) => {
      setCurrentLang(next);
      setLangState(next);
      try {
        window.localStorage.setItem(LANG_COOKIE, next);
      } catch {
        /* storage blocked: the cookie still carries it */
      }
      document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      document.documentElement.lang = htmlLang(next);
      // Server-rendered parts (page title, <html lang>) follow on refresh.
      router.refresh();
    },
    [router],
  );

  // `?lang=` wins; otherwise a choice stored before the cookie existed.
  useEffect(() => {
    let wanted: Lang | null = null;
    try {
      const q = new URL(window.location.href).searchParams.get("lang");
      if (q) wanted = parseLang(q);
      else {
        const stored = window.localStorage.getItem(LANG_COOKIE);
        if (stored && parseLang(stored) !== initial) wanted = parseLang(stored);
      }
    } catch {
      /* no URL or storage: keep the server's choice */
    }
    if (wanted && wanted !== lang) setLang(wanted);
    // Only on first load.
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }),
    [lang, setLang],
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

function useLanguageContext(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (ctx) return ctx;
  // Outside the provider (isolated tests): English, and switching is a no-op.
  return { lang: "en", setLang: () => undefined, t: (key, vars) => translate("en", key, vars) };
}

/** `const t = useT(); t("nav.explore")` */
export function useT(): LanguageContextValue["t"] {
  return useLanguageContext().t;
}

/** The current language and a setter (for the language button). */
export function useLang(): { lang: Lang; setLang: (lang: Lang) => void } {
  const { lang, setLang } = useLanguageContext();
  return { lang, setLang };
}
