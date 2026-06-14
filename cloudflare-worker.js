/**
 * Dhrubion IPTV CORS Proxy — Cloudflare Worker
 * ------------------------------------------------------------------
 * Why: browsers block cross-origin IPTV streams (CORS) and can't send
 * the custom headers (User-Agent / Referer) many IPTV servers require.
 * This Worker runs server-side, fetches the stream WITH those headers,
 * rewrites .m3u8 playlists so every segment also goes through the proxy,
 * and re-serves everything with permissive CORS headers so hls.js can play it.
 *
 * Flow:  browser (hls.js)  ->  this Worker  ->  IPTV server  ->  back to browser
 *
 * DEPLOY (free):
 *   1. Go to dash.cloudflare.com -> Workers & Pages -> Create -> Worker.
 *   2. Replace the default code with THIS file, click Deploy.
 *   3. Copy your Worker URL, e.g.  https://my-proxy.yourname.workers.dev
 *   4. In a post, add:  proxy: https://my-proxy.yourname.workers.dev
 *      (the theme will route the m3u8 + segments through it automatically)
 *
 * Usage:   https://YOUR-WORKER/?url=<ENCODED_STREAM_URL>
 * Optional headers you can pass for picky IPTV servers:
 *   &ua=<User-Agent>   &ref=<Referer>   &origin=<Origin>
 *
 * NOTE: Only proxy streams you have the right to use. You are responsible
 * for the content routed through your Worker.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

export default {
  async fetch(request) {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get("url");

    if (!target) {
      return new Response(
        "Dhrubion IPTV proxy is running.\nUsage: ?url=<encoded stream url>",
        { status: 200, headers: { ...CORS, "Content-Type": "text/plain" } }
      );
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response("Invalid url parameter", { status: 400, headers: CORS });
    }

    // Optional custom headers that many IPTV servers require.
    const ua =
      reqUrl.searchParams.get("ua") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
    const ref = reqUrl.searchParams.get("ref") || "";
    const origin = reqUrl.searchParams.get("origin") || "";

    const fwdHeaders = new Headers();
    fwdHeaders.set("User-Agent", ua);
    fwdHeaders.set("Accept", "*/*");
    if (ref) fwdHeaders.set("Referer", ref);
    if (origin) fwdHeaders.set("Origin", origin);
    // pass Range so seeking / segment requests work
    const range = request.headers.get("Range");
    if (range) fwdHeaders.set("Range", range);

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: "GET",
        headers: fwdHeaders,
        redirect: "follow",
      });
    } catch (e) {
      return new Response("Upstream fetch failed: " + e.message, {
        status: 502,
        headers: CORS,
      });
    }

    const ct = (upstream.headers.get("Content-Type") || "").toLowerCase();
    const looksM3u =
      /\.m3u8?(\?|$)/i.test(targetUrl.pathname) ||
      ct.includes("mpegurl") ||
      ct.includes("application/vnd.apple.mpegurl") ||
      ct.includes("audio/x-mpegurl");

    // If it's an HLS playlist, rewrite every URI inside so segments + sub-playlists
    // ALSO go through this proxy (otherwise the browser hits CORS again on segments).
    if (looksM3u) {
      const text = await upstream.text();
      const base = targetUrl;
      const self = reqUrl.origin + reqUrl.pathname; // this worker's base

      const rewriteLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Rewrite URI="..." inside tags (keys, maps, media, etc.)
        if (trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (m, u) => {
            const abs = new URL(u, base).toString();
            return 'URI="' + self + "?url=" + encodeURIComponent(abs) + carry() + '"';
          });
        }
        // Otherwise it's a segment / variant playlist URL line
        const abs = new URL(trimmed, base).toString();
        return self + "?url=" + encodeURIComponent(abs) + carry();
      };

      // carry forward the optional header params to child requests
      const carry = () => {
        let s = "";
        if (reqUrl.searchParams.get("ua")) s += "&ua=" + encodeURIComponent(reqUrl.searchParams.get("ua"));
        if (ref) s += "&ref=" + encodeURIComponent(ref);
        if (origin) s += "&origin=" + encodeURIComponent(origin);
        return s;
      };

      const out = text
        .split(/\r?\n/)
        .map(rewriteLine)
        .join("\n");

      return new Response(out, {
        status: upstream.status,
        headers: {
          ...CORS,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        },
      });
    }

    // Binary passthrough (segments .ts/.m4s, keys, mp4, mpd, etc.)
    const respHeaders = new Headers(CORS);
    const passthrough = [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Cache-Control",
      "Last-Modified",
      "ETag",
    ];
    passthrough.forEach((h) => {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
