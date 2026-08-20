import { getJson, getJsonWithTimeout } from "../shared/api.js";

declare global {
  interface Window {
    CensusMapApi: { getJson: typeof getJson; getJsonWithTimeout: typeof getJsonWithTimeout };
  }
}

window.CensusMapApi = { getJson, getJsonWithTimeout };
