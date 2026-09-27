// @ts-check
/** covs.trade documentation. Five pages; the docs are the whole site. */

// GitHub Pages serves the site under /covedao/. Override for a custom domain.
const url = process.env.DOCS_URL ?? "https://undefy-io.github.io";
const baseUrl = process.env.DOCS_BASE_URL ?? "/covedao/";

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "covs.trade docs",
  tagline: "Covenant-powered CRC launchpad on Bitcoin",
  favicon: "img/favicon.png",
  url,
  baseUrl,
  onBrokenLinks: "throw",
  markdown: { hooks: { onBrokenMarkdownLinks: "throw" } },
  i18n: { defaultLocale: "en", locales: ["en"] },
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
        items: [
          { href: "https://covs.trade", label: "App", position: "right" },
          { href: "https://github.com/undefy-io/covedao", label: "GitHub", position: "right" },
        ],
      },
      footer: { style: "dark", copyright: "covs.trade — Bitcoin mainnet" },
    }),
};

module.exports = config;
