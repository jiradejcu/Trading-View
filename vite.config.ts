import { defineConfig, type ProxyOptions } from 'vite';

// Browsers can't call FRED or Yahoo Finance directly (no CORS headers), so the
// dev and preview servers proxy them. A static build falls back to
// public/data/snapshot.json (see `npm run fetch-data`) and then to demo data.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const proxy: Record<string, ProxyOptions> = {
  '/api/fred': {
    target: 'https://fred.stlouisfed.org',
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/api\/fred/, ''),
    headers: { 'User-Agent': UA },
  },
  '/api/yahoo': {
    target: 'https://query1.finance.yahoo.com',
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/api\/yahoo/, ''),
    headers: { 'User-Agent': UA },
  },
};

export default defineConfig({
  base: './',
  server: { proxy },
  // Self-hosted behind a Cloudflare tunnel (see README "Deployment").
  preview: { proxy, allowedHosts: ['tradingview.vatanutanon.me'] },
});
