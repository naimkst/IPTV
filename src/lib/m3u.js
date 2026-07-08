const ATTR_PATTERN = /([\w-]+)="([^"]*)"/g;
const REGION_NAMES =
  typeof Intl !== "undefined" && Intl.DisplayNames
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;
const COUNTRY_NAME_TO_CODE = buildCountryNameMap();

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

    if (line.startsWith("#EXTGRP") && pending) {
      const groupMetadata = parseGroupTitle(line.replace("#EXTGRP:", ""));

      if (!pending.countryCode && groupMetadata.countryCode) {
        pending.countryCode = groupMetadata.countryCode;
        pending.country = formatCountry(groupMetadata.countryCode);
      }

      if (!pending.category && groupMetadata.category) {
        pending.category = groupMetadata.category;
      }

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
  const groupMetadata = parseGroupTitle(attrs["group-title"]);
  const countryCode = parseCountryCode(attrs) || groupMetadata.countryCode;

  return {
    rawTitle,
    name: cleanLabel(attrs["tvg-name"]) || cleanLabel(rawTitle) || "Untitled channel",
    logo: cleanLogoUrl(attrs["tvg-logo"]),
    category: groupMetadata.category,
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

function parseGroupTitle(value = "") {
  const labels = splitLabels(value);
  const categoryLabels = [];
  let countryCode = "";

  labels.forEach((label) => {
    const labelCountryCode = countryCodeFromLabel(label);

    if (labelCountryCode) {
      countryCode ||= labelCountryCode;
      return;
    }

    categoryLabels.push(label);
  });

  return {
    category: cleanCategory(categoryLabels.join("; ")),
    countryCode,
  };
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

function splitLabels(value = "") {
  return String(value)
    .split(/[;|/]/)
    .map((part) => cleanLabel(part))
    .filter(Boolean);
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

function countryCodeFromLabel(value = "") {
  const label = cleanLabel(value);

  if (!label) {
    return "";
  }

  const directCode = normalizeCountryCode(label);
  if (directCode && COUNTRY_NAME_TO_CODE.has(normalizeCountryName(directCode))) {
    return directCode;
  }

  return COUNTRY_NAME_TO_CODE.get(normalizeCountryName(label)) || "";
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

function buildCountryNameMap() {
  const map = new Map();

  if (REGION_NAMES) {
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const countryCode = String.fromCharCode(first, second);
        let displayName = "";

        try {
          displayName = REGION_NAMES.of(countryCode) || "";
        } catch {
          displayName = "";
        }

        if (!displayName || displayName.toUpperCase() === countryCode) {
          continue;
        }

        map.set(normalizeCountryName(displayName), countryCode);
        map.set(normalizeCountryName(countryCode), countryCode);
      }
    }
  }

  Object.entries({
    bosniaandherzegovina: "BA",
    "bosniaherzegovina": "BA",
    czechrepublic: "CZ",
    hongkong: "HK",
    macau: "MO",
    palestine: "PS",
    russia: "RU",
    southkorea: "KR",
    korea: "KR",
    northkorea: "KP",
    taiwan: "TW",
    tanzania: "TZ",
    turkey: "TR",
    uk: "UK",
    uae: "AE",
    unitedkingdom: "UK",
    unitedstates: "US",
    unitedstatesofamerica: "US",
    usa: "US",
    vietnam: "VN",
  }).forEach(([name, countryCode]) => {
    map.set(normalizeCountryName(name), countryCode);
  });

  return map;
}

function normalizeCountryName(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bthe\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function createHashId(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}
