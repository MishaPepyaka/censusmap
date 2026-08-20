export type OfflineSnapshot = {
  cld: string;
  features: unknown[];
  savedAt: number;
};

const DB_NAME = "census-map-offline";
const DB_VERSION = 1;
const SNAPSHOT_STORE = "cld-snapshots";
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) database.createObjectStore(SNAPSHOT_STORE, { keyPath: "cld" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open offline storage"));
  });
  return databasePromise;
}

export async function readSnapshot(cld: string | number): Promise<OfflineSnapshot | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, "readonly");
    const request = transaction.objectStore(SNAPSHOT_STORE).get(String(cld));
    request.onsuccess = () => resolve((request.result as OfflineSnapshot | undefined) || null);
    request.onerror = () => reject(request.error || new Error("Could not read offline snapshot"));
  });
}

export async function saveSnapshot(cld: string | number, features: unknown[]): Promise<OfflineSnapshot> {
  const database = await openDatabase();
  const snapshot: OfflineSnapshot = { cld: String(cld), features: Array.isArray(features) ? features : [], savedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SNAPSHOT_STORE, "readwrite");
    transaction.objectStore(SNAPSHOT_STORE).put(snapshot);
    transaction.oncomplete = () => resolve(snapshot);
    transaction.onerror = () => reject(transaction.error || new Error("Could not save offline snapshot"));
    transaction.onabort = () => reject(transaction.error || new Error("Offline snapshot save was aborted"));
  });
}

function localSnapshotKey(cld: string | number): string {
  return `cld-map-cache:${cld}`;
}

export async function readCachedFeatures(cld: string | number): Promise<OfflineSnapshot | null> {
  try {
    const snapshot = await readSnapshot(cld);
    if (Array.isArray(snapshot?.features)) return snapshot;
  } catch {
    // Fall back to localStorage when IndexedDB is unavailable.
  }
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(localSnapshotKey(cld)) || "null");
    return typeof cached === "object" && cached !== null && Array.isArray((cached as OfflineSnapshot).features)
      ? cached as OfflineSnapshot
      : null;
  } catch {
    return null;
  }
}

export function saveCachedFeatures(cld: string | number, features: unknown[]): void {
  const snapshot: OfflineSnapshot = { cld: String(cld), features: Array.isArray(features) ? features : [], savedAt: Date.now() };
  void saveSnapshot(cld, snapshot.features).catch(() => {});
  try {
    localStorage.setItem(localSnapshotKey(cld), JSON.stringify(snapshot));
  } catch {
    // IndexedDB remains the preferred offline store.
  }
}
