import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const ROUTE_CHUNK_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['/person/', 'PersonPage'],
  ['/places', 'PlacesIndexPage'],
  ['/place/', 'PlacePage'],
  ['/time', 'TimePage'],
  ['/tree', 'TreePage'],
  ['/map', 'MapPage'],
  ['/kinship', 'KinshipPage'],
  ['/evidence', 'EvidencePage'],
  ['/changes', 'RecentChangesPage'],
  ['/admin', 'AdminPage'],
];

/**
 * 1. Inlines entry-chunk CSS stylesheets into dist/index.html so first paint has zero
 *    render-blocking stylesheet round trips (while lazy route CSS remains code-split).
 * 2. Injects a tiny synchronous route preloader BEFORE the entry module script so direct
 *    navigations to lazy routes fetch their chunk in parallel with index.js and archive.json.
 */
function kinloomPerfPlugin(): Plugin {
  const base = process.env.VITE_BASE_PATH || '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;

  return {
    name: 'kinloom-perf-inline-css-and-route-preload',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      const bundle = ctx.bundle;
      if (!bundle) {
        return html;
      }

      // 1. Inline entry CSS links emitted into index.html
      let out = html.replace(
        /<link\s+rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/g,
        (tag, href: string) => {
          const clean = href.startsWith(normalizedBase)
            ? href.slice(normalizedBase.length)
            : href.replace(/^\/+/, '');
          const asset = bundle[clean];
          if (asset && asset.type === 'asset' && typeof asset.source === 'string') {
            return `<style>${asset.source}</style>`;
          }
          return tag;
        }
      );

      // 2. Build compact route -> { j: JS chunks, c: CSS files } non-blocking preload map
      const routeMap: Record<string, { j: string[]; c: string[] }> = {};
      for (const [prefix, chunkName] of ROUTE_CHUNK_PATTERNS) {
        const entry = Object.values(bundle).find(
          (item) => item.type === 'chunk' && item.name === chunkName
        );
        if (entry && entry.type === 'chunk') {
          const jsUrls = new Set<string>([`${normalizedBase}${entry.fileName}`]);
          const cssUrls = new Set<string>();
          const addCss = (chunk: unknown) => {
            const meta = (chunk as { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata;
            if (meta?.importedCss) {
              for (const css of meta.importedCss) {
                cssUrls.add(`${normalizedBase}${css}`);
              }
            }
          };
          addCss(entry);
          for (const imp of entry.imports) {
            const dep = bundle[imp];
            if (dep && dep.type === 'chunk' && !dep.isEntry && dep.name !== 'vendor-react' && dep.name !== 'kinloom-shell') {
              if (jsUrls.size < 4) {
                jsUrls.add(`${normalizedBase}${dep.fileName}`);
              }
              addCss(dep);
            }
          }
          routeMap[prefix] = { j: [...jsUrls], c: [...cssUrls] };
        }
      }

      const archiveUrl = `${normalizedBase}data/archive.json`;
      const archivePreloadScript = `<script>window.__KINLOOM_ARCHIVE_PROMISE__=fetch(${JSON.stringify(archiveUrl)});</script>`;
      if (Object.keys(routeMap).length > 0) {
        const encodedRouteMap = Buffer.from(JSON.stringify(routeMap), 'utf8').toString('base64');
        const basePrefix = normalizedBase === '/' ? '' : normalizedBase.replace(/\/+$/, '');
        const preloadScript =
          `${archivePreloadScript}\n` +
          `    <meta name="kinloom-route-preload" content="${encodedRouteMap}">\n` +
          `    <script>(function(){var el=document.querySelector('meta[name="kinloom-route-preload"]');if(!el)return;var p=location.pathname,b=${JSON.stringify(basePrefix)};if(b&&p.indexOf(b)===0)p=p.slice(b.length)||'/';var m=JSON.parse(atob(el.content));for(var k in m){if(p===k||p.indexOf(k)===0){var d=document,h=d.head,e=m[k];e.j.forEach(function(u){var l=d.createElement('link');l.rel='modulepreload';l.href=u;h.appendChild(l);});e.c.forEach(function(u){var l=d.createElement('link');l.rel='preload';l.as='style';l.href=u;h.appendChild(l);});break;}}})();</script>`;
        out = out.replace('<script type="module"', `${preloadScript}\n    <script type="module"`);
      } else {
        out = out.replace('<script type="module"', `${archivePreloadScript}\n    <script type="module"`);
      }

      return out;
    },
  };
}

export default defineConfig({
  plugins: [react(), kinloomPerfPlugin()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  define: {
    __APP_BUILD_ID__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 8) || 'demo-local'),
  },
  base: process.env.VITE_BASE_PATH || '/',
  build: {
    chunkSizeWarningLimit: 1150,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) {
            return 'vendor-maplibre';
          }
          if (id.includes('node_modules/zod')) {
            return 'vendor-zod';
          }
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react-router') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          // Consolidate tiny shared UI shell modules (never pulling in all of @kinloom/core or zod)
          if (
            id.includes('/packages/ui/dist/context/') ||
            id.includes('/packages/ui/dist/lib/cx') ||
            id.includes('/packages/ui/dist/lib/vocabulary') ||
            id.includes('/packages/ui/dist/components/ExplorerTopBar') ||
            id.includes('/packages/ui/dist/components/KinloomFooter') ||
            id.includes('/packages/ui/dist/components/Atoms') ||
            id.includes('/packages/ui/dist/components/atoms/') ||
            id.includes('/packages/ui/dist/components/ArchivalImage') ||
            id.includes('/packages/ui/dist/components/PersonPortrait') ||
            id.includes('/packages/ui/dist/plugins/PluginContext')
          ) {
            return 'kinloom-shell';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
