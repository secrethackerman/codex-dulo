import {
    MemoryCacheService,
    ProviderRegistry
} from '@omss/framework';
import type { ProviderMediaObject, Source } from '@omss/framework';

// Static provider imports — required in CF Workers (no dynamic fs.readdir)
import { MovieDownloader } from './providers/02moviedownloader/02moviedownloader.js';
import { AnyEmbed } from './providers/anyembed/anyembed.js';
import { CineSuProvider } from './providers/cinesu/cinesu.js';
import { Fmovies4U } from './providers/fmovies4u/fmovies4u.js';
import { IcefyProvider } from './providers/icefy/icefy.js';
import { PeachifyProvider } from './providers/peachify/peachify.js';
import { PoprProvider } from './providers/popr/popr.js';
import { StreamMafiaProvider } from './providers/streammafia/streammafia.js';
import { VideasyProvider } from './providers/videasy/videasy.js';
import { VidNestProvider } from './providers/vidnest/vidnest.js';
import { VidRockProvider } from './providers/vidrock/vidrock.js';
import { VidSrcProvider } from './providers/vidsrc/vidsrc.js';
import { VidZeeProvider } from './providers/vidzee/vidzee.js';
import { VixSrcProvider } from './providers/vixsrc/vixsrc.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface Env {
    TMDB_API_KEY?: string;
    STREMIO_ADDON?: string;
    CORS_ORIGIN?: string;
}

// ── Singleton state (per-isolate, reused across requests) ────────────────────

let isInitialized = false;
let registry: ProviderRegistry;

function initServices() {
    if (isInitialized) return;

    registry = new ProviderRegistry({
        workers: 1, // worker_threads not supported in V8 isolates
        timeout: 15_000
    });

    // Register all providers
    registry.register(new MovieDownloader());
    registry.register(new AnyEmbed());
    registry.register(new CineSuProvider());
    registry.register(new Fmovies4U());
    registry.register(new IcefyProvider());
    registry.register(new PeachifyProvider());
    registry.register(new PoprProvider());
    registry.register(new StreamMafiaProvider());
    registry.register(new VideasyProvider());
    registry.register(new VidNestProvider());
    registry.register(new VidRockProvider());
    registry.register(new VidSrcProvider());
    registry.register(new VidZeeProvider());
    registry.register(new VixSrcProvider());

    isInitialized = true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsHeaders(origin = '*') {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, ETag'
    };
}

function json(data: unknown, status = 200, origin = '*'): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
    });
}

/**
 * Fan out to all providers and aggregate sources.
 * Providers are called directly — no TMDB dependency.
 */
async function getSources(media: ProviderMediaObject): Promise<Source[]> {
    const providers = registry.getProviders().filter((p) => {
        if (!p.enabled) return false;
        const type = media.type === 'movie' ? 'movies' : 'tv';
        return p.capabilities.supportedContentTypes.includes(type);
    });

    const results = await Promise.allSettled(
        providers.map((p) =>
            media.type === 'movie'
                ? p.getMovieSources(media)
                : p.getTVSources(media)
        )
    );

    const sources: Source[] = [];
    for (const r of results) {
        if (r.status === 'fulfilled') {
            sources.push(...(r.value.sources ?? []));
        }
    }
    return sources;
}

/**
 * Parse "tt1234567" or "1234567" from Stremio IDs.
 * Providers that need TMDB IDs handle conversion internally.
 */
function parseImdbId(raw: string): string {
    return raw.startsWith('tt') ? raw : `tt${raw}`;
}

/**
 * The framework's ProxyService.createProxyUrl() returns a bare relative path
 * like "/v1/proxy?data=...". In a CF Worker there is no implicit host, so we
 * must prepend the worker's own origin to make it an absolute URL that Stremio
 * (or any player) can actually fetch.
 */
function resolveStreamUrl(url: string, workerOrigin: string): string {
    if (!url) return url;
    
    // The @omss/framework hardcodes localhost in its ProxyService
    // We need to rewrite it to point to the CF Worker origin
    if (url.startsWith('http://localhost') && url.includes('/v1/proxy')) {
        const urlObj = new URL(url);
        return `${workerOrigin}${urlObj.pathname}${urlObj.search}`;
    }
    
    // Already absolute and not localhost — return as-is
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    
    // Relative proxy path produced by the framework → make it absolute
    return `${workerOrigin}${url.startsWith('/') ? '' : '/'}${url}`;
}

// ── Stremio manifest ──────────────────────────────────────────────────────────

const MANIFEST = {
    id: 'org.cinepro.worker',
    version: '1.0.0',
    name: 'CinePro [Worker]',
    description: 'CinePro multi-provider Stremio addon on Cloudflare Workers',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false }
};

// ── Request handler ───────────────────────────────────────────────────────────

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const workerOrigin = url.origin;
        const origin = env.CORS_ORIGIN ?? '*';

        // Pre-flight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        // Lazy init (once per isolate lifetime)
        initServices();

        const { pathname } = url;

        // ── Health / root ──────────────────────────────────────────────────
        if (pathname === '/' || pathname === '') {
            return new Response('CinePro Worker is running! 🚀', {
                headers: corsHeaders(origin)
            });
        }

        // ── Stream Player HTML ──────────────────────────────────────────────
        if (pathname === '/5') {
            return new Response(HTML_CONTENT, {
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    ...corsHeaders(origin)
                }
            });
        }

        // ── Stremio manifest ───────────────────────────────────────────────
        if (pathname === '/stremio/manifest.json' || pathname === '/manifest.json') {
            return json(MANIFEST, 200, origin);
        }

        // ── Movie streams ──────────────────────────────────────────────────
        // /stremio/stream/movie/tt1234567.json or /stream/movie/tt1234567.json
        const movieMatch = pathname.match(/^\/(?:stremio\/)?stream\/movie\/([^/]+)\.json$/);
        if (movieMatch) {
            const imdbId = parseImdbId(movieMatch[1]);
            try {
                const media: ProviderMediaObject = {
                    type: 'movie',
                    tmdbId: imdbId, // providers use imdbId as the lookup key
                    imdbId
                };
                const sources = await getSources(media);
                return json(
                    {
                        streams: sources.map((s: any) => ({
                            name: `CinePro [${s.provider?.name ?? 'Unknown'}]`,
                            title: `🎞️ ${s.quality ?? 'Auto'}`,
                            url: resolveStreamUrl(s.url, workerOrigin),
                            behaviorHints: {
                                bingeGroup: `cinepro-${s.provider?.name}-${s.quality}`
                            }
                        }))
                    },
                    200,
                    origin
                );
            } catch (err) {
                console.error('Movie stream error:', err);
                return json({ streams: [] }, 200, origin);
            }
        }

        // ── Series streams ─────────────────────────────────────────────────
        // /stremio/stream/series/tt1234567:1:2.json or /stream/series/tt1234567:1:2.json
        const seriesMatch = pathname.match(/^\/(?:stremio\/)?stream\/series\/([^/]+)\.json$/);
        if (seriesMatch) {
            const [rawId, s, e] = seriesMatch[1].split(':');
            if (!rawId || !s || !e) return json({ streams: [] }, 200, origin);

            const imdbId = parseImdbId(rawId);
            try {
                const media: ProviderMediaObject = {
                    type: 'tv',
                    tmdbId: imdbId,
                    imdbId,
                    s: Number(s),
                    e: Number(e)
                };
                const sources = await getSources(media);
                return json(
                    {
                        streams: sources.map((src: any) => ({
                            name: `CinePro [${src.provider?.name ?? 'Unknown'}]`,
                            title: `🎞️ ${src.quality ?? 'Auto'}`,
                            url: resolveStreamUrl(src.url, workerOrigin),
                            behaviorHints: {
                                bingeGroup: `cinepro-${src.provider?.name}-${src.quality}`
                            }
                        }))
                    },
                    200,
                    origin
                );
            } catch (err) {
                console.error('Series stream error:', err);
                return json({ streams: [] }, 200, origin);
            }
        }

        // ── Proxy route ────────────────────────────────────────────────────
        // /v1/proxy?data=<encodedJSON>  — forwards requests to upstream URLs
        if (pathname === '/v1/proxy') {
            const encodedData = url.searchParams.get('data');
            if (!encodedData) {
                return new Response('Missing data parameter', { status: 400, headers: corsHeaders(origin) });
            }
            try {
                const proxyData: { url: string; headers?: Record<string, string> } =
                    JSON.parse(decodeURIComponent(encodedData));
                if (!proxyData.url) throw new Error('Missing url');

                const upstreamHeaders: Record<string, string> = {
                    'User-Agent':
                        proxyData.headers?.['User-Agent'] ??
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    ...(proxyData.headers ?? {})
                };
                // Forward Range header if present (needed for video seeking)
                const rangeHeader = request.headers.get('Range');
                if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

                const upstreamResponse = await fetch(proxyData.url, {
                    method: 'GET',
                    headers: upstreamHeaders,
                    redirect: 'follow'
                });

                const responseHeaders: Record<string, string> = {
                    ...corsHeaders(origin),
                    'Content-Type':
                        upstreamResponse.headers.get('content-type') ?? 'application/octet-stream'
                };
                for (const h of [
                    'Content-Length',
                    'Content-Range',
                    'Accept-Ranges',
                    'Cache-Control',
                    'ETag',
                    'Last-Modified'
                ]) {
                    const v = upstreamResponse.headers.get(h);
                    if (v) responseHeaders[h] = v;
                }

                return new Response(upstreamResponse.body, {
                    status: upstreamResponse.status,
                    headers: responseHeaders
                });
            } catch (err) {
                console.error('Proxy error:', err);
                return new Response('Proxy error', { status: 502, headers: corsHeaders(origin) });
            }
        }

        return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
    }
};

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stream Player</title>
    <script src="https://content.jwplatform.com/libraries/hDZaZjnc.js"></script>
    <style>
        body {
            background-color: #000;
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            font-family: sans-serif;
            overflow: hidden;
        }
        #player-wrapper {
            width: 100%;
            max-width: 960px;
        }
        .jw-logo, 
        .jw-watermark, 
        .jw-rightclick-logo,
        .jw-button-container .jw-logo-button {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
        }
        #loading-gif {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 100vw;
            z-index: 9999;
            pointer-events: none;
        }
    </style>
</head>
<body>

    <img id="loading-gif" src="https://i.postimg.cc/x8p5GsbF/Loading.gif" />

    <div id="player-wrapper">
        <div id="my-player"></div>
    </div>

    <script type="text/javascript">
        const final_urll = (() => {
            var raw = window.location.hash.replace("#", "");
            var parts = raw.split("/");
            var type = parts[0] === "tv" ? "series" : parts[0];
            var id = parts[1] || "";
            var season = parts[2];
            var episode = parts[3];
            if (!id) return "";
            if (type === "movie") {
                return window.location.origin + "/stream/movie/" + id + ".json";
            } else {
                return window.location.origin + "/stream/series/" + id + ":" + season + ":" + episode + ".json";
            }
        })();

        function removeLoadingGif() {
            var gif = document.getElementById('loading-gif');
            if (gif) {
                gif.style.display = 'none';
            }
        }

        var WYZIE_API_KEY = "wyzie-7b44a4d0d92d7b5e13efca4a53080b19"; 

        function parseHash() {
            var raw   = window.location.hash.replace("#", "");
            var parts = raw.split("/");
            return {
                type:    parts[0], 
                tmdbId:  parts[1] || null,
                season:  parts[2] || null,
                episode: parts[3] || null
            };
        }

        async function fetchSubtitles() {
            var info = parseHash();
            if (!info.tmdbId) return [];

            var params = new URLSearchParams({
                id:     info.tmdbId,  
                format: "srt,vtt",    
                source: "all",        
                key:    WYZIE_API_KEY
            });

            if (info.type === "tv" && info.season && info.episode) {
                params.set("season",  info.season);
                params.set("episode", info.episode);
            }

            try {
                var res = await fetch("https://sub.wyzie.io/search?" + params.toString());
                if (!res.ok) return [];

                var items = await res.json();
                if (!Array.isArray(items) || items.length === 0) return [];

                var byLang = {};
                items.forEach(function(item) {
                    var lang = item.language;
                    if (!lang || !item.url) return;
                    var existing = byLang[lang];
                    var betterFormat = item.format === "vtt" && (!existing || existing.format !== "vtt");
                    var moreDownloads = !betterFormat && (!existing || (item.downloadCount || 0) > (existing.downloadCount || 0));
                    if (!existing || betterFormat || moreDownloads) {
                        byLang[lang] = item;
                    }
                });

                var tracks = [];
                var isDefault = true;

                for (var lang in byLang) {
                    var sub = byLang[lang];
                    tracks.push({
                        file:      sub.url,
                        label:     sub.display || lang,
                        kind:      "captions",
                        "default": isDefault
                    });
                    isDefault = false;
                }

                return tracks;

            } catch(err) {
                console.warn("Wyzie Subs fetch error:", err);
                return [];
            }
        }

        window.addEventListener('message', function(event) {
            if (!event.data) return;

            if (event.data.type === 'apiGetWatchTimes') {
                var watchTimes = {};
                for (var i = 0; i < localStorage.length; i++) {
                    var key = localStorage.key(i);
                    if (key && key.startsWith('#')) {
                        watchTimes[key] = parseFloat(localStorage.getItem(key));
                    }
                }
                event.source.postMessage({ type: 'watchTimesResponse', watchTimes: watchTimes }, event.origin);
            }

            if (event.data.type === 'seekTo') {
                var seconds = parseFloat(event.data.seconds);
                if (!isNaN(seconds)) {
                    var player = jwplayer("my-player");
                    if (player && typeof player.seek === 'function') {
                        player.seek(seconds);
                    }
                }
            }
        });

        var jwDefaults = {
            "aboutlink": "", 
            "abouttext": "",
            "aspectratio": "16:9",
            "autostart": false,
            "controls": true,
            "displaydescription": false,
            "displaytitle": false,
            "height": 260,
            "key": "o1aKtlYdYI2llgu/6IMNmcEjWjum4eDR3q3+F/EE2gNzepJWQUAb/YABcVugVUdl",
            "logo": {
                "file": "",      
                "hide": true,    
                "link": ""       
            },
            "mute": false,       
            "ph": 1,
            "pid": "hDZaZjnc",
            "playbackRateControls": [0.5, 1, 1.25, 1.5, 2], 
            "preload": "metadata",
            "repeat": false,
            "stretching": "uniform",
            "width": "100%"
        };

        jwplayer.defaults = jwDefaults;

        var jsonUrl = final_urll;

        if (jsonUrl) {
            Promise.all([
                fetch(jsonUrl).then(function(r) { return r.json(); }),
                fetchSubtitles()
            ])
            .then(function(results) {
                var data   = results[0];
                var tracks = results[1]; 

                var streams = data.streams || [];
                var hashParts = window.location.hash.split('/');
                var isTvHash = window.location.hash.indexOf('tv') !== -1 || window.location.hash.indexOf('series') !== -1;
                var sourceKey = '!' + (isTvHash ? hashParts.slice(0, 2).join('/') : window.location.hash);
                var lastWorkingName = localStorage.getItem(sourceKey);

                if (lastWorkingName && streams.length > 1) {
                    var preferredIndex = streams.findIndex(function(s) {
                        return (s.name || s.title) === lastWorkingName;
                    });
                    if (preferredIndex > 0) {
                        var preferred = streams.splice(preferredIndex, 1)[0];
                        streams.unshift(preferred);
                    }
                }

                var currentStreamIndex = 0;

                function tryNextStream() {
                    if (currentStreamIndex >= streams.length) {
                        removeLoadingGif();
                        return;
                    }

                    var stream = streams[currentStreamIndex];
                    var streamUrl = stream.url;
                    var streamType = "mp4"; 

                    if (streamUrl.indexOf("m3u8") !== -1 || decodeURIComponent(streamUrl).indexOf("m3u8") !== -1) {
                        streamType = "hls";
                    }

                    var playlistItem = {
                        "title": stream.name || stream.title,
                        "file":  streamUrl,
                        "type":  streamType
                    };
                    if (tracks && tracks.length > 0) {
                        playlistItem.tracks = tracks;
                    }

                    var playerInstance = jwplayer("my-player").setup({
                        "playlist": [playlistItem]
                    });

                    playerInstance.on('ready', removeLoadingGif);

                    var isTvShow = window.location.hash.indexOf("tv") !== -1 || window.location.hash.indexOf("series") !== -1 || window.location.hash.split("/").length > 2;
                    var messageSent = false;
                    var hasSeeked = false;

                    playerInstance.on('firstFrame', function() {
                        localStorage.setItem(sourceKey, stream.name || stream.title);

                        var savedTime = localStorage.getItem(window.location.hash);
                        if (savedTime && !hasSeeked) {
                            playerInstance.seek(parseFloat(savedTime));
                            hasSeeked = true;
                        }
                    });

                    playerInstance.on('time', function(e) {
                        window.parent.postMessage({ type: 'currentTime', seconds: e.position }, '*');

                        if (isTvShow && !messageSent && e.duration > 0) {
                            if (e.duration - e.position <= 60) {
                                window.parent.postMessage({ type: 'episodeAlmostOver', hash: window.location.hash }, '*');
                                messageSent = true;
                            }
                        }
                    });

                    playerInstance.on('error', function(e) {
                        console.error("Player Error Code: " + e.code);
                        console.error("Message: " + e.message);
                        currentStreamIndex++;
                        tryNextStream();
                    });

                    playerInstance.on('setupError', function(e) {
                        console.error("Player Error Code: " + e.code);
                        console.error("Message: " + e.message);
                        currentStreamIndex++;
                        tryNextStream();
                    });
                }

                if (streams.length > 0) {
                    tryNextStream();
                } else {
                    removeLoadingGif();
                }
            })
            .catch(function(err) {
                removeLoadingGif();
                console.error(err);
            });
        } else {
            var playerInstance = jwplayer("my-player").setup({
                "playlist": [{
                    "title": "REPLACE_ME",
                    "file": "REPLACE_ME",
                    "type": "mp4" 
                }]
            });
            
            playerInstance.on('ready', removeLoadingGif);

            playerInstance.on('error', function(e) {
                console.error("Player Error Code: " + e.code);
                console.error("Message: " + e.message);
            });
        }

        setInterval(function() {
            var player = jwplayer("my-player");
            if (player && typeof player.getState === 'function' && player.getState() === 'playing') {
                localStorage.setItem(window.location.hash, player.getPosition());
            }
        }, 2000);
    </script>

</body>
</html>\`;
