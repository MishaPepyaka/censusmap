#!/usr/bin/env python3
import argparse
import csv
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path


ROW_RE = re.compile(r"^\d{4}$")
DIGIT_RE = re.compile(r"\d+")


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{p.stderr}")
    return p.stdout


def parse_tsv(tsv_text):
    rows = []
    rdr = csv.DictReader(tsv_text.splitlines(), delimiter="\t")
    for r in rdr:
        txt = (r.get("text") or "").strip()
        if not txt:
            continue
        try:
            conf = float(r.get("conf") or "-1")
        except ValueError:
            conf = -1
        if conf < 15:
            continue
        try:
            left = int(r["left"])
            top = int(r["top"])
            width = int(r["width"])
            height = int(r["height"])
        except Exception:
            continue
        rows.append(
            {
                "text": txt,
                "left": left,
                "top": top,
                "width": width,
                "height": height,
                "right": left + width,
                "bottom": top + height,
                "conf": conf,
            }
        )
    return rows


def normalize_block(raw):
    d = re.sub(r"\D", "", raw or "")
    if not d:
        return ""
    if len(d) == 1:
        return d.zfill(2)
    return d[:2].zfill(2)


def normalize_td(raw):
    d = re.sub(r"\D", "", raw or "")
    return d[:1] if d else ""


def normalize_civic(raw):
    d = re.sub(r"\D", "", raw or "")
    return d[:6] if d else ""


def extract_rows_from_words(words):
    anchors = []
    for w in words:
        if w["left"] > 260:
            continue
        t = re.sub(r"\D", "", w["text"])
        if len(t) == 4:
            anchors.append((int(t), w["top"], w["bottom"], w["left"]))

    anchors.sort(key=lambda x: x[1])
    dedup = []
    for a in anchors:
        if dedup and abs(a[1] - dedup[-1][1]) < 8 and a[0] == dedup[-1][0]:
            continue
        dedup.append(a)
    anchors = dedup

    parsed = {}
    for idx, (row_no, y1, y2, _x) in enumerate(anchors):
        row_top = max(0, y1 - 8)
        if idx < len(anchors) - 1:
            row_bottom = int((y2 + anchors[idx + 1][1]) / 2)
        else:
            row_bottom = y2 + 70

        row_words = [
            w
            for w in words
            if (w["top"] <= row_bottom and w["bottom"] >= row_top)
        ]
        row_words.sort(key=lambda w: (w["top"], w["left"]))

        block_tokens = [w["text"] for w in row_words if 150 <= w["left"] <= 520]
        td_tokens = [w["text"] for w in row_words if 560 <= w["left"] <= 860]
        civic_tokens = [w["text"] for w in row_words if 900 <= w["left"] <= 1220]
        desc_tokens = [w["text"] for w in row_words if w["left"] >= 1240]

        block = ""
        for t in block_tokens:
            d = re.sub(r"\D", "", t)
            if d in {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"}:
                block += d
                if len(block) >= 2:
                    break
        block = normalize_block(block)

        td = ""
        for t in td_tokens:
            d = re.sub(r"\D", "", t)
            if d:
                td = normalize_td(d)
                break

        civic = ""
        for t in civic_tokens:
            d = re.sub(r"\D", "", t)
            if len(d) >= 2:
                civic = normalize_civic(d)
                break

        desc = " ".join(desc_tokens).strip()
        desc = re.sub(r"\s+", " ", desc)

        parsed[str(row_no).zfill(4)] = {
            "dwellingNo": str(row_no).zfill(4),
            "block": block,
            "td": td,
            "civicNo": civic,
            "description": desc,
        }
    return parsed


def polygon_rings(geometry):
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if gtype == "Polygon":
        return [coords]
    if gtype == "MultiPolygon":
        return coords
    return []


def point_in_ring(x, y, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if ((y1 > y) != (y2 > y)):
            xinters = (x2 - x1) * (y - y1) / ((y2 - y1) if (y2 - y1) != 0 else 1e-12) + x1
            if x < xinters:
                inside = not inside
    return inside


def point_in_polygon(x, y, poly_rings):
    if not poly_rings:
        return False
    outer = poly_rings[0]
    if not point_in_ring(x, y, outer):
        return False
    for hole in poly_rings[1:]:
        if point_in_ring(x, y, hole):
            return False
    return True


def point_in_geometry(x, y, geometry):
    rings_list = polygon_rings(geometry)
    if geometry.get("type") == "Polygon":
        return point_in_polygon(x, y, rings_list[0] if rings_list else [])
    if geometry.get("type") == "MultiPolygon":
        for poly in rings_list:
            if point_in_polygon(x, y, poly):
                return True
    return False


def geometry_bbox_centroid(geometry):
    coords = []
    for poly in polygon_rings(geometry):
        for ring in poly:
            coords.extend(ring)
    xs = [c[0] for c in coords]
    ys = [c[1] for c in coords]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    return minx, miny, maxx, maxy, cx, cy


def halton(index, base):
    f = 1.0
    r = 0.0
    i = index
    while i > 0:
        f /= base
        r += f * (i % base)
        i //= base
    return r


def generate_points_inside(geometry, count):
    minx, miny, maxx, maxy, cx, cy = geometry_bbox_centroid(geometry)
    points = []
    i = 1
    attempts = max(2000, count * 80)
    while len(points) < count and i <= attempts:
        x = minx + (maxx - minx) * halton(i, 2)
        y = miny + (maxy - miny) * halton(i, 3)
        if point_in_geometry(x, y, geometry):
            points.append((x, y))
        i += 1

    while len(points) < count:
        points.append((cx, cy))
    return points


def load_block_geometries(file_store_path, cu):
    data = json.loads(Path(file_store_path).read_text())
    block_geoms = {}
    for f in data.get("features", []):
        p = f.get("properties") or {}
        if p.get("_group") != "blocks":
            continue
        if str(p.get("CUID", "")).strip() != cu:
            continue
        block = normalize_block(str(p.get("CB_COLCODE", "")))
        if block:
            block_geoms[block] = f.get("geometry")
    return data, block_geoms


def build_dwelling_features(records, cu, block_geoms, existing_start_id=1):
    by_block = defaultdict(list)
    for rec in records:
        block = normalize_block(rec.get("block", ""))
        if not block:
            continue
        by_block[block].append(rec)

    features = []
    next_id = existing_start_id

    for block, recs in sorted(by_block.items()):
        geom = block_geoms.get(block)
        if not geom:
            continue
        recs.sort(key=lambda r: int(r["dwellingNo"]))
        points = generate_points_inside(geom, len(recs))
        for rec, (lng, lat) in zip(recs, points):
            td = rec.get("td", "")
            occupied = td != "8"
            dwelling_no = rec["dwellingNo"]
            props = {
                "_group": "dwellings",
                "CUID": cu,
                "CB_COLCODE": block,
                "dwellingNo": dwelling_no,
                "dwellingType": td,
                "description": rec.get("description", ""),
                "occupied": occupied,
                "notes": "",
                "contact": "",
                "status": "",
                "externalLink": "",
                "photo": "",
                "civicNo": rec.get("civicNo", ""),
                "name": f"{cu} / {block} / {dwelling_no}",
                "label": dwelling_no,
            }
            features.append(
                {
                    "id": next_id,
                    "name": props["name"],
                    "properties": props,
                    "geometry": {"type": "Point", "coordinates": [lng, lat]},
                    "createdAt": None,
                    "updatedAt": None,
                }
            )
            next_id += 1
    return features


def main():
    parser = argparse.ArgumentParser(description="Import dwellings from handwritten PDF into file-store")
    parser.add_argument("--pdf", required=True, help="Path to source PDF")
    parser.add_argument("--cu", required=True, help="Target CU code, e.g. 46221114")
    parser.add_argument(
        "--file-store",
        default="/home/misha/Projects/selfhost-map-cmp/data/file-store.json",
        help="Path to file-store JSON",
    )
    parser.add_argument(
        "--output-records",
        default="",
        help="Optional path to write parsed OCR records JSON",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write dwellings into file-store (otherwise dry run)",
    )
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        raise SystemExit(f"PDF not found: {pdf_path}")

    with tempfile.TemporaryDirectory(prefix="dwell_ocr_") as td:
        out_prefix = Path(td) / "page"
        run(["pdftoppm", "-r", "300", "-png", str(pdf_path), str(out_prefix)])
        pages = sorted(Path(td).glob("page-*.png"))
        if not pages:
            raise SystemExit("No pages produced by pdftoppm")

        records = {}
        for img in pages:
            tsv = run(["tesseract", str(img), "stdout", "--psm", "6", "tsv"])
            words = parse_tsv(tsv)
            page_rows = extract_rows_from_words(words)
            for k, v in page_rows.items():
                records[k] = v

        ordered = [records[k] for k in sorted(records.keys(), key=lambda x: int(x))]

    if args.output_records:
        Path(args.output_records).write_text(json.dumps(ordered, ensure_ascii=False, indent=2))

    store, block_geoms = load_block_geometries(args.file_store, args.cu)
    if not block_geoms:
        raise SystemExit(f"No blocks found for CU {args.cu}")

    existing_dwellings = [
        f for f in store.get("features", []) if (f.get("properties") or {}).get("_group") == "dwellings"
    ]
    existing_by_key = {
        f"{(f.get('properties') or {}).get('CUID','')}|{normalize_block(str((f.get('properties') or {}).get('CB_COLCODE','')))}|{str((f.get('properties') or {}).get('dwellingNo','')).zfill(4)}"
        for f in existing_dwellings
    }

    next_id = int(store.get("nextId", 1))
    built = build_dwelling_features(ordered, args.cu, block_geoms, next_id)

    to_insert = []
    for f in built:
        p = f.get("properties") or {}
        key = f"{p.get('CUID','')}|{normalize_block(str(p.get('CB_COLCODE','')))}|{str(p.get('dwellingNo','')).zfill(4)}"
        if key in existing_by_key:
            continue
        to_insert.append(f)

    print(f"Parsed rows: {len(ordered)}")
    print(f"Candidate dwellings in CU {args.cu}: {len(built)}")
    print(f"New dwellings to insert: {len(to_insert)}")

    if not args.apply:
        print("Dry run mode. Use --apply to write into file-store.")
        return

    now = __import__("datetime").datetime.utcnow().isoformat() + "Z"
    for f in to_insert:
        f["createdAt"] = now
        f["updatedAt"] = now
        store["features"].append(f)
    if to_insert:
        store["nextId"] = max(store.get("nextId", 1), max(f["id"] for f in to_insert) + 1)

    backup = Path(args.file_store).with_suffix(".json.bak")
    shutil.copy2(args.file_store, backup)
    Path(args.file_store).write_text(json.dumps(store))

    print(f"Inserted {len(to_insert)} dwellings")
    print(f"Backup: {backup}")


if __name__ == "__main__":
    main()
