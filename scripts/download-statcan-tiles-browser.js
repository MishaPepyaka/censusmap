/*
  Run in Chrome DevTools Console on:
  https://geoprod.statcan.gc.ca/camv1/index.html?language=en

  It uses your active browser session/cookies and downloads tiles into
  a folder selected via File System Access API.
*/

(async () => {
  const bbox = {
    minLon: -98.083805,
    maxLon: -97.646201,
    minLat: 53.86463,
    maxLat: 54.139945
  };

  const minZoom = 10;
  const maxZoom = 14;
  const concurrency = 8;
  const retries = 3;

  function lonLatToTile(lon, lat, z) {
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x, y };
  }

  const jobs = [];
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const nw = lonLatToTile(bbox.minLon, bbox.maxLat, z);
    const se = lonLatToTile(bbox.maxLon, bbox.minLat, z);
    const minX = Math.min(nw.x, se.x);
    const maxX = Math.max(nw.x, se.x);
    const minY = Math.min(nw.y, se.y);
    const maxY = Math.max(nw.y, se.y);

    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const url =
          "https://geoprod.statcan.gc.ca/camv1/proxy.ashx?" +
          "https://geoprod.statcan.gc.ca/geo_wa/rest/services/BASEMAP_202506_EN_Z00_13/MapServer/tile/" +
          z +
          "/" +
          y +
          "/" +
          x;
        jobs.push({ z, x, y, url });
      }
    }
  }

  console.log("Tiles to download:", jobs.length);
  const root = await window.showDirectoryPicker({ mode: "readwrite" });

  async function saveTile(job, blob) {
    const zDir = await root.getDirectoryHandle(String(job.z), { create: true });
    const xDir = await zDir.getDirectoryHandle(String(job.x), { create: true });
    const file = await xDir.getFileHandle(String(job.y) + ".png", { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  let done = 0;
  let fail = 0;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const i = idx;
      idx += 1;
      const job = jobs[i];
      let ok = false;

      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const res = await fetch(job.url, {
            credentials: "include",
            cache: "no-store"
          });
          if (!res.ok) {
            throw new Error("HTTP " + res.status);
          }
          const blob = await res.blob();
          if (!blob.type.includes("image")) {
            throw new Error("Unexpected content type: " + blob.type);
          }
          await saveTile(job, blob);
          ok = true;
          break;
        } catch (error) {
          if (attempt === retries) {
            console.warn("Failed tile", job, error.message);
          }
        }
      }

      if (ok) {
        done += 1;
      } else {
        fail += 1;
      }

      const processed = done + fail;
      if (processed % 25 === 0) {
        console.log("Progress:", processed + "/" + jobs.length, "ok=" + done, "fail=" + fail);
      }
    }
  }

  const pool = [];
  for (let i = 0; i < concurrency; i += 1) {
    pool.push(worker());
  }
  await Promise.all(pool);

  console.log("Finished", { done, fail, total: jobs.length });
})();
