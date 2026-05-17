import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult,
    Source,
    SourceType,
    Subtitle
} from '@omss/framework';
import { VidnestResponse } from './popr.types.js';

export class PoprProvider extends BaseProvider {
    readonly id = 'popr';
    readonly name = 'Popr';
    readonly enabled = true;
    readonly BASE_URL = 'https://popr.ink';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: `${this.BASE_URL}/`
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    /**
     * Fetch movie sources
     */
    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            let movieSource = await this.fetchSource(media, 'movie');

            return {
                sources: movieSource.sources,
                subtitles: movieSource.subtitles,
                diagnostics: []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error
                    ? error.message
                    : 'error at getting source',
                media
            );
        }
    }

    /**
     * Fetch TV episode sources
     */
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            let tvSource = await this.fetchSource(media, 'tv');

            return {
                sources: tvSource.sources,
                subtitles: tvSource.subtitles,
                diagnostics: []
            };
        } catch (error) {
            return this.emptyResult(
                error instanceof Error
                    ? error.message
                    : 'error at getting source',
                media
            );
        }
    }

    // https://popr.ink/api/vidnest?id=262848&type=tv&server=catflix&season=1&episode=1
    private async fetchSource(
        media: ProviderMediaObject,
        type: 'tv' | 'movie' = 'movie'
    ): Promise<{ sources: Source[]; subtitles: Subtitle[] }> {
        const servers = [
            'default',
            'catflix',
            'hexa',
            'Gama',
            'Liligoon',
            'Sigma',
            'Prime',
            'Alfa',
            'Lamda',
            'ynx_vidsrc'
        ];

        const ep = media.e || 1;
        const season = media.s || 1;

        const buildUrl = (server: string) => {
            if (type === 'tv') {
                return `${this.BASE_URL}/api/vidnest?id=${media.tmdbId}&type=tv&server=${server}&season=${season}&episode=${ep}`;
            }
            return (
                `${this.BASE_URL}/api/vidnest?id=${media.tmdbId}&type=movie` +
                (server !== 'default' ? `&server=${server}` : '')
            );
        };

        const requests = servers.map(
            (server) =>
                fetch(buildUrl(server), {
                    headers: this.HEADERS
                })
                    .then(async (res) => {
                        if (res.status !== 200) return null;
                        const data = (await res.json()) as VidnestResponse;
                        const stream = data?.results?.[0]?.streams?.[0];
                        if (!stream?.url) return null;

                        const ext = (new URL(stream.url).pathname.match(
                            /\.[^./]+$/
                        ) || [''])[0];

                        const quality = stream.quality;
                        const INVALID_QUALITIES = ['Hindi', 'English', 'MAIN'];
                        const QUALITIES = ['Hindi', 'English'];
                        const languages = QUALITIES.includes(quality);

                        return {
                            source: {
                                url: this.createProxyUrl(
                                    stream.url,
                                    stream.headers
                                ),
                                type: (ext === '.m3u8'
                                    ? 'hls'
                                    : 'mp4') as SourceType,
                                quality: INVALID_QUALITIES.includes(quality)
                                    ? 'auto'
                                    : quality || 'auto',
                                audioTracks: [
                                    {
                                        language: languages
                                            ? quality.toLowerCase().slice(0, 3)
                                            : 'eng',
                                        label: languages ? quality : 'English'
                                    }
                                ],
                                provider: { name: this.name, id: this.id }
                            },
                            subtitles: data.results?.[0]?.subtitles || []
                        };
                    })
                    .catch(() => null) // swallow per-request errors
        );

        const results = await Promise.allSettled(requests);

        const sources: Source[] = [];
        const subtitlesMap = new Map<string, Subtitle>();

        for (const res of results) {
            if (res.status !== 'fulfilled' || !res.value) continue;

            sources.push(res.value.source);

            for (const sub of res.value.subtitles) {
                if (!sub?.url) continue;

                // dedupe subtitles by URL
                if (!subtitlesMap.has(sub.url)) {
                    subtitlesMap.set(sub.url, {
                        url: this.createProxyUrl(sub.url),
                        format: 'vtt',
                        label: sub.lang || 'Unknown'
                    });
                }
            }
        }

        return {
            sources,
            subtitles: Array.from(subtitlesMap.values())
        };
    }

    private emptyResult(
        message: string,
        media: ProviderMediaObject
    ): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ]
        };
    }
    /**
     * Health check
     */
    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }
}
