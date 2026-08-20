import { buildMapActionButtons, getAppleMapsLink, getGoogleMapsLink, installMapActionHandlers } from "../shared/map-actions.js";

declare global {
  interface Window {
    CensusMapActions: { getGoogleMapsLink: typeof getGoogleMapsLink; getAppleMapsLink: typeof getAppleMapsLink; buildMapActionButtons: typeof buildMapActionButtons };
  }
}

installMapActionHandlers();
window.CensusMapActions = { getGoogleMapsLink, getAppleMapsLink, buildMapActionButtons };
