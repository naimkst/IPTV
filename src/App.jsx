import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import {
  AlertCircle,
  Heart,
  Loader2,
  MapPin,
  Play,
  RefreshCcw,
  Search,
  Star,
  Trash2,
  Trophy,
} from "lucide-react";
import { parseM3U } from "./lib/m3u.js";

const PLAYLISTS = [
  {
    name: "IPTV-org",
    url: "https://iptv-org.github.io/iptv/index.m3u",
  },
  {
    name: "IPTV-org Sports",
    url: "https://iptv-org.github.io/iptv/categories/sports.m3u",
  },
  {
    name: "IPTV-org Pakistan",
    url: "https://iptv-org.github.io/iptv/countries/pk.m3u",
  },
  {
    name: "IPTV-org Bangladesh",
    url: "https://iptv-org.github.io/iptv/countries/bd.m3u",
  },
  {
    name: "Free-TV",
    url: "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8",
  },
];
const FAVORITES_KEY = "local-iptv-lab:favorites";
const UNAVAILABLE_CHANNELS_KEY = "local-iptv-lab:unavailable-channels";
const CUSTOM_CHANNELS_KEY = "local-iptv-lab:custom-channels";
const CHANNEL_OVERRIDES_KEY = "local-iptv-lab:channel-overrides";
const PLAYBACK_PROXY_KEY = "local-iptv-lab:playback-proxy";
const CHANNEL_PAGE_SIZE = 160;
const MAX_FATAL_STREAM_ERRORS = 2;
const HLS_PROXY_PATH = "/api/hls-proxy";
const FOCUS_FILTERS = {
  all: "all",
  sports: "sports",
  worldCup: "world-cup",
  pakistan: "pakistan",
  bangladesh: "bangladesh",
  custom: "custom",
};

export default function App() {
  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [focusFilter, setFocusFilter] = useState(FOCUS_FILTERS.all);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [autoSkipFailed, setAutoSkipFailed] = useState(true);
  const [customStreamName, setCustomStreamName] = useState("");
  const [customStreamUrl, setCustomStreamUrl] = useState("");
  const [customStreamError, setCustomStreamError] = useState("");
  const [channelOverrides, setChannelOverrides] = useState(() =>
    readStoredOverrides(CHANNEL_OVERRIDES_KEY),
  );
  const [customChannels, setCustomChannels] = useState(() =>
    readStoredChannels(CUSTOM_CHANNELS_KEY),
  );
  const [useLocalProxy, setUseLocalProxy] = useState(() =>
    readStoredBoolean(PLAYBACK_PROXY_KEY, true),
  );
  const [visibleLimit, setVisibleLimit] = useState(CHANNEL_PAGE_SIZE);
  const [favoriteIds, setFavoriteIds] = useState(() => readStoredIds(FAVORITES_KEY));
  const [unavailableChannelIds, setUnavailableChannelIds] = useState(() =>
    readStoredIds(UNAVAILABLE_CHANNELS_KEY),
  );
  const [playlistState, setPlaylistState] = useState({
    loading: true,
    error: "",
    warning: "",
    loadedAt: null,
    totalFound: 0,
    skippedUnsupported: 0,
    skippedDuplicates: 0,
    sourcesLoaded: 0,
  });
  const [playerState, setPlayerState] = useState({
    loading: false,
    error: "",
  });
  const [qualitySelection, setQualitySelection] = useState("auto");
  const [qualityLevels, setQualityLevels] = useState([]);
  const [activeQualityLabel, setActiveQualityLabel] = useState("Optimize");
  const [playbackStats, setPlaybackStats] = useState({
    bufferAhead: 0,
    liveDelay: null,
  });

  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const channelRefs = useRef([]);
  const streamFailureCountRef = useRef(0);
  const filteredChannelsRef = useRef([]);
  const autoSkipFailedRef = useRef(autoSkipFailed);

  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const unavailableSet = useMemo(
    () => new Set(unavailableChannelIds),
    [unavailableChannelIds],
  );

  const publicChannelsWithOverrides = useMemo(() => {
    return channels.map((channel) => applyChannelOverride(channel, channelOverrides));
  }, [channels, channelOverrides]);

  const allSavedChannels = useMemo(() => {
    return [...publicChannelsWithOverrides, ...customChannels];
  }, [publicChannelsWithOverrides, customChannels]);

  const unavailableChannels = useMemo(() => {
    return allSavedChannels.filter((channel) => unavailableSet.has(channel.id));
  }, [allSavedChannels, unavailableSet]);

  const publicChannels = useMemo(() => {
    return allSavedChannels.filter((channel) => !channel.isCustom);
  }, [allSavedChannels]);

  const customSavedChannels = useMemo(() => {
    return allSavedChannels.filter((channel) => channel.isCustom);
  }, [allSavedChannels]);

  const filterBaseChannels = useMemo(() => {
    return focusFilter === FOCUS_FILTERS.custom ? customSavedChannels : publicChannels;
  }, [customSavedChannels, focusFilter, publicChannels]);

  const categoryOptions = useMemo(() => {
    return buildOptions(filterBaseChannels.flatMap((channel) => splitCategories(channel.category)));
  }, [filterBaseChannels]);

  const countryOptions = useMemo(() => {
    return buildOptions(filterBaseChannels.map((channel) => channel.country).filter(Boolean));
  }, [filterBaseChannels]);

  const filteredChannels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return filterBaseChannels.filter((channel) => {
      const matchesQuery =
        !normalizedQuery || getChannelSearchText(channel).includes(normalizedQuery);
      const matchesCategory =
        categoryFilter === "all" ||
        splitCategories(channel.category).includes(categoryFilter);
      const matchesCountry = countryFilter === "all" || channel.country === countryFilter;
      const matchesFocus =
        focusFilter === FOCUS_FILTERS.all ||
        focusFilter === FOCUS_FILTERS.custom ||
        (focusFilter === FOCUS_FILTERS.sports && isSportsChannel(channel)) ||
        (focusFilter === FOCUS_FILTERS.worldCup && isWorldCupCandidate(channel)) ||
        (focusFilter === FOCUS_FILTERS.pakistan && isPakistanChannel(channel)) ||
        (focusFilter === FOCUS_FILTERS.bangladesh && isBangladeshChannel(channel));
      const matchesFavorites = !favoritesOnly || favoriteSet.has(channel.id);

      return matchesQuery && matchesCategory && matchesCountry && matchesFocus && matchesFavorites;
    });
  }, [filterBaseChannels, query, categoryFilter, countryFilter, focusFilter, favoritesOnly, favoriteSet]);

  const visibleChannels = useMemo(() => {
    return filteredChannels.slice(0, visibleLimit);
  }, [filteredChannels, visibleLimit]);

  const playableFilteredChannels = useMemo(() => {
    return filteredChannels.filter((channel) => !unavailableSet.has(channel.id));
  }, [filteredChannels, unavailableSet]);

  const hasMoreChannels = visibleChannels.length < filteredChannels.length;
  const hiddenChannelCount = unavailableChannels.length;
  const hiddenFilteredChannelCount = filteredChannels.length - playableFilteredChannels.length;
  const sportsChannelCount = useMemo(
    () => publicChannels.filter(isSportsChannel).length,
    [publicChannels],
  );
  const worldCupChannelCount = useMemo(
    () => publicChannels.filter(isWorldCupCandidate).length,
    [publicChannels],
  );
  const bangladeshChannelCount = useMemo(
    () => publicChannels.filter(isBangladeshChannel).length,
    [publicChannels],
  );
  const pakistanChannelCount = useMemo(
    () => publicChannels.filter(isPakistanChannel).length,
    [publicChannels],
  );
  const customChannelCount = customSavedChannels.length;

  useEffect(() => {
    loadPlaylist();
  }, []);

  useEffect(() => {
    setVisibleLimit(CHANNEL_PAGE_SIZE);
    channelRefs.current = [];
  }, [query, categoryFilter, countryFilter, focusFilter, favoritesOnly]);

  useEffect(() => {
    filteredChannelsRef.current = playableFilteredChannels;
  }, [playableFilteredChannels]);

  useEffect(() => {
    autoSkipFailedRef.current = autoSkipFailed;
  }, [autoSkipFailed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoriteIds));
    } catch {
      // Favorites remain available for this session if localStorage is blocked.
    }
  }, [favoriteIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        UNAVAILABLE_CHANNELS_KEY,
        JSON.stringify(unavailableChannelIds),
      );
    } catch {
      // Failed marks remain available for this session if localStorage is blocked.
    }
  }, [unavailableChannelIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CUSTOM_CHANNELS_KEY, JSON.stringify(customChannels));
    } catch {
      // Custom channels remain available for this session if localStorage is blocked.
    }
  }, [customChannels]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHANNEL_OVERRIDES_KEY, JSON.stringify(channelOverrides));
    } catch {
      // Overrides remain available for this session if localStorage is blocked.
    }
  }, [channelOverrides]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PLAYBACK_PROXY_KEY, JSON.stringify(useLocalProxy));
    } catch {
      // Proxy preference remains available for this session if localStorage is blocked.
    }
  }, [useLocalProxy]);

  useEffect(() => {
    if (!hlsRef.current) {
      return;
    }

    applyQualitySelection(hlsRef.current, qualitySelection);
  }, [qualitySelection]);

  useEffect(() => {
    if (!selectedChannel || !videoRef.current) {
      return undefined;
    }

    const video = videoRef.current;
    const playbackUrl = getPlaybackUrl(selectedChannel.url, useLocalProxy);
    let hls = null;
    let cancelled = false;
    let retryTimer = null;

    streamFailureCountRef.current = 0;
    hlsRef.current = null;
    setQualityLevels([]);
    setActiveQualityLabel("Optimize");
    setPlaybackStats({ bufferAhead: 0, liveDelay: null });
    setPlayerState({ loading: true, error: "" });
    video.pause();
    video.removeAttribute("src");
    video.load();

    const reportError = (message) => {
      if (!cancelled) {
        setPlayerState({ loading: false, error: message });
      }
    };

    const clearPlayerMessage = () => {
      if (cancelled) {
        return;
      }

      setPlayerState((current) =>
        current.error ? { ...current, error: "" } : current,
      );
    };

    video.addEventListener("play", clearPlayerMessage);
    video.addEventListener("playing", clearPlayerMessage);

    const removePlayerMessageListeners = () => {
      video.removeEventListener("play", clearPlayerMessage);
      video.removeEventListener("playing", clearPlayerMessage);
    };

    const clearRetryTimer = () => {
      if (retryTimer) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const markUnavailableStream = (message) => {
      if (cancelled) {
        return;
      }

      clearRetryTimer();
      const nextChannel = autoSkipFailedRef.current
        ? findNextChannel(selectedChannel, filteredChannelsRef.current)
        : null;

      setUnavailableChannelIds((current) => {
        if (current.includes(selectedChannel.id)) {
          return current;
        }

        return [...current, selectedChannel.id];
      });
      setPlayerState({ loading: false, error: message });
      setSelectedChannel((current) =>
        current?.id === selectedChannel.id ? nextChannel : current,
      );
    };

    const markIfStillUnavailable = (message) => {
      clearRetryTimer();
      retryTimer = window.setTimeout(() => {
        if (cancelled || video.readyState >= 2) {
          return;
        }

        markUnavailableStream(message);
      }, 6000);
    };

    const startPlayback = async () => {
      try {
        await video.play();
      } catch {
        reportError("Playback is ready. Press play in the video controls to start.");
      }
    };

    if (!selectedChannel.isHls) {
      reportError("This channel is not an HLS .m3u8 stream, so this browser player cannot play it.");
      return () => {
        cancelled = true;
        removePlayerMessageListeners();
      };
    }

    const startStatsTracking = (getHls) => {
      const updateStats = () => {
        if (cancelled) {
          return;
        }

        setPlaybackStats({
          bufferAhead: getBufferAhead(video),
          liveDelay: getLiveDelay(getHls()),
        });
      };

      updateStats();
      const timer = window.setInterval(updateStats, 1000);
      video.addEventListener("progress", updateStats);
      video.addEventListener("timeupdate", updateStats);

      return () => {
        window.clearInterval(timer);
        video.removeEventListener("progress", updateStats);
        video.removeEventListener("timeupdate", updateStats);
      };
    };

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 8,
        maxBufferLength: 45,
        maxMaxBufferLength: 90,
        backBufferLength: 90,
      });
      hlsRef.current = hls;
      const stopStatsTracking = startStatsTracking(() => hls);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!cancelled) {
          clearRetryTimer();
          setQualityLevels(createQualityLevels(hls.levels));
          applyQualitySelection(hls, "auto");
          setPlayerState({ loading: false, error: "" });
          startPlayback();
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (!cancelled) {
          setActiveQualityLabel(formatQualityLabel(hls.levels[data.level]));
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) {
          return;
        }

        streamFailureCountRef.current += 1;

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (streamFailureCountRef.current < MAX_FATAL_STREAM_ERRORS) {
            hls.startLoad();
            reportError("Network trouble while loading the stream. Retrying once...");
            markIfStillUnavailable(
              "Stream stayed unreachable after retry. It was marked as failed.",
            );
            return;
          }

          markUnavailableStream("Stream is offline, blocked, or unreachable. It was marked as failed.");
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (streamFailureCountRef.current < MAX_FATAL_STREAM_ERRORS) {
            hls.recoverMediaError();
            reportError("Media decode trouble. Attempting recovery...");
            markIfStillUnavailable(
              "Stream media could not recover. It was marked as failed.",
            );
            return;
          }

          markUnavailableStream("Stream media could not be decoded. It was marked as failed.");
          return;
        }

        markUnavailableStream("This stream could not be played. It was marked as failed.");
      });

      hls.attachMedia(video);
      hls.loadSource(playbackUrl);

      return () => {
        cancelled = true;
        clearRetryTimer();
        stopStatsTracking();
        if (hlsRef.current === hls) {
          hlsRef.current = null;
        }
        removePlayerMessageListeners();
        hls?.destroy();
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      const stopStatsTracking = startStatsTracking(() => null);
      video.src = playbackUrl;
      const onLoadedMetadata = () => {
        clearRetryTimer();
        setPlayerState({ loading: false, error: "" });
        setActiveQualityLabel("Native");
        startPlayback();
      };
      const onError = () =>
        markUnavailableStream("The browser could not load this HLS stream. It was marked as failed.");

      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("error", onError);

      return () => {
        cancelled = true;
        clearRetryTimer();
        stopStatsTracking();
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onError);
        removePlayerMessageListeners();
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    reportError("HLS playback is not supported by this browser.");
    return () => {
      cancelled = true;
      removePlayerMessageListeners();
    };
  }, [selectedChannel, useLocalProxy]);

  async function loadPlaylist() {
    setPlaylistState({
      loading: true,
      error: "",
      warning: "",
      loadedAt: null,
      totalFound: 0,
      skippedUnsupported: 0,
      skippedDuplicates: 0,
      sourcesLoaded: 0,
    });

    try {
      const results = await Promise.allSettled(
        PLAYLISTS.map(async (source) => {
          const response = await fetch(source.url, { cache: "no-store" });

          if (!response.ok) {
            throw new Error(`${source.name} failed with HTTP ${response.status}`);
          }

          const playlist = await response.text();
          return parseM3U(playlist, { source });
        }),
      );

      const loadedChannelGroups = [];
      const failedSources = [];

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          loadedChannelGroups.push(result.value);
        } else {
          failedSources.push(`${PLAYLISTS[index].name}: ${result.reason.message}`);
        }
      });

      const parsedChannels = loadedChannelGroups.flat();
      const hlsChannels = parsedChannels.filter((channel) => channel.isHls);
      const playableChannels = dedupeChannelsByUrl(hlsChannels);

      if (playableChannels.length === 0) {
        throw new Error("No playable channels were found in the playlist.");
      }

      setChannels(playableChannels);
      setPlaylistState({
        loading: false,
        error: "",
        warning: failedSources.join(" | "),
        loadedAt: new Date(),
        totalFound: parsedChannels.length,
        skippedUnsupported: parsedChannels.length - hlsChannels.length,
        skippedDuplicates: hlsChannels.length - playableChannels.length,
        sourcesLoaded: loadedChannelGroups.length,
      });
    } catch (error) {
      setChannels([]);
      setPlaylistState({
        loading: false,
        warning: "",
        error: error.message || "Unable to load the public playlist.",
        loadedAt: null,
        totalFound: 0,
        skippedUnsupported: 0,
        skippedDuplicates: 0,
        sourcesLoaded: 0,
      });
    }
  }

  function toggleFavorite(channel) {
    setFavoriteIds((current) => {
      if (current.includes(channel.id)) {
        return current.filter((id) => id !== channel.id);
      }

      return [...current, channel.id];
    });
  }

  function selectChannel(channel) {
    setQualitySelection("auto");
    setUnavailableChannelIds((current) => current.filter((id) => id !== channel.id));
    setSelectedChannel(channel);
  }

  function selectNextChannel() {
    const nextChannel =
      findNextChannel(selectedChannel, playableFilteredChannels) ||
      findNextChannel(selectedChannel, filteredChannels);

    if (nextChannel) {
      selectChannel(nextChannel);
    }
  }

  function toggleFocusFilter(nextFilter) {
    setFocusFilter((currentFilter) =>
      currentFilter === nextFilter ? FOCUS_FILTERS.all : nextFilter,
    );
    setCategoryFilter("all");
    setCountryFilter("all");
  }

  function playCustomStream(event) {
    event.preventDefault();

    const url = customStreamUrl.trim();
    const name = customStreamName.trim() || getNameFromUrl(url);

    if (!isDirectHlsUrl(url)) {
      setCustomStreamError("Enter a direct http(s) .m3u8 HLS URL.");
      return;
    }

    setCustomStreamError("");
    const customChannel = {
      id: `custom-${createHashId(url)}`,
      name,
      logo: "",
      category: "Custom",
      country: "",
      countryCode: "",
      tvgId: "",
      url,
      sourceName: "Custom URL",
      sourceUrl: url,
      streamType: "hls",
      isHls: true,
      isCustom: true,
    };

    setCustomChannels((current) => [
      customChannel,
      ...current.filter((channel) => channel.id !== customChannel.id),
    ]);
    setUnavailableChannelIds((current) =>
      current.filter((channelId) => channelId !== customChannel.id),
    );
    setFocusFilter(FOCUS_FILTERS.custom);
    setCategoryFilter("all");
    setCountryFilter("all");
    setCustomStreamName("");
    setCustomStreamUrl("");
    selectChannel(customChannel);
  }

  function saveOverrideForSelectedChannel() {
    const url = customStreamUrl.trim();

    if (!selectedChannel || selectedChannel.isCustom) {
      setCustomStreamError("Select a public channel first.");
      return;
    }

    if (!isDirectHlsUrl(url)) {
      setCustomStreamError("Enter a direct http(s) .m3u8 HLS URL.");
      return;
    }

    const override = {
      url,
      savedAt: new Date().toISOString(),
    };

    setCustomStreamError("");
    setChannelOverrides((current) => ({
      ...current,
      [selectedChannel.id]: override,
    }));
    setUnavailableChannelIds((current) =>
      current.filter((channelId) => channelId !== selectedChannel.id),
    );
    setCustomStreamUrl("");
    setCustomStreamName("");
    selectChannel({
      ...selectedChannel,
      url,
      originalUrl: selectedChannel.originalUrl || selectedChannel.url,
      hasOverride: true,
      overrideUrl: url,
    });
  }

  function removeSelectedOverride() {
    if (!selectedChannel?.hasOverride) {
      return;
    }

    setChannelOverrides((current) => {
      const next = { ...current };
      delete next[selectedChannel.id];
      return next;
    });
    setSelectedChannel((current) => {
      if (!current || current.id !== selectedChannel.id) {
        return current;
      }

      return {
        ...current,
        url: current.originalUrl || current.url,
        originalUrl: undefined,
        hasOverride: false,
        overrideUrl: "",
      };
    });
  }

  function deleteCustomChannel(channel) {
    setCustomChannels((current) => current.filter((item) => item.id !== channel.id));
    setFavoriteIds((current) => current.filter((id) => id !== channel.id));
    setUnavailableChannelIds((current) => current.filter((id) => id !== channel.id));
    setSelectedChannel((current) => (current?.id === channel.id ? null : current));
  }

  function handleChannelKeyDown(event, index) {
    const nextKeys = ["ArrowDown", "ArrowRight"];
    const previousKeys = ["ArrowUp", "ArrowLeft"];

    if (![...nextKeys, ...previousKeys, "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();

    let nextIndex = index;

    if (nextKeys.includes(event.key)) {
      nextIndex = Math.min(index + 1, visibleChannels.length - 1);
    } else if (previousKeys.includes(event.key)) {
      nextIndex = Math.max(index - 1, 0);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = visibleChannels.length - 1;
    }

    channelRefs.current[nextIndex]?.focus();
  }

  const selectedIsFavorite = selectedChannel ? favoriteSet.has(selectedChannel.id) : false;
  const hasFilters =
    query ||
    categoryFilter !== "all" ||
    countryFilter !== "all" ||
    focusFilter !== FOCUS_FILTERS.all ||
    favoritesOnly;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local-only public stream tester</p>
          <h1>Local IPTV Lab</h1>
        </div>
        <div className="topbar-actions">
          <span className="status-pill">
            {playlistState.loading
              ? "Loading"
              : `${publicChannels.length.toLocaleString()} public • ${customChannelCount.toLocaleString()} custom`}
          </span>
          <button className="icon-button" type="button" onClick={loadPlaylist} aria-label="Reload playlist">
            <RefreshCcw size={20} />
          </button>
        </div>
      </header>

      <main className="app-layout">
        <aside className="channel-panel" aria-label="Channel browser">
          <div className="controls">
            <label className="search-box">
              <Search size={20} aria-hidden="true" />
              <input
                type="search"
                placeholder="Search channels"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>

            <form className="custom-stream-form" onSubmit={playCustomStream}>
              <div className="custom-stream-grid">
                <label>
                  <span>Name</span>
                  <input
                    type="text"
                    placeholder="Custom channel"
                    value={customStreamName}
                    onChange={(event) => setCustomStreamName(event.target.value)}
                  />
                </label>
                <label className="custom-url-field">
                  <span>HLS URL</span>
                  <input
                    type="url"
                    placeholder="https://example.com/video.m3u8"
                    value={customStreamUrl}
                    onChange={(event) => setCustomStreamUrl(event.target.value)}
                  />
                </label>
              </div>
              <button className="text-button" type="submit">
                <Play size={18} />
                Save & Play
              </button>
              {selectedChannel && !selectedChannel.isCustom && (
                <button className="text-button" type="button" onClick={saveOverrideForSelectedChannel}>
                  <RefreshCcw size={18} />
                  Use for selected
                </button>
              )}
              {customStreamError && <p className="form-error">{customStreamError}</p>}
            </form>

            <div className="filter-grid">
              {categoryOptions.length > 0 && (
                <label>
                  <span>Category</span>
                  <select
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value)}
                  >
                    <option value="all">All categories</option>
                    {categoryOptions.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {countryOptions.length > 0 && (
                <label>
                  <span>Country</span>
                  <select
                    value={countryFilter}
                    onChange={(event) => setCountryFilter(event.target.value)}
                  >
                    <option value="all">All countries</option>
                    {countryOptions.map((country) => (
                      <option key={country} value={country}>
                        {country}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="control-row">
              <button
                className={`text-button ${focusFilter === FOCUS_FILTERS.sports ? "is-active" : ""}`}
                type="button"
                onClick={() => toggleFocusFilter(FOCUS_FILTERS.sports)}
              >
                <Trophy size={18} />
                Sports ({sportsChannelCount.toLocaleString()})
              </button>
              <button
                className={`text-button ${focusFilter === FOCUS_FILTERS.worldCup ? "is-active" : ""}`}
                type="button"
                onClick={() => toggleFocusFilter(FOCUS_FILTERS.worldCup)}
              >
                <Trophy size={18} />
                World Cup ({worldCupChannelCount.toLocaleString()})
              </button>
              <button
                className={`text-button ${focusFilter === FOCUS_FILTERS.bangladesh ? "is-active" : ""}`}
                type="button"
                onClick={() => toggleFocusFilter(FOCUS_FILTERS.bangladesh)}
              >
                <MapPin size={18} />
                Bangladesh ({bangladeshChannelCount.toLocaleString()})
              </button>
              <button
                className={`text-button ${focusFilter === FOCUS_FILTERS.pakistan ? "is-active" : ""}`}
                type="button"
                onClick={() => toggleFocusFilter(FOCUS_FILTERS.pakistan)}
              >
                <MapPin size={18} />
                Pakistan ({pakistanChannelCount.toLocaleString()})
              </button>
              <button
                className={`text-button ${focusFilter === FOCUS_FILTERS.custom ? "is-active" : ""}`}
                type="button"
                onClick={() => {
                  setFocusFilter((value) =>
                    value === FOCUS_FILTERS.custom ? FOCUS_FILTERS.all : FOCUS_FILTERS.custom,
                  );
                  setCategoryFilter("all");
                  setCountryFilter("all");
                }}
              >
                <Play size={18} />
                Custom ({customChannelCount.toLocaleString()})
              </button>
              <button
                className={`text-button ${favoritesOnly ? "is-active" : ""}`}
                type="button"
                onClick={() => setFavoritesOnly((value) => !value)}
              >
                <Heart size={18} />
                Favorites
              </button>
              {hasFilters && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setCategoryFilter("all");
                    setCountryFilter("all");
                    setFocusFilter(FOCUS_FILTERS.all);
                    setFavoritesOnly(false);
                  }}
                >
                  Reset
                </button>
              )}
              {hiddenChannelCount > 0 && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setUnavailableChannelIds([])}
                >
                  <RefreshCcw size={18} />
                  Clear failed marks ({hiddenChannelCount.toLocaleString()})
                </button>
              )}
            </div>
          </div>

          <div className="list-meta">
            <span>
              {hasMoreChannels
                ? `${visibleChannels.length.toLocaleString()} of ${filteredChannels.length.toLocaleString()} shown`
                : `${filteredChannels.length.toLocaleString()} shown`}
            </span>
            <span>{favoriteIds.length.toLocaleString()} favorites</span>
            {hiddenChannelCount > 0 && (
              <span>
                {hiddenFilteredChannelCount > 0
                  ? `${hiddenFilteredChannelCount.toLocaleString()} failed here`
                  : `${hiddenChannelCount.toLocaleString()} failed marked`}
              </span>
            )}
          </div>

          {playlistState.loading && <StateMessage icon={<Loader2 className="spin" />} title="Loading playlist" />}

          {playlistState.error && (
            <StateMessage
              icon={<AlertCircle />}
              title="Playlist unavailable"
              text={playlistState.error}
            />
          )}

          {!playlistState.loading && !playlistState.error && filteredChannels.length === 0 && (
            <StateMessage
              icon={<Search />}
              title="No channels found"
              text="Adjust search, category, country, tab, or favorites filters."
            />
          )}

          <div className="channel-grid" aria-live="polite">
            {visibleChannels.map((channel, index) => (
              <ChannelCard
                key={channel.id}
                channel={channel}
                isSelected={selectedChannel?.id === channel.id}
                isFavorite={favoriteSet.has(channel.id)}
                isUnavailable={unavailableSet.has(channel.id)}
                onSelect={() => selectChannel(channel)}
                onFavorite={() => toggleFavorite(channel)}
                onDelete={channel.isCustom ? () => deleteCustomChannel(channel) : undefined}
                onKeyDown={(event) => handleChannelKeyDown(event, index)}
                buttonRef={(node) => {
                  channelRefs.current[index] = node;
                }}
              />
            ))}
            {hasMoreChannels && (
              <button
                className="load-more-button"
                type="button"
                onClick={() => setVisibleLimit((limit) => limit + CHANNEL_PAGE_SIZE)}
              >
                Show more channels
              </button>
            )}
          </div>
        </aside>

        <section className="watch-panel" aria-label="Player">
          <div className="player-frame">
            {selectedChannel ? (
              <>
                <video ref={videoRef} controls playsInline poster={selectedChannel.logo || undefined} />
                {playerState.loading && (
                  <div className="player-overlay">
                    <Loader2 className="spin" />
                    <span>Loading stream</span>
                  </div>
                )}
                {playerState.error && (
                  <div className="player-overlay player-overlay-error">
                    <AlertCircle />
                    <span>{playerState.error}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="empty-player">
                <Play size={54} />
                <h2>Choose a channel</h2>
                <p>Streams load from the default public M3U playlist and play locally in this browser.</p>
                {hiddenChannelCount > 0 && (
                  <p className="muted">
                    {hiddenChannelCount.toLocaleString()} failed stream{hiddenChannelCount === 1 ? "" : "s"} marked for retry.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="now-playing">
            <ChannelLogo channel={selectedChannel} className="now-logo" loading="eager" />
            <div className="now-copy">
              <p className="eyebrow">Now playing</p>
              <h2>{selectedChannel?.name || "No channel selected"}</h2>
              {selectedChannel ? (
                <div className="tags">
                  {splitCategories(selectedChannel.category).map((category) => (
                    <span key={category}>{category}</span>
                  ))}
                  {selectedChannel.country && <span>{selectedChannel.country}</span>}
                  <span>HLS</span>
                  {useLocalProxy && <span>Local proxy</span>}
                  {selectedChannel.hasOverride && <span>Local override</span>}
                  {selectedChannel.sourceName && <span>{selectedChannel.sourceName}</span>}
                </div>
              ) : (
                <p className="muted">Select any channel from the browser to start playback.</p>
              )}
            </div>
            {selectedChannel && !selectedChannel.isCustom && (
              <button
                className={`favorite-large ${selectedIsFavorite ? "is-active" : ""}`}
                type="button"
                onClick={() => toggleFavorite(selectedChannel)}
                aria-label={selectedIsFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <Star size={22} fill={selectedIsFavorite ? "currentColor" : "none"} />
              </button>
            )}
          </div>

          {selectedChannel && (
            <div className="playback-controls" aria-label="Playback controls">
              <label className="quality-control">
                <span>Quality</span>
                <select
                  value={qualitySelection}
                  onChange={(event) => setQualitySelection(event.target.value)}
                >
                  <option value="auto">Optimize</option>
                  {qualityLevels.map((level) => (
                    <option key={level.index} value={String(level.index)}>
                      {level.label}
                    </option>
                  ))}
                </select>
              </label>

              <PlaybackStat label="Active" value={activeQualityLabel} />
              <PlaybackStat label="Buffer" value={formatSeconds(playbackStats.bufferAhead)} />
              <PlaybackStat label="Delay" value={formatSeconds(playbackStats.liveDelay)} />
              <button className="text-button" type="button" onClick={selectNextChannel}>
                <Play size={18} />
                Try next
              </button>
              <button
                className={`text-button ${autoSkipFailed ? "is-active" : ""}`}
                type="button"
                onClick={() => setAutoSkipFailed((value) => !value)}
              >
                <RefreshCcw size={18} />
                Auto-skip failed
              </button>
              <button
                className={`text-button ${useLocalProxy ? "is-active" : ""}`}
                type="button"
                onClick={() => setUseLocalProxy((value) => !value)}
                title="Route HLS through the localhost dev server for CORS-safe public stream testing."
              >
                <RefreshCcw size={18} />
                Local proxy
              </button>
              {selectedChannel.hasOverride && (
                <button className="text-button" type="button" onClick={removeSelectedOverride}>
                  <Trash2 size={18} />
                  Remove override
                </button>
              )}
            </div>
          )}

          <div className="source-panel">
            <span>Playlists</span>
            <div className="source-list">
              {PLAYLISTS.map((source) => (
                <code key={source.url}>
                  {source.name}: {source.url}
                </code>
              ))}
            </div>
            {playlistState.loadedAt && (
              <small>
                Loaded {playlistState.loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} from{" "}
                {playlistState.sourcesLoaded} source{playlistState.sourcesLoaded === 1 ? "" : "s"}.{" "}
                {playlistState.skippedUnsupported.toLocaleString()} non-HLS entries skipped,{" "}
                {playlistState.skippedDuplicates.toLocaleString()} duplicate HLS streams removed,{" "}
                {hiddenChannelCount.toLocaleString()} failed streams marked.
              </small>
            )}
            {playlistState.warning && <small className="warning-text">{playlistState.warning}</small>}
          </div>
        </section>
      </main>
    </div>
  );
}

function PlaybackStat({ label, value }) {
  return (
    <div className="playback-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ChannelCard({
  channel,
  isSelected,
  isFavorite,
  isUnavailable,
  onSelect,
  onFavorite,
  onDelete,
  onKeyDown,
  buttonRef,
}) {
  return (
    <article
      className={`channel-card ${isSelected ? "is-selected" : ""} ${
        isUnavailable ? "is-unavailable" : ""
      }`}
    >
      <button
        ref={buttonRef}
        className="channel-button"
        type="button"
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <ChannelLogo channel={channel} className="logo-tile" loading="eager" />
        <span className="channel-copy">
          <strong>{channel.name}</strong>
          <span>{formatChannelMeta(channel)}</span>
          {isUnavailable && <em>Previously failed. Select to retry.</em>}
        </span>
      </button>
      {onDelete ? (
        <button
          className="favorite-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          aria-label="Delete custom channel"
        >
          <Trash2 size={18} />
        </button>
      ) : (
        <button
          className={`favorite-button ${isFavorite ? "is-active" : ""}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onFavorite();
          }}
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <Star size={18} fill={isFavorite ? "currentColor" : "none"} />
        </button>
      )}
    </article>
  );
}

function ChannelLogo({ channel, className, loading = "lazy" }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const logoUrl = normalizeLogoUrl(channel?.logo);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [logoUrl]);

  if (!channel) {
    return (
      <span className={`${className} has-fallback`}>
        <Play size={className === "now-logo" ? 28 : 24} aria-hidden="true" />
      </span>
    );
  }

  const showImage = logoUrl && !failed;
  const showFallback = !showImage || !loaded;

  return (
    <span className={`${className} ${loaded && showImage ? "has-image" : "has-fallback"}`}>
      {showFallback && (
        <span className="logo-fallback" aria-hidden="true">
          {getChannelInitials(channel?.name)}
        </span>
      )}
      {showImage && (
        <img
          className={`logo-image ${loaded ? "is-loaded" : ""}`}
          src={logoUrl}
          alt=""
          loading={loading}
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function StateMessage({ icon, title, text }) {
  return (
    <div className="state-message">
      {icon}
      <strong>{title}</strong>
      {text && <span>{text}</span>}
    </div>
  );
}

function readStoredIds(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readStoredBoolean(key, fallback) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "null");
    return typeof parsed === "boolean" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readStoredChannels(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((channel) => channel?.id && channel?.url && channel?.isHls);
  } catch {
    return [];
  }
}

function readStoredOverrides(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "{}");

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, override]) => isDirectHlsUrl(override?.url))
        .map(([channelId, override]) => [
          channelId,
          {
            url: override.url.trim(),
            savedAt: override.savedAt || "",
          },
        ]),
    );
  } catch {
    return {};
  }
}

function applyChannelOverride(channel, overrides) {
  const override = overrides[channel.id];

  if (!isDirectHlsUrl(override?.url)) {
    return channel;
  }

  return {
    ...channel,
    url: override.url.trim(),
    originalUrl: channel.url,
    overrideUrl: override.url.trim(),
    hasOverride: true,
  };
}

function isDirectHlsUrl(url = "") {
  return /^https?:\/\//i.test(url.trim()) && /\.m3u8(\?|#|$)/i.test(url.trim());
}

function getPlaybackUrl(url, useLocalProxy) {
  if (!useLocalProxy || !isLocalHostPage()) {
    return url;
  }

  return `${HLS_PROXY_PATH}?url=${encodeURIComponent(url)}`;
}

function isLocalHostPage() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function splitCategories(category = "") {
  return category
    .split(/[;|/]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildOptions(values) {
  return [...new Set(values)]
    .filter(Boolean)
    .sort((first, second) => first.localeCompare(second));
}

function formatChannelMeta(channel) {
  const parts = [
    ...splitCategories(channel.category).slice(0, 2),
    channel.country,
    channel.hasOverride ? "Local override" : "",
    channel.sourceName,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "Public stream";
}

function normalizeLogoUrl(url = "") {
  const value = String(url).trim();

  if (!value || value.toLowerCase() === "undefined") {
    return "";
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  return value;
}

function getChannelInitials(name = "") {
  const words = String(name)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return "TV";
  }

  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

function findNextChannel(currentChannel, channelList) {
  const candidates = channelList.filter((channel) => channel.id !== currentChannel?.id);

  if (candidates.length === 0) {
    return null;
  }

  if (!currentChannel) {
    return candidates[0];
  }

  const currentIndex = channelList.findIndex((channel) => channel.id === currentChannel.id);

  if (currentIndex < 0) {
    return candidates[0];
  }

  return channelList[currentIndex + 1] || channelList[currentIndex - 1] || candidates[0];
}

function getNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.at(-2) || parts.at(-1) || "Custom HLS Stream";
  } catch {
    return "Custom HLS Stream";
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

function isSportsChannel(channel) {
  const categories = splitCategories(channel.category).map((category) => category.toLowerCase());
  const searchable = getChannelSearchText(channel);

  return categories.includes("sports") || /\bsports?\b/.test(searchable);
}

function isWorldCupCandidate(channel) {
  const searchable = getChannelSearchText(channel);
  const footballTerms = [
    "football",
    "futbol",
    "fútbol",
    "soccer",
    "fifa",
    "world cup",
    "mundial",
  ];

  return isSportsChannel(channel) || footballTerms.some((term) => searchable.includes(term));
}

function isBangladeshChannel(channel) {
  if (channel.countryCode === "BD" || channel.country === "Bangladesh") {
    return true;
  }

  const searchable = [
    channel.name,
    channel.category,
    channel.country,
    channel.countryCode,
    channel.tvgId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\bbangladesh\b/.test(searchable);
}

function isPakistanChannel(channel) {
  if (channel.countryCode === "PK" || channel.country === "Pakistan") {
    return true;
  }

  const searchable = [
    channel.name,
    channel.category,
    channel.country,
    channel.countryCode,
    channel.tvgId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\bpakistan\b/.test(searchable);
}

function getChannelSearchText(channel) {
  return [
    channel.name,
    channel.category,
    channel.country,
    channel.countryCode,
    channel.tvgId,
    channel.sourceName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function dedupeChannelsByUrl(channels) {
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

function createQualityLevels(levels = []) {
  return levels
    .map((level, index) => ({
      index,
      label: formatQualityLabel(level),
      height: level.height || 0,
      bitrate: level.bitrate || 0,
    }))
    .sort((first, second) => second.height - first.height || second.bitrate - first.bitrate);
}

function formatQualityLabel(level = {}) {
  const height = Number(level.height) || 0;
  const bitrate = Number(level.bitrate) || 0;
  let label = "Source";

  if (height >= 2160) {
    label = `4K (${height}p)`;
  } else if (height >= 1080) {
    label = `Full HD (${height}p)`;
  } else if (height >= 720) {
    label = `HD (${height}p)`;
  } else if (height > 0) {
    label = `${height}p`;
  } else if (bitrate > 0) {
    label = "Bitrate";
  }

  return bitrate > 0 ? `${label} / ${formatBitrate(bitrate)}` : label;
}

function formatBitrate(bitsPerSecond) {
  if (bitsPerSecond >= 1000000) {
    return `${(bitsPerSecond / 1000000).toFixed(1)} Mbps`;
  }

  return `${Math.round(bitsPerSecond / 1000)} Kbps`;
}

function applyQualitySelection(hls, selection) {
  if (!hls) {
    return;
  }

  if (selection === "auto") {
    hls.currentLevel = -1;
    hls.nextLevel = -1;
    return;
  }

  const levelIndex = Number(selection);

  if (Number.isInteger(levelIndex) && levelIndex >= 0) {
    hls.currentLevel = levelIndex;
  }
}

function getBufferAhead(video) {
  if (!video || !Number.isFinite(video.currentTime)) {
    return 0;
  }

  const currentTime = video.currentTime;

  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);

    if (currentTime >= start && currentTime <= end) {
      return Math.max(0, end - currentTime);
    }
  }

  return 0;
}

function getLiveDelay(hls) {
  if (!hls || !Number.isFinite(hls.latency)) {
    return null;
  }

  return hls.latency;
}

function formatSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "--";
  }

  return `${Math.round(value)}s`;
}
