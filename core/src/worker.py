from js import Response, Object, console
import json
from services import initServices, sourceService

async def on_fetch(request, env):
    try:
        # Initialize OMSS services using the JS function
        await initServices(env)
    except Exception as e:
        console.error(f"Error initializing services: {e}")

    url = request.url
    path = url.split("/", 3)[-1] if url.startswith("http") else url
    
    if path == "" or path.endswith("/"):
        return Response.new("CinePro Worker is running! (Python Pyodide)")
        
    elif "stremio/manifest.json" in path or path == "manifest.json":
        manifest_data = {
            "id": "org.cinepro.worker",
            "version": "1.0.0",
            "name": "CinePro [Worker]",
            "description": "CinePro multi-provider stremio addon hosted on Cloudflare Workers (Python)",
            "resources": ["stream"],
            "types": ["movie", "series"],
            "idPrefixes": ["tt"],
            "catalogs": [],
            "behaviorHints": {
                "configurable": True,
                "configurationRequired": False
            }
        }
        return Response.new(
            json.dumps(manifest_data),
            headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}
        )
        
    elif "stremio/stream/movie/" in path or path.startswith("stream/movie/"):
        id_part = path.split("/")[-1].replace(".json", "")
        try:
            result = await sourceService.getMovieSources(id_part)
            streams = []
            for s in result.sources:
                streams.append({
                    "name": f"CinePro [{s.provider.name}]",
                    "title": f"{s.quality}\n{s.url[:50]}...",
                    "url": s.url,
                    "behaviorHints": {
                        "bingeGroup": f"cinepro-{s.provider.name}-{s.quality}"
                    }
                })
            return Response.new(
                json.dumps({"streams": streams}),
                headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}
            )
        except Exception as err:
            console.error(f"Error fetching movie streams: {err}")
            return Response.new(json.dumps({"streams": []}), headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
            
    elif "stremio/stream/series/" in path or path.startswith("stream/series/"):
        id_part = path.split("/")[-1].replace(".json", "")
        parts = id_part.split(':')
        if len(parts) == 3:
            imdb_id, s, e = parts
            try:
                result = await sourceService.getTVSources(imdb_id, int(s), int(e))
                streams = []
                for source in result.sources:
                    streams.append({
                        "name": f"CinePro [{source.provider.name}]",
                        "title": f"{source.quality}\n{source.url[:50]}...",
                        "url": source.url,
                        "behaviorHints": {
                            "bingeGroup": f"cinepro-{source.provider.name}-{source.quality}"
                        }
                    })
                return Response.new(
                    json.dumps({"streams": streams}),
                    headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"}
                )
            except Exception as err:
                console.error(f"Error fetching series streams: {err}")
        return Response.new(json.dumps({"streams": []}), headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
        
    return Response.new("Not Found", status=404)
