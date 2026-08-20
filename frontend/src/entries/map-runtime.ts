import * as mapRuntime from "../shared/map-runtime.js";

declare global { interface Window { CensusMapRuntime: typeof mapRuntime; } }

window.CensusMapRuntime = mapRuntime;
