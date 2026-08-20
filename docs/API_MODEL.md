# Region API Model

## Canonical Region Feature

All region write endpoints accept a GeoJSON `Feature`. At the backend boundary,
legacy attributes are preserved and canonical attributes are added before data is
validated and persisted.

| Canonical property | Meaning | Accepted legacy input |
| --- | --- | --- |
| `cu` | CU identifier | `CUID`, `cu`, first segment of `name`/`label` |
| `block` | Two-digit block identifier | `block`, `CB_COLCODE`, `GEOCODE`, second `name` segment |
| `dwellingNo` | Four-digit dwelling identifier | `DWELLING_NO`, `vrNumber`, `VR_NUMBER` |
| `status` | Dwelling status code | Existing `status`; invalid supplied values become `429` |
| `_group` | `cu`, `blocks`, `dwellings`, or `special_locations` | Singular `cu`, `block`, `dwelling` forms are normalised |

`special_locations` use point geometry and are stored alongside dwellings, but
do not require a dwelling identity.

## Validation Rules

1. Region writes support Point, Polygon, and MultiPolygon GeoJSON only.
2. Every coordinate must be a finite WGS84 longitude/latitude pair.
3. The feature must be classifiable as CU, block, or dwelling/special location.
4. If the input includes a CLD property (`cld`, `CLD`, `CFOP_CLD_ID`, or zone
   prefix), it must match the CLD in the request path.
5. Dwelling identity is unique within a CU.

## Region Summary

`GET /api/cld/:cld` returns a `RegionSummary` with `cld`, `revision`, `label`,
`ssids`, `cuCodes`, and counts for CU, blocks, dwellings, and special locations.

`GET /api/cld/:cld/features` includes the same numeric `revision` as a
top-level GeoJSON extension and sends it as the `ETag` response header.

## Compatibility Policy

Existing frontend clients may continue to read legacy attributes during the
migration. New backend code must read canonical properties first and only use
legacy aliases through `backend/src/domain/region-feature.js`.
