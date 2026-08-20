import * as regionClient from "../shared/region-client.js";

declare global {
  interface Window {
    CensusMapRegion: typeof regionClient;
  }
}

window.CensusMapRegion = regionClient;
