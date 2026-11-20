const databaseName = "fx-sounds-studio";
let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.addEventListener("upgradeneeded", () => {
      for (const name of ["sounds", "projects"]) {
        request.result.createObjectStore(name, { keyPath: "id", autoIncrement: true });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
  return opening;
}

async function transact(storeName, mode, action) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    transaction.addEventListener("complete", () => resolve(request.result));
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

export function saveRecord(storeName, record) {
  return transact(storeName, "readwrite", store => store.put(record));
}

export function listRecords(storeName) {
  return transact(storeName, "readonly", store => store.getAll());
}

export function getRecord(storeName, id) {
  return transact(storeName, "readonly", store => store.get(id));
}

export function deleteRecord(storeName, id) {
  return transact(storeName, "readwrite", store => store.delete(id));
}
