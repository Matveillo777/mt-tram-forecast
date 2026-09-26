"""Paths and constants shared by the data pipeline (ingest.py, geo.py)."""
import os
import zipfile
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = ML_DIR.parent

RAW_DIR = ML_DIR / "data" / "raw"
PROCESSED_DIR = ML_DIR / "data" / "processed"
EXTERNAL_DIR = ML_DIR / "data" / "external"
OSM_CACHE_DIR = EXTERNAL_DIR / "osm"
ARTIFACTS_DIR = ML_DIR / "artifacts"

# Route set for the hackathon (route 5 has essentially no boardings in the history).
ROUTES = [1, 5, 7, 11, 12, 17, 25, 26, 28, 50]

# Strict calendar coverage kept from each raw file. train.csv physically runs
# 2025-01-01 04:29 .. 2025-09-01 01:55 (a short tail before test.csv's own data
# starts, at 2025-09-01 04:20) - that tail is real, non-overlapping data and is
# kept, otherwise the first two hours of 2025-09-01 would silently go missing.
# test.csv's own tail into 2025-11-01 is dropped, that period is out of scope.
TRAIN_CSV_RANGE = ("2025-01-01", "2025-09-01")
TEST_CSV_RANGE = ("2025-09-01", "2025-10-31")
HISTORY_RANGE = ("2025-01-01", "2025-10-31")

DATASET_ZIP_PUBLIC_URL = "https://disk.yandex.ru/d/DiFwlfMOauxjBg"
YANDEX_DISK_API = "https://cloud-api.yandex.net/v1/disk/public/resources/download"


def dataset_zip_path() -> Path:
    default = RAW_DIR / "dataset.zip"
    return Path(os.environ.get("DATASET_ZIP", str(default)))


def ensure_dataset_zip() -> Path:
    """Return a local path to the organizers' dataset.zip, downloading it if absent."""
    path = dataset_zip_path()
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    import requests

    resp = requests.get(YANDEX_DISK_API, params={"public_key": DATASET_ZIP_PUBLIC_URL}, timeout=30)
    resp.raise_for_status()
    href = resp.json()["href"]
    with requests.get(href, stream=True, timeout=60) as r:
        r.raise_for_status()
        tmp = path.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
        tmp.rename(path)
    return path


def extract_from_dataset(member: str, dest_dir: Path) -> Path:
    """Extract a single member (e.g. 'train.csv') from dataset.zip into dest_dir, if not already there."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = dest_dir / member
    if out.exists():
        return out
    zip_path = ensure_dataset_zip()
    with zipfile.ZipFile(zip_path) as z:
        z.extract(member, dest_dir)
    return out
