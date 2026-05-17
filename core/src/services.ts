// Services initialized for Python interop

import { MemoryCacheService } from '@omss/framework/dist/core/cache.js';
import { ProviderRegistry } from '@omss/framework/dist/providers/provider-registry.js';
import { SourceService } from '@omss/framework/dist/services/source.service.js';
import { ProxyService } from '@omss/framework/dist/services/proxy.service.js';
import { TMDBService } from '@omss/framework/dist/services/tmdb.service.js';
import { StremioService } from '@omss/framework/dist/services/stremio.service.js';

import { knownThirdPartyProxies } from './thirdPartyProxies.js';
import { streamPatterns } from './streamPatterns.js';

// Import all providers statically
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

// Global singletons for the worker isolate
let isInitialized = false;
let registry: ProviderRegistry;
let sourceService: SourceService;
let proxyService: ProxyService;

async function initServices(env: any) {
  if (isInitialized) return;
  
  const cache = new MemoryCacheService();
  registry = new ProviderRegistry({
    workers: 1, // V8 Isolates do not support node worker_threads natively
    timeout: 15000
  });

  const tmdbApiKey = env.TMDB_API_KEY || 'dummy-key';
  const tmdbService = new TMDBService(tmdbApiKey, cache, 86400);
  
  proxyService = new ProxyService(cache, {
    knownThirdPartyProxies,
    streamPatterns
  });
  
  const stremioService = new StremioService([], proxyService);

  sourceService = new SourceService(registry, cache, tmdbService, stremioService, {
    sources: 3600,
    subtitles: 86400
  });

  // Register all statically imported providers
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

export { initServices, sourceService };
