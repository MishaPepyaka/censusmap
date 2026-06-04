# StatCan Export Check

- Service: `2026_GM_CAM_CFOP_EN_202506`
- Checked export scale: about `1:25,234`
- Checked bbox: `5813525.98973438,1994482.7669431788,5821123.857188448,1999516.8548696882`

## Findings

- `CLD`, `ZONE`, `CU`, and `COLB` geometry layers are all visible at this scale.
- The export is not missing region geometry.
- The provided request uses `layers=show:0,1,8,9,4,3,6,5`.
- That layer list includes label layers for `RCC` and `FOM` (`8`, `9`), but omits matching label layers for:
  - `CLD` (`11`)
  - `ZONE` (`12`)
  - `CU` (`13`)
  - `COLB` (`14`)

## Corrected Layer Recommendation

Use:

```text
layers=show:0,1,8,9,4,3,6,5,12,11,14,13
```

If you only want local collection geography plus matching labels, a cleaner set is:

```text
layers=show:3,4,5,6,11,12,13,14
```

## Repro

Run:

```bash
node scripts/check-statcan-export.mjs
```

This writes a machine-readable report to `docs/STATCAN_EXPORT_CHECK.json`.
