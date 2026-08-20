export type OfflineSnapshot = {
  cld: string;
  features: unknown[];
  revision?: number | null;
  savedAt: number;
};

export type PendingMutationSnapshot = {
  cld: string;
  mutations: unknown[];
  savedAt: number;
};

const DB_NAME = "census-map-offline";
const DB_VERSION = 2;
const SNAPSHOT_STORE = "cld-snapshots";
const PENDING_MUTATION_STORE = "cld-pending-mutations";
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
      if (!database.objectStoreNames.contains(PENDING_MUTATION_STORE)) database.createObjectStore(PENDING_MUTATION_STORE, { keyPath: "cld" });
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

export async function saveSnapshot(cld: string | number, features: unknown[], revision: number | null = null): Promise<OfflineSnapshot> {
  const database = await openDatabase();
  const snapshot: OfflineSnapshot = {
    cld: String(cld),
    features: Array.isArray(features) ? features : [],
    revision: typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1 ? revision : null,
    savedAt: Date.now()
  };
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

export function saveCachedFeatures(cld: string | number, features: unknown[], revision: number | null = null): void {
  const snapshot: OfflineSnapshot = {
    cld: String(cld),
    features: Array.isArray(features) ? features : [],
    revision: typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1 ? revision : null,
    savedAt: Date.now()
  };
  void saveSnapshot(cld, snapshot.features, snapshot.revision).catch(() => {});
  try {
    localStorage.setItem(localSnapshotKey(cld), JSON.stringify(snapshot));
  } catch {
    // IndexedDB remains the preferred offline store.
  }
}

function localMutationKey(cld: string | number): string {
  return `cld-map-pending:${cld}`;
}

export async function readPendingMutations(cld: string | number): Promise<PendingMutationSnapshot | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PENDING_MUTATION_STORE, "readonly");
    const request = transaction.objectStore(PENDING_MUTATION_STORE).get(String(cld));
    request.onsuccess = () => resolve((request.result as PendingMutationSnapshot | undefined) || null);
    request.onerror = () => reject(request.error || new Error("Could not read pending mutations"));
  });
}

export async function savePendingMutations(cld: string | number, mutations: unknown[]): Promise<PendingMutationSnapshot> {
  const database = await openDatabase();
  const snapshot: PendingMutationSnapshot = { cld: String(cld), mutations: Array.isArray(mutations) ? mutations : [], savedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PENDING_MUTATION_STORE, "readwrite");
    transaction.objectStore(PENDING_MUTATION_STORE).put(snapshot);
    transaction.oncomplete = () => resolve(snapshot);
    transaction.onerror = () => reject(transaction.error || new Error("Could not save pending mutations"));
    transaction.onabort = () => reject(transaction.error || new Error("Pending mutation save was aborted"));
  });
}

export async function hydratePendingMutations(cld: string | number): Promise<unknown[]> {
  const key = localMutationKey(cld);
  try {
    const local = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(local) && local.length > 0) return local;
  } catch {
    // Continue with IndexedDB when localStorage is unavailable or malformed.
  }
  try {
    const snapshot = await readPendingMutations(cld);
    const mutations = Array.isArray(snapshot?.mutations) ? snapshot.mutations : [];
    if (mutations.length > 0) localStorage.setItem(key, JSON.stringify(mutations));
    return mutations;
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function localPendingMutations(cld: string | number): unknown[] {
  try {
    const queue = JSON.parse(localStorage.getItem(localMutationKey(cld)) || "[]");
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

export function applyLocalPendingMutations(cld: string | number, features: unknown[]): unknown[] {
  const nextFeatures = Array.isArray(features) ? [...features] : [];
  for (const rawMutation of localPendingMutations(cld)) {
    const mutation = asRecord(rawMutation);
    if (!mutation) continue;
    const payload = asRecord(mutation.payload);
    const method = String(mutation.method || "").toUpperCase();
    if (method === "POST" && payload?.geometry) {
      nextFeatures.push({ ...payload, _offlineQueueId: mutation.id, _offlineMutationKey: mutation.dedupeKey || mutation.id });
      continue;
    }
    const id = String(payload?.id ?? String(mutation.url || "").split("/").pop() ?? "");
    const index = nextFeatures.findIndex((feature) => {
      const record = asRecord(feature);
      const properties = asRecord(record?.properties);
      return String(record?.id ?? properties?._id ?? "") === id;
    });
    if (method === "PUT" && index >= 0 && payload?.geometry) nextFeatures[index] = payload;
    if (method === "DELETE" && index >= 0) nextFeatures.splice(index, 1);
  }
  return nextFeatures;
}
