import * as mapData from "../shared/map-data.js";

declare global {
  interface Window {
    CensusMapData: typeof mapData;
  }
}

window.CensusMapData = mapData;
