/* GEOG 464 memory.js: let your Leaflet map remember what a reader adds.
   (c) 2026 Luke Russell. All rights reserved. Students may copy and adapt it for GEOG 464.

   HOW TO USE
   1. Save this file as memory.js in the same folder as your index.html.
   2. In index.html, AFTER the script that makes your map, add:
        <script src="memory.js"></script>
        <script>addMemory(map);</script>
      (use your own map variable's name if it is not "map").
   3. Change only the part marked CHANGE THIS PART below.

   TWO ROUTES, SAME CREDIT
   - Personal (default): points are saved in the reader's own browser (localStorage).
     They survive a reload; nobody else sees them. Nothing to set up.
   - Shared: paste your own Firebase web config below, publish the rules from the kit,
     and every reader sees every point within a second.
*/

// ===== CHANGE THIS PART =====
const MEMORY = {
  // What a reader can add. Colour plus words, never colour alone.
  categories: {
    seen:    { label: "I saw this here",       colour: "#1f77b4" },
    problem: { label: "Something is wrong",    colour: "#d95f02" },
    idea:    { label: "Idea or suggestion",    colour: "#1b9e77" }
  },
  maxNote: 80,                       // characters
  // Where points may go: south, north, west, east. null means anywhere.
  bounds: null,                      // e.g. { south: 45.40, north: 45.60, west: -73.75, east: -73.45 }
  storageKey: null,                  // personal route: null gives each page folder its own notebook
  position: "topright",              // where the panel sits: topright, topleft, bottomright, bottomleft
  collection: "points",              // shared route: the Firestore collection name
  // Shared route only: paste your Firebase web config here. Leave apiKey as PASTE for the personal route.
  firebaseConfig: {
    apiKey: "PASTE",
    authDomain: "PASTE.firebaseapp.com",
    projectId: "PASTE",
    appId: "PASTE"
  }
};
// ===== END OF THE PART TO CHANGE =====

const MEMORY_SDK = "https://www.gstatic.com/firebasejs/12.18.0/";   // pinned version

function addMemory(map) {
  const shared = !String(MEMORY.firebaseConfig.apiKey).startsWith("PASTE");
  // Your github.io projects share one browser storage area, so each page folder gets its own key.
  const storageKey = MEMORY.storageKey || ("geog464-memory:" + location.pathname.replace(/[^/]*$/, ""));
  const layer = L.layerGroup().addTo(map);
  let points = [];       // {id, lat, lng, cat, note, uid, ts}
  let adding = false;    // "Add a point" mode: the next click on the map adds a point
  let myUid = "me";
  let fb = null;         // Firebase functions, shared route only

  // ---------- a small panel on the map ----------
  const Panel = L.Control.extend({
    onAdd() {
      const box = L.DomUtil.create("div", "memory-panel");
      box.style.cssText = "background:#fff;padding:8px 10px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.35);font:14px Arial,sans-serif;max-width:230px";
      box.innerHTML =
        '<button type="button" data-m="add" style="width:100%;min-height:40px;font-weight:bold;cursor:pointer">Add a point</button>' +
        '<div data-m="status" role="status" style="margin:6px 0">Loading...</div>' +
        '<ul data-m="legend" style="list-style:none;margin:0 0 6px;padding:0"></ul>' +
        '<button type="button" data-m="export" style="width:100%;cursor:pointer">Download points (GeoJSON)</button>';
      L.DomEvent.disableClickPropagation(box);
      return box;
    }
  });
  const panel = new Panel({ position: MEMORY.position || "topright" }).addTo(map).getContainer();
  const $ = (k) => panel.querySelector('[data-m="' + k + '"]');
  for (const c of Object.values(MEMORY.categories)) {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.style.cssText = "display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:6px;background:" + c.colour;
    li.append(sw, document.createTextNode(c.label));
    $("legend").append(li);
  }
  function status(text) { $("status").textContent = text; }

  function draw() {
    layer.clearLayers();
    for (const p of points) {
      const c = MEMORY.categories[p.cat] || { colour: "#666" };
      L.circleMarker([p.lat, p.lng], { radius: 9, color: "#fff", weight: 2, fillColor: c.colour, fillOpacity: 0.9 })
        .bindPopup(() => popup(p)).addTo(layer);
    }
    status((shared ? "Shared: " : "Saved in this browser: ") + points.length + " point" + (points.length === 1 ? "" : "s"));
  }

  // A reader's note is typed by a stranger: show it with textContent, never innerHTML.
  function popup(p) {
    const box = document.createElement("div");
    const h = document.createElement("strong");
    h.textContent = (MEMORY.categories[p.cat] || { label: p.cat }).label;
    const n = document.createElement("div");
    n.textContent = p.note || "(no note)";
    box.append(h, n);
    if (!shared || p.uid === myUid) {
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "Delete my point"; del.style.marginTop = "6px";
      del.addEventListener("click", () => remove(p.id));
      box.append(del);
    }
    return box;
  }

  // ---------- personal route: localStorage ----------
  function loadLocal() {
    try { points = JSON.parse(localStorage.getItem(storageKey) || "[]"); }
    catch (e) { points = []; }
    draw();
  }
  function saveLocal() {
    try { localStorage.setItem(storageKey, JSON.stringify(points)); return true; }
    catch (e) { status("This browser would not save it (private mode?)"); return false; }
  }

  // ---------- shared route: Firebase ----------
  async function startShared() {
    status("Connecting...");
    try {
      const app = await import(MEMORY_SDK + "firebase-app.js");
      const fs = await import(MEMORY_SDK + "firebase-firestore.js");
      const au = await import(MEMORY_SDK + "firebase-auth.js");
      const fapp = app.initializeApp(MEMORY.firebaseConfig);
      const db = fs.getFirestore(fapp);
      const auth = au.getAuth(fapp);
      await au.signInAnonymously(auth);            // a random, anonymous id for this browser
      myUid = auth.currentUser.uid;
      fb = { fs, db };
      const q = fs.query(fs.collection(db, MEMORY.collection), fs.orderBy("ts", "desc"), fs.limit(500));
      fs.onSnapshot(q, (snap) => {
        points = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        draw();
      }, (err) => status("The database said no: " + (err.code || err.message)));
    } catch (err) {
      console.error(err);
      status("Could not reach the database: " + (err.code || err.message));
    }
  }

  // ---------- adding and removing ----------
  function inside(lat, lng) {
    const b = MEMORY.bounds;
    return !b || (lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east);
  }

  async function add(lat, lng, cat, note) {
    note = (note || "").trim().slice(0, MEMORY.maxNote);
    lat = Math.round(lat * 1e5) / 1e5; lng = Math.round(lng * 1e5) / 1e5;   // about 1 m
    if (!inside(lat, lng)) { status("That is outside this map's area"); return; }
    if (!MEMORY.categories[cat]) { status("Choose a kind of point"); return; }
    if (shared) {
      if (!fb) { status("Not connected yet"); return; }
      try {
        await fb.fs.addDoc(fb.fs.collection(fb.db, MEMORY.collection),
          { lat, lng, cat, note, uid: myUid, ts: fb.fs.serverTimestamp() });
      } catch (err) {
        status(err.code === "permission-denied" ? "The rules said no" : "Not saved: " + (err.code || err.message));
      }
    } else {
      points.unshift({ id: "p" + Date.now(), lat, lng, cat, note, uid: "me", ts: Date.now() });
      if (saveLocal()) draw(); else points.shift();   // not saved: do not pretend it was
    }
  }

  async function remove(id) {
    map.closePopup();
    if (shared) {
      try { await fb.fs.deleteDoc(fb.fs.doc(fb.db, MEMORY.collection, id)); }
      catch (err) { status("Not deleted: " + (err.code || err.message)); }
    } else {
      const before = points;
      points = points.filter((p) => p.id !== id);
      if (saveLocal()) draw(); else points = before;   // not deleted: keep showing it
    }
  }

  // "Add a point" switches on adding for ONE click. While it is on, memory.js catches that click
  // before Leaflet sees it, so your map's own click actions (nearest place, popups) do not also fire.
  function setAdding(on) {
    adding = on;
    $("add").textContent = on ? "Now click the map (or press again to cancel)" : "Add a point";
    map.getContainer().style.cursor = on ? "crosshair" : "";
  }
  $("add").addEventListener("click", () => setAdding(!adding));

  map.getContainer().addEventListener("click", (ev) => {
    if (!adding) return;
    if (ev.target.closest(".leaflet-control, .leaflet-popup")) return;   // clicks on panels and popups pass through
    ev.stopPropagation();                    // your other map click handlers do not run for this click
    setAdding(false);
    openForm(map.mouseEventToLatLng(ev));
  }, true);                                  // true = catch it on the way in, before Leaflet

  function openForm(latlng) {
    const form = document.createElement("form");
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "What kind of point?");
    for (const [k, c] of Object.entries(MEMORY.categories)) {
      const o = document.createElement("option"); o.value = k; o.textContent = c.label; sel.append(o);
    }
    const inp = document.createElement("input");
    inp.maxLength = MEMORY.maxNote; inp.placeholder = "Short note, no names"; inp.setAttribute("aria-label", "Short note");
    inp.style.cssText = "display:block;margin:6px 0;width:100%";
    const ok = document.createElement("button"); ok.type = "submit"; ok.textContent = "Save";
    form.append(sel, inp, ok);
    form.addEventListener("submit", (ev) => { ev.preventDefault(); map.closePopup(); add(latlng.lat, latlng.lng, sel.value, inp.value); });
    L.popup().setLatLng(latlng).setContent(form).openOn(map);
    setTimeout(() => sel.focus(), 50);
  }

  // ---------- download what is on the map ----------
  $("export").addEventListener("click", () => {
    const gj = { type: "FeatureCollection", features: points.map((p) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: { category: (MEMORY.categories[p.cat] || { label: p.cat }).label, note: p.note } })) };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(gj, null, 2)], { type: "application/geo+json" }));
    a.download = "points.geojson"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  if (shared) startShared(); else loadLocal();
  return { get points() { return points; }, get shared() { return shared; } };   // handy for testing
}