(function initOfflineDataStore() {
  const DB_NAME = "census-map-offline";
  const DB_VERSION = 1;
  const SNAPSHOT_STORE = "cld-snapshots";
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
          database.createObjectStore(SNAPSHOT_STORE, { keyPath: "cld" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open offline storage"));
    });
    return databasePromise;
  }

  async function readSnapshot(cld) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(SNAPSHOT_STORE, "readonly");
      const request = transaction.objectStore(SNAPSHOT_STORE).get(String(cld));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read offline snapshot"));
    });
  }

  async function saveSnapshot(cld, features) {
    const database = await openDatabase();
    const snapshot = {
      cld: String(cld),
      features: Array.isArray(features) ? features : [],
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

  window.CldOfflineStore = { readSnapshot, saveSnapshot };
})();
