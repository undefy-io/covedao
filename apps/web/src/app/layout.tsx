import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { Header } from "@/components/Header";
import { StatusBar } from "@/components/StatusBar";
import { WalletProvider } from "@/components/WalletProvider";
import { WalletPicker } from "@/components/WalletPicker";
import { DevWallet } from "@/components/DevWallet";
import { LanguageProvider } from "@/i18n/LanguageProvider";
import { LANG_COOKIE, parseLang, translate, htmlLang } from "@/i18n";
import { protocolSurface } from "@/lib/protocol-surface";

/** The reader's language, from the cookie the language button sets. */
async function serverLang() {
  return parseLang((await cookies()).get(LANG_COOKIE)?.value);
}

export async function generateMetadata(): Promise<Metadata> {
  const lang = await serverLang();
  return { title: translate(lang, "meta.title"), description: translate(lang, "meta.description") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await serverLang();
  const protocolMode = protocolSurface(process.env.COVE_PROTOCOL_MODE);
  return (
    <html lang={htmlLang(lang)}>
      <body className="min-h-screen bg-bg text-bone antialiased">
        <LanguageProvider initial={lang}>
          <WalletProvider protocolMode={protocolMode}>
            {/* Installs nothing unless the regtest-only dev wallet is enabled. */}
            {protocolMode === "legacy" && <DevWallet />}
            <Header protocolMode={protocolMode} />
            <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-px sm:px-6">{children}</main>
            {protocolMode === "legacy" && <StatusBar />}
            <WalletPicker />
          </WalletProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
