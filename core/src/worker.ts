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

        // ── Stremio manifest ───────────────────────────────────────────────
        if (pathname === '/stremio/manifest.json') {
            return json(MANIFEST, 200, origin);
        }

        // ── Movie streams ──────────────────────────────────────────────────
        // /stremio/stream/movie/tt1234567.json
        const movieMatch = pathname.match(/^\/stremio\/stream\/movie\/([^/]+)\.json$/);
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
                            url: s.url,
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
        // /stremio/stream/series/tt1234567:1:2.json
        const seriesMatch = pathname.match(/^\/stremio\/stream\/series\/([^/]+)\.json$/);
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
                            url: src.url,
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

        return new Response('Not Found', { status: 404, headers: corsHeaders(origin) });
    }
};
