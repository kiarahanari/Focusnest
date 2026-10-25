/**
 * Entry point Cloudflare Workers.
 * - /api/scalev-webhook  -> kode webhook (function/api/scalev-webhook.js)
 * - selain itu           -> tampilkan web app (index.html dll) seperti biasa
 */
import { onRequestPost, onRequestGet } from './functions/api/scalev-webhook.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/scalev-webhook') {
      if (request.method === 'POST') return onRequestPost({ request, env, ctx });
      return onRequestGet();
    }

    return env.ASSETS.fetch(request);
  },
};
