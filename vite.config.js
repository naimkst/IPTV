import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";

const HLS_PROXY_PATH = "/api/hls-proxy";

export default defineConfig({
  plugins: [react(), localHlsProxyPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 5173,
  },
});

function localHlsProxyPlugin() {
  return {
    name: "local-hls-proxy",
    configureServer(server) {
      server.middlewares.use(HLS_PROXY_PATH, handleHlsProxyRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use(HLS_PROXY_PATH, handleHlsProxyRequest);
    },
  };
}

async function handleHlsProxyRequest(request, response) {
  setProxyHeaders(response);

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendProxyError(response, 405, "Only GET and HEAD requests are supported.");
    return;
  }

  let targetUrl;

  try {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    targetUrl = parseProxyTarget(requestUrl.searchParams.get("url"));
  } catch (error) {
    sendProxyError(response, 400, error.message);
    return;
  }

  try {
    const upstreamResponse = await fetch(targetUrl, {
      headers: buildUpstreamHeaders(request),
      redirect: "follow",
    });

    response.statusCode = upstreamResponse.status;
    const contentType = upstreamResponse.headers.get("content-type") || "";

    if (isHlsManifest(targetUrl, contentType)) {
      const manifest = await upstreamResponse.text();
      const rewrittenManifest = rewriteHlsManifest(manifest, targetUrl);

      response.setHeader("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : rewrittenManifest);
      return;
    }

    response.setHeader("content-type", contentType || "application/octet-stream");
    copyResponseHeader(upstreamResponse, response, "accept-ranges");
    copyResponseHeader(upstreamResponse, response, "content-range");

    if (request.method === "HEAD" || !upstreamResponse.body) {
      response.end();
      return;
    }

    Readable.fromWeb(upstreamResponse.body).pipe(response);
  } catch (error) {
    sendProxyError(response, 502, `Proxy failed to load stream: ${error.message}`);
  }
}

function setProxyHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,HEAD,OPTIONS");
  response.setHeader("access-control-allow-headers", "Range,Origin,Accept,Content-Type");
  response.setHeader("cache-control", "no-store");
}

function parseProxyTarget(value) {
  if (!value) {
    throw new Error("Missing stream URL.");
  }

  const targetUrl = new URL(value);

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    throw new Error("Only http(s) streams can be proxied.");
  }

  if (isBlockedHost(targetUrl.hostname)) {
    throw new Error("Local/private network targets are not proxied.");
  }

  return targetUrl.href;
}

function buildUpstreamHeaders(request) {
  const headers = {
    accept: "*/*",
    "user-agent": "Local IPTV Lab/0.1",
  };

  if (request.headers.range) {
    headers.range = request.headers.range;
  }

  return headers;
}

function isHlsManifest(targetUrl, contentType) {
  return (
    /\.m3u8(?:[?#]|$)/i.test(targetUrl) ||
    /mpegurl|vnd\.apple\.mpegurl/i.test(contentType)
  );
}

function rewriteHlsManifest(manifest, baseUrl) {
  return manifest
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) {
        return line;
      }

      if (line.startsWith("#")) {
        return rewriteManifestAttributeUris(line, baseUrl);
      }

      return toProxyUrl(resolveManifestUrl(line.trim(), baseUrl));
    })
    .join("\n");
}

function rewriteManifestAttributeUris(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/g, (match, uri) => {
    if (/^(data:|skd:)/i.test(uri)) {
      return match;
    }

    return `URI="${toProxyUrl(resolveManifestUrl(uri, baseUrl))}"`;
  });
}

function resolveManifestUrl(value, baseUrl) {
  return new URL(value, baseUrl).href;
}

function toProxyUrl(targetUrl) {
  return `${HLS_PROXY_PATH}?url=${encodeURIComponent(targetUrl)}`;
}

function copyResponseHeader(fromResponse, toResponse, headerName) {
  const value = fromResponse.headers.get(headerName);

  if (value) {
    toResponse.setHeader(headerName, value);
  }
}

function sendProxyError(response, statusCode, message) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(message);
}

function isBlockedHost(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  return (
    value === "localhost" ||
    value === "::1" ||
    /^127\./.test(value) ||
    /^10\./.test(value) ||
    /^192\.168\./.test(value) ||
    /^169\.254\./.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value) ||
    /^fc[0-9a-f]{2}:/i.test(value) ||
    /^fe80:/i.test(value)
  );
}
