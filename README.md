# Local IPTV Lab

Local IPTV Lab is a browser-only React app for testing free/public legal M3U streams. It ships with five default public playlist sources:

- https://iptv-org.github.io/iptv/index.m3u
- https://iptv-org.github.io/iptv/categories/sports.m3u
- https://iptv-org.github.io/iptv/countries/pk.m3u
- https://iptv-org.github.io/iptv/countries/bd.m3u
- https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8

The app runs on localhost, fetches the playlists directly in the browser, parses M3U channel metadata, merges duplicate stream URLs, filters to playable HLS `.m3u8` streams, and plays them with HLS.js.

## Features

- Local-only Vite dev server bound to `127.0.0.1`
- Public/legal default M3U playlists from iptv-org and Free-TV
- Channel list with names, logos, category, and country metadata when available
- Logo tiles use no-referrer image loading and fall back to channel initials when public logo URLs are missing or blocked
- Non-HLS playlist entries are skipped so unsupported web links do not appear as playable channels
- Dead, blocked, or unreachable HLS streams are marked after a failed retry, stay visible, and can be retried from the list
- Auto-skip failed playback so the player can move through the current filtered list until it finds a working stream
- `Try next` control for manually jumping to the next channel in the current filter
- Custom HLS tester for saving and playing direct `.m3u8` URLs you are allowed to use
- Separate `Custom` tab for saved local channels, with delete controls
- Sports, World Cup, Pakistan, and Bangladesh focus buttons for quickly narrowing the channel list
- Search, category filter, country filter, and favorites-only filter
- Favorites saved in `localStorage`
- HLS.js playback for `.m3u8` streams
- Quality selector with `Optimize` adaptive mode and fixed levels such as `144p`, `HD`, or `4K` when the stream advertises them
- Buffer-ahead and live-delay readouts for the current stream
- Loading, empty, and error states
- Responsive TV-style layout for desktop and large-screen browsers
- Keyboard/remote-friendly channel navigation with arrow keys, Home, End, and Enter

## Setup

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

The dev server is configured to bind only to `127.0.0.1`. It is not exposed to other devices on your network. If `5173` is already in use, Vite will print the next available localhost URL in the terminal.

## Notes

- This project intentionally includes no premium, paid, or pirated IPTV sources.
- Some public streams may be offline, geo-restricted, or blocked by browser CORS rules.
- Only HLS `.m3u8` streams are supported by the player.
- The Free-TV raw GitHub URL is a playlist file. It also contains some website links such as YouTube/Twitch pages, which are skipped because they are not direct HLS streams.
- Public HLS links can go offline or become geo-blocked. The app marks failed streams locally after playback failure; they stay visible with a retry badge, and `Clear failed marks` resets those labels.
- The Sports and World Cup filters only surface public streams from the included legal playlists. They do not bypass broadcast rights and do not guarantee official match coverage in your country.
- During popular matches, public streams may fail from traffic, capacity limits, geo-blocking, or rights enforcement. Use official legal broadcasters/apps for reliable live match coverage.
- Saved custom channels are stored only in your browser `localStorage`.
- The custom HLS tester does not bypass access controls. Browser playback still requires the stream server to allow CORS and direct HLS segment access from localhost.
- Live HLS playback normally has delay because the browser buffers media segments. The exact delay is controlled by the stream provider and network conditions.
