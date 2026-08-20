import * as offlineData from "../shared/offline-data.js";

declare global {
  interface Window {
    CldOfflineStore: typeof offlineData;
  }
}

window.CldOfflineStore = offlineData;
