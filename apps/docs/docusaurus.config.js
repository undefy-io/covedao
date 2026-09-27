// @ts-check
/** covs.trade documentation. Five pages; the docs are the whole site. */

// GitHub Pages serves the site under /covedao/. Override for a custom domain.
const url = process.env.DOCS_URL ?? "https://undefy-io.github.io";
const baseUrl = process.env.DOCS_BASE_URL ?? "/covedao/";

// DOCS_HASH_ROUTER=1 builds a portable copy (hash URLs, relative assets)
// that works from any host or folder.
const portable = process.env.DOCS_HASH_ROUTER === "1";

// A portable build holds one language (DOCS_LOCALE), because the hash router
// cannot switch locales inside one build: the app serves English at /docs/
// and Chinese at /docs/zh-Hans/. The normal build has both, and Docusaurus
// loads this file once per locale and says which one.
const onlyLocale = portable ? (process.env.DOCS_LOCALE ?? "en") : null;
const zh = (onlyLocale ?? process.env.DOCUSAURUS_CURRENT_LOCALE) === "zh-Hans";
const localeConfigs = {
  en: { label: "English", htmlLang: "en" },
  "zh-Hans": { label: "中文", htmlLang: "zh-CN" },
};
// Where the app serves each portable build.
const appDocs = process.env.DOCS_APP_PATH ?? "/docs";

// Social links with inline logos, so they need no image request.
const social = (href, label, path) =>
  `<a class="footer__link-item" href="${href}" target="_blank" rel="noopener noreferrer" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg></a>`;
const socialLinks =
  `<span class="footer-social">` +
  social(
    "https://x.com/covstrade",
    zh ? "covs 的 X" : "covs on X",
    "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  ) +
  social(
    "https://t.me/covstrade",
    zh ? "covs 的 Telegram 群" : "covs on Telegram",
    "M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z",
  ) +
  `</span>`;

/** @type {import('@docusaurus/types').Config} */
const config = {
  future: portable ? { experimental_router: "hash" } : {},
  title: zh ? "covs.trade 文档" : "covs.trade docs",
  tagline: zh ? "比特币上契约驱动的 CRC 发射台" : "Covenant-powered CRC launchpad on Bitcoin",
  favicon: "img/favicon.png",
  url,
  baseUrl,
  onBrokenLinks: "throw",
  markdown: { hooks: { onBrokenMarkdownLinks: "throw" } },
  i18n: onlyLocale
    ? { defaultLocale: onlyLocale, locales: [onlyLocale], localeConfigs: { [onlyLocale]: localeConfigs[onlyLocale] } }
    : { defaultLocale: "en", locales: ["en", "zh-Hans"], localeConfigs },
  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: { routeBasePath: "/", sidebarPath: "./sidebars.js" },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      }),
    ],
  ],
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: { defaultMode: "dark", respectPrefersColorScheme: true },
      navbar: {
        title: "covs.trade",
        logo: { alt: "covs", src: "img/logo.png" },
        items: onlyLocale
          ? [
              {
                // A plain link to the other build (pathname:// skips the router).
                href: `pathname://${appDocs}/${zh ? "" : "zh-Hans/"}index.html`,
                label: zh ? "English" : "中文",
                target: "_self",
                position: "right",
                className: "locale-link",
              },
            ]
          : [{ type: "localeDropdown", position: "right" }],
      },
      footer: {
        style: "dark",
        links: [{ html: socialLinks }],
        copyright: "covs.trade — Bitcoin mainnet",
      },
    }),
};

module.exports = config;
