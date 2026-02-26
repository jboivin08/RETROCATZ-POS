<script type="module" id="file-items-js">
}
};
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
});


async function withStore(mode, fn) {
const db = await dbPromise;
return new Promise((resolve, reject) => {
const tx = db.transaction(STORE, mode);
const store = tx.objectStore(STORE);
const res = fn(store);
tx.oncomplete = () => resolve(res);
tx.onerror = () => reject(tx.error);
});
}


export async function addItem(item) {
const normalized = normalizeItem(item);
await withStore('readwrite', store => store.put(normalized));
ping();
return normalized;
}


export async function getAllItems() {
return withStore('readonly', store => new Promise((resolve, reject) => {
const out = [];
const req = store.openCursor();
req.onsuccess = e => {
const cur = e.target.result;
if (cur) { out.push(cur.value); cur.continue(); }
else resolve(out);
};
req.onerror = () => reject(req.error);
}));
}


export async function getItem(sku) {
return withStore('readonly', store => store.get(String(sku)));
}


export async function deleteItem(sku) {
await withStore('readwrite', store => store.delete(String(sku)));
ping();
}


export async function updateItem(sku, patch) {
const cur = await getItem(sku);
if (!cur) throw new Error('Item not found');
const updated = normalizeItem({ ...cur, ...patch, sku: cur.sku });
await withStore('readwrite', store => store.put(updated));
ping();
return updated;
}


function normalizeItem(item) {
return {
sku: String(item.sku || '').trim(),
title: String(item.title || '').trim(),
platform: String(item.platform || '').trim(),
condition: String(item.condition || '').trim(),
variant: String(item.variant || '').trim(),
qty: Number(item.qty || 0),
cost: Number(item.cost || 0),
listPrice: Number(item.listPrice || 0),
createdAt: item.createdAt || Date.now(),
updatedAt: Date.now(),
};
}


function ping() {
// wakes other pages to re-render
localStorage.setItem('rcg:items:ping', String(Math.random()));
}


export function onItemsChanged(handler) {
window.addEventListener('storage', e => {
if (e.key === 'rcg:items:ping') handler();
});
}
</script>