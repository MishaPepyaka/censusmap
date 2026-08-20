export const bufferedTileSources = {
  satellite: {
    maxZoom: 22,
    // ArcGIS tile URLs are level/row/column: z/y/x (unlike common z/x/y templates).
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
  },
  schematic: {
    maxZoom: 19,
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
  }
};

export function registerTileRoutes(app, { arcgisCookie, extractProxyTargetUrl, mapConfig, tileProxyUserAgent }) {
  app.get("/api/arcgis-proxy*", async (req, res) => {
    const targetUrl = extractProxyTargetUrl(req);
    if (!targetUrl) return res.status(400).json({ error: "Proxy target URL is required" });
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return res.status(400).json({ error: "Invalid target URL" });
    }

    const allowedHosts = new Set(["geoprod.statcan.gc.ca", "geo.statcan.gc.ca"]);
    if (mapConfig.cmp.arcgis.url) {
      try {
        allowedHosts.add(new URL(mapConfig.cmp.arcgis.url).hostname);
      } catch {
        // Invalid configured hosts are ignored rather than added to the allowlist.
      }
    }
    if (!allowedHosts.has(parsed.hostname)) return res.status(403).json({ error: "Target host is not allowed" });

    const upstreamHeaders = {
      "user-agent": req.headers["user-agent"] || "selfhost-map-cmp-proxy/1.0",
      accept: req.headers.accept || "*/*"
    };
    if (arcgisCookie) upstreamHeaders.cookie = arcgisCookie;

    try {
      const upstream = await fetch(targetUrl, { method: "GET", headers: upstreamHeaders });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);
      const cacheControl = upstream.headers.get("cache-control");
      if (cacheControl) res.setHeader("cache-control", cacheControl);
      return res.status(upstream.status).send(buffer);
    } catch (error) {
      return res.status(502).json({ error: `Proxy request failed: ${error.message}` });
    }
  });

  app.get("/tiles/:source/:z/:y/:x", async (req, res) => {
    const source = bufferedTileSources[req.params.source];
    const z = Number(req.params.z);
    const y = Number(req.params.y);
    const x = Number(req.params.x);
    const tileCount = Number.isInteger(z) && z >= 0 && z <= 30 ? 2 ** z : 0;
    if (!source || !Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)
      || z < 0 || z > source.maxZoom || x < 0 || y < 0 || x >= tileCount || y >= tileCount) {
      return res.status(400).json({ error: "Invalid tile coordinates" });
    }

    const targetUrl = source.url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    const upstreamHeaders = {
      "user-agent": tileProxyUserAgent || "CensusMap/1.0 (self-hosted map tile proxy)",
      accept: req.headers.accept || "image/avif,image/webp,image/png,image/*,*/*;q=0.8"
    };
    if (req.headers.referer) upstreamHeaders.referer = req.headers.referer;

    try {
      const upstream = await fetch(targetUrl, { method: "GET", headers: upstreamHeaders });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type");
      if (contentType) res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "public, max-age=604800");
      return res.status(upstream.status).send(buffer);
    } catch (error) {
      return res.status(502).json({ error: `Tile request failed: ${error.message}` });
    }
  });
}
