const ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;
const REGION_NAMES =
  typeof Intl !== "undefined" && Intl.DisplayNames
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

export function parseM3U(content, options = {}) {
  const source = options.source || {};
  const lines = content
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const channels = [];
  let pending = null;

  for (const line of lines) {
    if (line.startsWith("#EXTINF")) {
      pending = parseExtinf(line);
      continue;
    }

    if (line.startsWith("#EXTGRP") && pending && !pending.category) {
      pending.category = cleanLabel(line.replace("#EXTGRP:", ""));
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (pending) {
      const channel = toChannel(pending, line, source);
      if (channel) {
        channels.push(channel);
      }
      pending = null;
    }
  }

  return dedupeChannels(channels);
}

function parseExtinf(line) {
  const payload = line.replace(/^#EXTINF:[^,]*/, (match) => match.slice("#EXTINF:".length));
  const commaIndex = findFirstCommaOutsideQuotes(payload);
  const metadata = commaIndex >= 0 ? payload.slice(0, commaIndex) : payload;
  const rawTitle = commaIndex >= 0 ? payload.slice(commaIndex + 1).trim() : "";
  const attrs = parseAttributes(metadata);
  const category = cleanCategory(attrs["group-title"]);
  const countryCode = parseCountryCode(attrs, rawTitle);

  return {
    rawTitle,
    name: cleanLabel(attrs["tvg-name"]) || cleanLabel(rawTitle) || "Untitled channel",
    logo: cleanLogoUrl(attrs["tvg-logo"]),
    category,
    countryCode,
    country: countryCode ? formatCountry(countryCode) : "",
    tvgId: cleanLabel(attrs["tvg-id"]),
  };
}

function parseAttributes(input) {
  const attrs = {};
  let match;

  while ((match = ATTR_PATTERN.exec(input)) !== null) {
    attrs[match[1]] = match[2];
  }

  return attrs;
}

function toChannel(pending, url, source) {
  const streamUrl = cleanUrl(url);
  if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) {
    return null;
  }

  const idSeed = [pending.tvgId, pending.name, streamUrl].filter(Boolean).join("|");
  const streamType = detectStreamType(streamUrl);

  return {
    id: createHashId(idSeed),
    name: pending.name,
    logo: pending.logo,
    category: pending.category,
    country: pending.country,
    countryCode: pending.countryCode,
    tvgId: pending.tvgId,
    url: streamUrl,
    sourceName: cleanLabel(source.name),
    sourceUrl: cleanUrl(source.url),
    streamType,
    isHls: streamType === "hls",
  };
}

function detectStreamType(url) {
  if (/\.m3u8(\?|#|$)/i.test(url)) {
    return "hls";
  }

  if (/\.mpd(\?|#|$)/i.test(url)) {
    return "dash";
  }

  if (/\.(mp4|webm|ogg)(\?|#|$)/i.test(url)) {
    return "video";
  }

  return "web";
}

function dedupeChannels(channels) {
  const seen = new Set();

  return channels.filter((channel) => {
    const key = channel.url;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findFirstCommaOutsideQuotes(input) {
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      inQuotes = !inQuotes;
    }
    if (char === "," && !inQuotes) {
      return index;
    }
  }

  return -1;
}

function parseCountryCode(attrs) {
  const explicitCountry =
    attrs["tvg-country"] || attrs["country"] || attrs["tvg-country-code"];
  const countryFromAttribute = normalizeCountryCode(explicitCountry);

  if (countryFromAttribute) {
    return countryFromAttribute;
  }

  const id = attrs["tvg-id"] || "";
  const match = id.match(/\.([a-z]{2})(?:@|$)/i);
  return normalizeCountryCode(match?.[1]);
}

function cleanCategory(value) {
  const label = cleanLabel(value);
  if (!label || label.toLowerCase() === "undefined") {
    return "";
  }

  return label;
}

function cleanLabel(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function cleanUrl(value = "") {
  return String(value).trim();
}

function cleanLogoUrl(value = "") {
  const url = cleanUrl(value);

  if (!url || url.toLowerCase() === "undefined") {
    return "";
  }

  if (url.startsWith("//")) {
    return `https:${url}`;
  }

  return url;
}

function normalizeCountryCode(value = "") {
  const first = String(value)
    .split(/[;,/|]/)
    .map((part) => part.trim())
    .find(Boolean);

  if (!first || !/^[a-z]{2}$/i.test(first)) {
    return "";
  }

  return first.toUpperCase();
}

function formatCountry(countryCode) {
  if (!REGION_NAMES) {
    return countryCode;
  }

  try {
    return REGION_NAMES.of(countryCode) || countryCode;
  } catch {
    return countryCode;
  }
}

function createHashId(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}
