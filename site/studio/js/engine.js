const worker = new Worker(new URL("./engine-worker.js", import.meta.url), { type: "module" });
const pending = new Map();
let nextId = 0;

worker.addEventListener("message", ({ data }) => {
  const request = pending.get(data.id);
  pending.delete(data.id);
  if (data.error) {
    request.reject(new Error(data.error));
  } else {
    request.resolve(data.sounds);
  }
});

worker.addEventListener("error", event => {
  for (const request of pending.values()) {
    request.reject(new Error(event.message || "Engine failed to load"));
  }
  pending.clear();
});

export function renderPatch(patch, oversampling = 0) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, patch, oversampling });
  });
}
