(function initMapDataHelpers() {
  function isNonEmpty(value) {
    return value !== undefined && value !== null && String(value).trim().length > 0;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function isPolygonGeometry(geometry) {
    return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
  }

  function isPointGeometry(geometry) {
    return geometry?.type === "Point";
  }

  function hasDwellingIdentifier(props) {
    return isNonEmpty(props?.dwellingNo) || isNonEmpty(props?.DWELLING_NO) || isNonEmpty(props?.vrNumber) || isNonEmpty(props?.VR_NUMBER);
  }

  function getZoneKind(props) {
    if (!props || typeof props !== "object") return "";
    const group = String(props._group || "").trim().toLowerCase();
    if (group === "cu" || group === "cus") return "cu";
    if (group === "blocks" || group === "block") return "block";
    if (isNonEmpty(props.COLB_UID) || isNonEmpty(props.CB_COLCODE)) return "block";
    if (isNonEmpty(props.CU_TYPE) || isNonEmpty(props.CUID) || isNonEmpty(props.cu)) return "cu";
    return "";
  }

  function isZoneFeature(feature) {
    const props = feature?.properties || {};
    const geometry = feature?.geometry || {};
    return isPolygonGeometry(geometry) && (getZoneKind(props) === "cu" || getZoneKind(props) === "block");
  }

  function isHiddenBlock(props) {
    if (getZoneKind(props) !== "block") return false;
    const value = props?.hidden;
    return value === true || value === 1 || String(value || "").trim().toLowerCase() === "true";
  }

  function isDwellingFeature(props, geometry) {
    if (!props || typeof props !== "object") return false;
    if (!isPointGeometry(geometry)) return false;
    const group = String(props._group || "").trim().toLowerCase();
    if (group === "special_locations") return false;
    if (group === "dwellings" || group === "dwelling") return true;
    return hasDwellingIdentifier(props);
  }

  function isSpecialLocationFeature(props, geometry) {
    return isPointGeometry(geometry) && String(props?._group || "").trim().toLowerCase() === "special_locations";
  }

  function extractCuCode(props) {
    if (isNonEmpty(props?.CUID)) return String(props.CUID).trim();
    if (isNonEmpty(props?.cu)) return String(props.cu).trim();
    if (isNonEmpty(props?.name)) return String(props.name).split("/")[0].trim();
    if (isNonEmpty(props?.label)) return String(props.label).split("/")[0].trim();
    return "UNKNOWN";
  }

  function hashText(value) {
    const text = String(value || "");
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return hash;
  }

  function buildColorMap(cuCodes) {
    const unique = [...new Set(cuCodes)].sort();
    const colors = new Map();
    const variants = [
      { strokeS: 78, strokeL: 28, fillS: 82, fillL: 52 },
      { strokeS: 72, strokeL: 34, fillS: 76, fillL: 60 },
      { strokeS: 86, strokeL: 24, fillS: 88, fillL: 48 },
      { strokeS: 68, strokeL: 30, fillS: 72, fillL: 56 }
    ];
    for (let index = 0; index < unique.length; index += 1) {
      const code = unique[index];
      const seed = hashText(code);
      const orderHue = (index * 137.508) % 360;
      const hue = Math.round((orderHue + (seed % 31) - 15 + 360) % 360);
      const variant = variants[seed % variants.length];
      colors.set(code, {
        stroke: `hsl(${hue} ${variant.strokeS}% ${variant.strokeL}%)`,
        fill: `hsl(${hue} ${variant.fillS}% ${variant.fillL}%)`
      });
    }
    return colors;
  }

  window.CensusMapData = {
    isNonEmpty,
    escapeHtml,
    isPolygonGeometry,
    isPointGeometry,
    hasDwellingIdentifier,
    getZoneKind,
    isZoneFeature,
    isHiddenBlock,
    isDwellingFeature,
    isSpecialLocationFeature,
    extractCuCode,
    hashText,
    buildColorMap
  };
})();
