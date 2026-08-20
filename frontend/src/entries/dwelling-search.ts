import * as dwellingSearch from "../shared/dwelling-search.js";

declare global { interface Window { CensusMapDwellingSearch: typeof dwellingSearch; } }

window.CensusMapDwellingSearch = dwellingSearch;
