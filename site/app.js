// BIXI stations: positions from the notebook's GeoJSON, availability live from BIXI's GBFS feed.
// Metro stations: from the STM's GTFS feed, cross-listed with BIXI in the notebook.

// On phones, start zoomed in on downtown so the metro markers do not overlap (touch targets, WCAG 2.5.8).
const isPhone = window.matchMedia('(max-width: 700px)').matches;
const map = L.map('map', { preferCanvas: true })
  .setView(isPhone ? [45.505, -73.57] : [45.52, -73.6], isPhone ? 14 : 12);
// Panes, bottom to top: coloured land patches, the dashed circle, metro lines, place labels, then the dots.
// None of them take clicks, so the BIXI and metro dots (in the overlay pane above) stay clickable.
[['patches', 330], ['selectArea', 340], ['labels', 360]].forEach(function (pane) {
  const el = map.createPane(pane[0]);
  el.style.zIndex = pane[1];
  el.style.pointerEvents = 'none';
});

// Esri World Light Gray Canvas: a pale grey street map, with its labels drawn above the coloured patches.
// No API key needed. Its tiles stop at zoom 16, so closer zooms enlarge them.
const ESRI_GRAY = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
L.tileLayer(ESRI_GRAY + 'World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, maxNativeZoom: 16,
  attribution: 'Base map &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors | Station data: <a href="https://bixi.com/en/open-data">BIXI Montréal</a>'
}).addTo(map);
L.tileLayer(ESRI_GRAY + 'World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, maxNativeZoom: 16, pane: 'labels'
}).addTo(map);

const STATUS_URL = 'https://gbfs.velobixi.com/gbfs/en/station_status.json';
const REFRESH_MS = 60 * 1000;   // GBFS updates often; once a minute is plenty
const STM_STATUS_URL = '/api/stm/service-status';
const STM_REFRESH_MS = 60 * 1000;

// Colour classes: how many of the thing you are looking for (bikes or docks). Oranges: darker means more.
const classes = [
  { label: 'None', min: 0, max: 0, colour: '#FBE4D2' },
  { label: '1 to 3', min: 1, max: 3, colour: '#F4C2A5' },
  { label: '4 to 9', min: 4, max: 9, colour: '#EA9467' },
  { label: '10 or more', min: 10, max: Infinity, colour: '#D4572A' },
  { label: 'Closed / no data', colour: '#D3CFCA' }
];
const METRO_LAND = '#9ED3EA';   // land nearest a metro station
const NO_STATION_LAND = '#EDEDED';

let walkM = 300;         // the walking distance from the slider (300 m, about 4 minutes, is the notebook's "near a metro")
const WALK_M_PER_MIN = 80;   // about 4.8 km/h
const MONTREAL_BOUNDS = L.latLngBounds([45.35, -74.05], [45.75, -73.35]);   // roughly where the BIXI stations are
const lineColours = { Green: '#00B300', Orange: '#D95700', Yellow: '#FFD900', Blue: '#0095E6' };   // STM's own colours
const routeLines = { '1': 'Green', '2': 'Orange', '4': 'Yellow', '5': 'Blue' };
// Station order along each line (metro_id), end to end. Transfer stations appear on every line they serve.
const lineOrder = {
  Green: ['M118', 'M120', 'M122', 'M124', 'M126', 'M128', 'M130', 'M132', 'M134', 'M136', 'M138', 'M140', 'M142', 'M144',
    'M146', 'M148', 'M150', 'M152', 'M154', 'M156', 'M158', 'M160', 'M162', 'M164', 'M166', 'M168', 'M170'],
  Orange: ['M222', 'M224', 'M228', 'M230', 'M232', 'M234', 'M236', 'M238', 'M242', 'M244', 'M132', 'M248', 'M250', 'M252',
    'M254', 'M256', 'M258', 'M146', 'M262', 'M264', 'M266', 'M268', 'M270', 'M272', 'M274', 'M276', 'M278', 'M280',
    'M282', 'M286', 'M288'],
  Yellow: ['M146', 'M452', 'M454'],
  Blue: ['M236', 'M534', 'M536', 'M538', 'M540', 'M542', 'M544', 'M546', 'M272', 'M552', 'M554', 'M556']
};

let mode = 'bikes';      // the one interaction: 'bikes' (I want to ride) or 'docks' (I want to park)
let status = {};         // station_id -> live status
let nearOnly = false;    // the filter: only BIXI stations within walking distance (walkM) of a metro
let stationsLayer;       // the BIXI circles on the map (all of them, or only the near ones)
let allStations = [];    // every BIXI circle, shown or not
let metroLayer;          // metro stations as round dots (computers, and phones when zoomed out)
let metroIconLayer;      // phones only: the same stations as "M" icons, shown when zoomed in
let metroIconById = {};  // metro_id -> "M" icon
const M_ICON_ZOOM = 15;  // phones: from this zoom in, the dots turn into "M" icons
let metroById = {};      // metro_id -> marker
let disruptionLayer;     // red segments and dashed lines drawn over the metro lines
let selection = null;    // { latlng, radius, label }: the circle chosen by location, metro click or search
let selectCircle;        // the circle drawn for it
let bixiMissing = false; // the BIXI station file did not load: the map shows only the metro and STM status
let patchLayer;          // the coloured land patches inside the circle
let overviewQueued = false;
let metroAlerts = [];    // { kind: 'disruption' | 'notice', title, description, lines, stations, wholeLine }

function countFor(s) {
  if (!s || !s.is_installed || !s.is_renting) { return null; }
  return mode === 'bikes' ? s.num_bikes_available : s.num_docks_available;
}

function colourFor(n) {
  if (n === null) { return classes[4].colour; }
  return classes.find(function (c) { return n >= c.min && n <= c.max; }).colour;
}

function popupFor(p) {
  const s = status[p.station_id];
  let html = '<strong>' + p.name + '</strong><br>Capacity: ' + p.capacity + ' docks' +
    '<br>Nearest metro: ' + p.metro_name + ' (' + p.lines + '), ' + p.metro_dist_m + ' m';
  if (!s) { return html + '<br><em>No live data</em>'; }
  if (!s.is_installed || !s.is_renting) { return html + '<br><em>Station closed</em>'; }
  const ebikes = s.num_ebikes_available || 0;
  return html +
    '<br>Bikes: ' + s.num_bikes_available + ' (' + ebikes + ' electric)' +
    '<br>Free docks: ' + s.num_docks_available +
    '<br><small>Updated ' + new Date(s.last_reported * 1000).toLocaleTimeString() + '</small>';
}

// Live totals for the BIXI stations within walkM of a metro station, counted on the fly.
function metroPopup(p, latlng) {
  let stations = 0, bikes = 0, docks = 0, capacity = 0;
  allStations.forEach(function (layer) {
    if (map.distance(latlng, layer.getLatLng()) > walkM) { return; }
    stations += 1;
    capacity += layer.feature.properties.capacity || 0;
    const s = status[layer.feature.properties.station_id];
    if (s && s.is_installed && s.is_renting) { bikes += s.num_bikes_available; docks += s.num_docks_available; }
  });
  let html = '<strong>Métro ' + p.metro_name + '</strong><br>' + p.lines + ' line' + (p.lines.indexOf('/') > -1 ? 's' : '');
  const disruptions = metroAlerts.filter(function (alert) {
    return alert.kind === 'disruption' && affects(alert, p.metro_id, p.lines.split(' / '));
  });
  const notices = metroAlerts.filter(function (alert) {
    return alert.kind === 'notice' && alert.stations.indexOf(p.metro_id) > -1;
  });
  if (disruptions.length) {
    html += '<br><strong class="down-text">Service disruption:</strong>' +
      disruptions.map(function (alert) { return '<br>' + escapeHTML(alert.description); }).join('');
  }
  if (notices.length) {
    html += '<br><strong>STM notice' + (notices.length > 1 ? 's' : '') + ':</strong>' +
      notices.map(function (alert) { return '<br><small>' + escapeHTML(alert.description) + '</small>'; }).join('');
  }
  if (bixiMissing) { return html + '<br><em>BIXI stations could not be loaded</em>'; }
  if (stations === 0) { return html + '<br><em>No BIXI station within ' + walkM + ' m</em>'; }
  return html + '<br>' + stations + ' BIXI station' + (stations > 1 ? 's' : '') + ' within ' + walkM + ' m (' +
    capacity + ' docks)<br>Right now: ' + bikes + ' bikes, ' + docks + ' free docks';
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

function textFor(entries) {
  if (!Array.isArray(entries)) { return ''; }
  const entry = entries.find(function (item) {
    return item && item.text && String(item.language || '').toLowerCase().startsWith('en');
  }) || entries.find(function (item) { return item && item.text; });
  return entry ? String(entry.text) : '';
}

function linesForAlert(alert) {
  const entities = Array.isArray(alert.informed_entities) ? alert.informed_entities : [];
  const lines = new Set();
  entities.forEach(function (entity) {
    if (!entity) { return; }
    const route = String(entity.route_short_name || entity.route_id || '').trim();
    const routeNumber = route.replace(/^0+/, '');
    if (routeLines[routeNumber]) { lines.add(routeLines[routeNumber]); }
    Object.keys(lineColours).forEach(function (line) {
      if (route.toLowerCase().includes(line.toLowerCase())) { lines.add(line); }
    });
  });
  return Array.from(lines);
}

// active_periods is one {start, end} object (Unix seconds); a missing end means "until further notice".
function isActiveNow(alert) {
  const periods = [].concat(alert.active_periods || []);
  if (!periods.length) { return true; }
  const now = Date.now() / 1000;
  return periods.some(function (p) {
    return (!p.start || p.start <= now) && (!p.end || now <= p.end);
  });
}

// Lower case, no accents, punctuation as spaces: "Square-Victoria–OACI" -> " square victoria oaci ".
function normalise(text) {
  return ' ' + String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

// Metro stop codes are "10" + the 3 digits of our metro_id: 10552 is Fabre (M552).
function stationsFromStopCodes(entities) {
  return entities.map(function (entity) { return String(entity && entity.stop_code || ''); })
    .filter(function (code) { return /^10\d{3}$/.test(code) && metroById['M' + code.slice(2)]; })
    .map(function (code) { return 'M' + code.slice(2); });
}

// Stations of `line` named in the alert text. Two or more names ("between X and Y") cover everything in between.
function stationsFromText(text, line) {
  const order = lineOrder[line];
  const found = [];
  order.forEach(function (id, index) {
    if (!metroById[id]) { return; }   // metro file did not load
    const name = metroById[id].feature.properties.metro_name;
    const variants = [name, name.split('–')[0]];   // "Square-Victoria–OACI" is often just "Square-Victoria"
    if (variants.some(function (v) { return text.indexOf(normalise(v)) > -1; })) { found.push(index); }
  });
  if (found.length < 2) { return found.map(function (i) { return order[i]; }); }
  return order.slice(Math.min.apply(null, found), Math.max.apply(null, found) + 1);
}

// Turns a raw STM alert into what the map needs, or null if it is not about the metro (or says service is normal).
function classifyAlert(alert) {
  const lines = linesForAlert(alert);
  if (!lines.length) { return null; }
  const texts = [].concat(alert.header_texts || [], alert.description_texts || [])
    .map(function (t) { return t && t.text || ''; }).join(' ');
  if (/service normal|normal metro service/.test(normalise(texts))) { return null; }

  const title = textFor(alert.header_texts) || 'STM service notice';
  const description = (textFor(alert.description_texts) || title).replace(/<[^>]*>/g, '').trim();
  const entities = Array.isArray(alert.informed_entities) ? alert.informed_entities : [];
  let stations = stationsFromStopCodes(entities);
  const hasStopCodes = entities.some(function (e) { return e && e.stop_code; });
  const lineLevel = !hasStopCodes || /your line|votre ligne/.test(normalise(title));

  // A station-level alert (closed entrance, works outside, bus terminus moved) is a notice: the station still runs.
  if (!lineLevel) {
    return { kind: 'notice', title: title, description: description, lines: lines, stations: stations, wholeLine: false,
      until: untilFor(alert) };
  }
  if (!stations.length) {
    const text = normalise(texts);
    lines.forEach(function (line) { stations = stations.concat(stationsFromText(text, line)); });
  }
  return { kind: 'disruption', title: title, description: description, lines: lines, stations: stations,
    wholeLine: stations.length === 0, until: untilFor(alert) };
}

// The end of the alert's active period (a Date), or null for "until further notice".
function untilFor(alert) {
  const ends = [].concat(alert.active_periods || []).map(function (p) { return Number(p && p.end); }).filter(Boolean);
  return ends.length ? new Date(Math.max.apply(null, ends) * 1000) : null;
}

function affects(alert, metroId, stationLines) {
  if (alert.stations.indexOf(metroId) > -1) { return true; }
  return alert.wholeLine && alert.lines.some(function (line) { return stationLines.indexOf(line) > -1; });
}

function renderMetroAlerts(allAlerts) {
  const container = document.getElementById('stm-alerts');
  container.replaceChildren();
  const alerts = allAlerts.filter(function (alert) { return alert.kind === 'disruption'; });
  const noticeCount = allAlerts.length - alerts.length;
  if (!alerts.length) {
    const message = document.createElement('p');
    message.textContent = 'Normal métro service on all lines.';
    container.appendChild(message);
  }
  if (noticeCount) {
    const message = document.createElement('p');
    message.className = 'small';
    message.textContent = noticeCount + ' station notice' + (noticeCount > 1 ? 's' : '') +
      ' (closed entrances, nearby works). Click a metro station to read them.';
    container.appendChild(message);
  }

  alerts.forEach(function (alert) {
    const item = document.createElement('article');
    item.className = 'stm-alert';
    const title = document.createElement('strong');
    title.textContent = alert.title;
    const description = document.createElement('p');
    description.textContent = alert.description;
    item.append(title, description);
    const affectedLines = document.createElement('small');
    affectedLines.textContent = alert.lines.length
      ? 'Affected line' + (alert.lines.length > 1 ? 's' : '') + ': ' + alert.lines.join(', ')
      : 'No metro line identified';
    item.appendChild(affectedLines);
    container.appendChild(item);
  });
}

function metroIcon(lines, down) {
  return L.divIcon({
    className: 'metro' + (lines.length > 1 ? ' transfer' : '') + (down ? ' down' : ''),
    html: '<span style="background:' + (down ? '#d62728' : lineColours[lines[0]]) + '">M</span>',
    iconSize: [24, 24]   // 24 px tap area (WCAG 2.5.8); the visible square inside stays 14 px
  });
}

// Computers: small round dots along the lines, drawn on the map canvas. Transfer stations are white with a black ring.
function metroDotStyle(lines, down) {
  if (down) { return { radius: 7, weight: 2.5, color: '#7a0000', fillColor: '#d62728', fillOpacity: 1 }; }
  if (lines.length > 1) { return { radius: 7, weight: 2.5, color: '#000000', fillColor: '#ffffff', fillOpacity: 1 }; }
  return { radius: 6, weight: 2, color: '#ffffff', fillColor: lineColours[lines[0]], fillOpacity: 1 };
}

// Phones: dots when zoomed out, "M" icons when zoomed in. Computers always show the dots.
function showingIcons() {
  return !!metroIconLayer && map.getZoom() >= M_ICON_ZOOM;
}

function updateMetroView() {
  if (!metroLayer) { return; }
  const icons = showingIcons();
  if (icons && map.hasLayer(metroLayer)) { map.removeLayer(metroLayer); }
  if (!icons && !map.hasLayer(metroLayer)) { map.addLayer(metroLayer); }
  if (!metroIconLayer) { return; }
  if (icons && !map.hasLayer(metroIconLayer)) { map.addLayer(metroIconLayer); }
  if (!icons && map.hasLayer(metroIconLayer)) { map.removeLayer(metroIconLayer); }
}

// The station's dot or "M" icon, whichever is on the map now.
function shownMetro(id) {
  return showingIcons() ? metroIconById[id] : metroById[id];
}

function latLngsFor(ids) {
  return ids.map(function (id) { return metroById[id].getLatLng(); });
}

// One polyline per line, through its stations in order, under the BIXI dots.
function drawMetroLines() {
  map.createPane('metroLines').style.zIndex = 350;
  Object.keys(lineOrder).forEach(function (line) {
    L.polyline(latLngsFor(lineOrder[line]), {
      pane: 'metroLines', color: lineColours[line], weight: 3, opacity: 0.8, interactive: false
    }).addTo(map);
  });
  disruptionLayer = L.layerGroup().addTo(map);
}

// Down stations turn red; a stretch between two down stations in a row turns red; a disruption we cannot place
// on specific stations draws the whole line dashed red.
function updateMetroMarkers() {
  if (!metroLayer) { return; }
  const disruptions = metroAlerts.filter(function (alert) { return alert.kind === 'disruption'; });
  const down = new Set();
  disruptions.forEach(function (alert) { alert.stations.forEach(function (id) { down.add(id); }); });

  [metroLayer, metroIconLayer].forEach(function (group) {
    if (!group) { return; }
    group.eachLayer(function (layer) {
      const lines = layer.feature.properties.lines.split(' / ');
      const isDown = down.has(layer.feature.properties.metro_id);
      if (layer.setIcon) { layer.setIcon(metroIcon(lines, isDown)); } else { layer.setStyle(metroDotStyle(lines, isDown)); }
    });
  });

  disruptionLayer.clearLayers();
  Object.keys(lineOrder).forEach(function (line) {
    const order = lineOrder[line];
    for (let i = 1; i < order.length; i++) {
      if (down.has(order[i - 1]) && down.has(order[i])) {
        L.polyline(latLngsFor([order[i - 1], order[i]]), {
          pane: 'metroLines', color: '#d62728', weight: 7, interactive: false
        }).addTo(disruptionLayer);
      }
    }
    const unplaced = disruptions.some(function (alert) { return alert.wholeLine && alert.lines.indexOf(line) > -1; });
    if (unplaced) {
      L.polyline(latLngsFor(order), {
        pane: 'metroLines', color: '#d62728', weight: 3, dashArray: '8 8', interactive: false
      }).addTo(disruptionLayer);
    }
  });
}

function loadMetroStatus() {
  return fetch(STM_STATUS_URL)
    .then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) { throw new Error(data.error || 'HTTP ' + response.status + ' loading STM service status'); }
        return data;
      });
    })
    .then(function (data) {
      if (!Array.isArray(data.alerts)) {
        throw new Error('STM service-status response did not contain an alerts array.');
      }
      // The feed mixes bus and metro notices: keep only metro ones that are in effect right now.
      metroAlerts = data.alerts.filter(isActiveNow).map(classifyAlert).filter(Boolean);
      renderMetroAlerts(metroAlerts);
      updateMetroMarkers();
      document.getElementById('stm-updated').textContent =
        'Checked at ' + new Date().toLocaleTimeString() + (metroLayer ? '' :
          '. The metro station file did not load, so notices are listed here but not shown on the map.');
    })
    .catch(function (error) {
      metroAlerts = [];
      updateMetroMarkers();
      document.getElementById('stm-alerts').textContent =
        'STM service status could not be loaded. Check the local server and API key.';
      document.getElementById('stm-updated').textContent = 'STM feed unavailable';
      console.error(error);
    });
}

// "Only stations near a metro": the notebook saved each station's distance to its nearest metro.
function passesNearFilter(layer) {
  return !nearOnly || layer.feature.properties.metro_dist_m <= walkM;
}

function inSelection(layer) {
  return map.distance(selection.latlng, layer.getLatLng()) <= selection.radius;
}

// Phones show every BIXI station. Computers show none until a place is chosen, then only those inside its circle.
function refilter() {
  stationsLayer.clearLayers();
  const waiting = !isPhone && !selection;
  allStations.forEach(function (layer) {
    if (waiting) { return; }
    if (!passesNearFilter(layer)) { return; }
    if (!isPhone && !inSelection(layer)) { return; }
    stationsLayer.addLayer(layer);
  });
  if (metroLayer && map.hasLayer(metroLayer)) { metroLayer.bringToFront(); }   // keep the metro dots drawn on top
  tripEnds.forEach(function (marker) { marker.bringToFront(); });              // and the trip's start and end dots
  scheduleOverview();
  const shown = stationsLayer.getLayers().length;
  const countEl = document.getElementById('count');
  if (!countEl) { return; }   // the live feed failed and the status line was replaced
  if (waiting) {
    countEl.textContent = allStations.length + ' BIXI stations. Choose your location or a métro station to see them';
  } else if (!isPhone) {
    countEl.textContent = shown + ' BIXI station' + (shown === 1 ? '' : 's') + ' within ' + distanceText(selection.radius) +
      ' of ' + selection.label + (nearOnly ? ' (only those near a metro)' : '');
  } else {
    countEl.textContent = nearOnly
      ? shown + ' of ' + allStations.length + ' stations within ' + walkM + ' m of a metro'
      : allStations.length + ' stations';
  }
}

// Draws (or moves) the one circle, shows the BIXI stations inside it and zooms to it.
function selectArea(latlng, radius, label) {
  selection = { latlng: latlng, radius: radius, label: label };
  document.querySelector('.radius-box').hidden = false;   // the walking-distance slider appears with the first circle
  setSliderMax(latlng);                                     // the slider reaches the farthest station from here
  if (selectCircle) {
    selectCircle.setLatLng(latlng).setRadius(radius);
  } else {
    selectCircle = L.circle(latlng, {
      radius: radius, pane: 'selectArea', interactive: false,
      color: '#111111', weight: 1.5, dashArray: '4 4', fill: false
    }).addTo(map);
  }
  refilter();
  map.fitBounds(latlng.toBounds(radius * 2), { padding: [20, 20], animate: false });
}

function selectMetro(layer) {
  selectArea(layer.getLatLng(), walkM, 'Métro ' + layer.feature.properties.metro_name);
}

function restyle() {
  allStations.forEach(function (layer) {
    const n = countFor(status[layer.feature.properties.station_id]);
    layer.setStyle({ fillColor: colourFor(n) });
  });
  scheduleOverview();
}

function loadStatus() {
  return fetch(STATUS_URL)
    .then(function (response) {
      if (!response.ok) { throw new Error('HTTP ' + response.status + ' loading station_status'); }
      return response.json();
    })
    .then(function (data) {
      status = {};
      data.data.stations.forEach(function (s) { status[s.station_id] = s; });
      restyle();
      document.getElementById('status').innerHTML = '<span id="count"></span>, live availability at ' +
        new Date(data.last_updated * 1000).toLocaleTimeString() + metroNote();
      refilter();
    })
    .catch(function (err) {
      document.getElementById('status').textContent =
        'Stations loaded, but live availability could not be fetched. Open the console (F12) for details.';
      console.error(err);
    });
}

function metroNote() {
  return metroLayer ? '' : '. Metro stations could not be loaded';
}

function getJSON(url) {
  return fetch(url).then(function (response) {
    if (!response.ok) { throw new Error('HTTP ' + response.status + ' loading ' + url); }
    return response.json();
  });
}

// The metro file is optional: if it fails, the Bixi map still works, just without metro stations and lines.
const metroFile = getJSON('../data/metro_stations.geojson').catch(function (err) {
  console.error(err);
  return null;
});

// The BIXI file is optional too: if it fails, the metro stations, lines and STM service status still show.
const bixiFile = getJSON('../data/bixi_stations.geojson').catch(function (err) {
  console.error(err);
  return null;
});

Promise.all([bixiFile, metroFile])
  .then(function (results) {
    const data = results[0];
    const metros = results[1];
    if (!data && !metros) { throw new Error('Neither the BIXI nor the metro station file could be loaded.'); }
    bixiMissing = !data;

    // Metro stations: round dots in the line's colour (white with a black ring at transfer stations).
    // Clicking one (dot or "M" icon) draws its circle, zooms in and opens its popup.
    const metroEvents = function (feature, layer) {
      layer.bindPopup(function () { return metroPopup(feature.properties, layer.getLatLng()); });
      layer.on('click', function () {
        selectMetro(layer);
        shownMetro(feature.properties.metro_id).openPopup();   // zooming in may have swapped the dot for an icon
      });
    };
    metroLayer = metros && L.geoJSON(metros, {
      pointToLayer: function (feature, latlng) {
        // Same canvas as the BIXI dots: a separate pane would put a second canvas on top that swallows their clicks.
        return L.circleMarker(latlng, metroDotStyle(feature.properties.lines.split(' / '), false));
      },
      onEachFeature: function (feature, layer) {
        metroById[feature.properties.metro_id] = layer;
        layer.bindTooltip('Métro ' + feature.properties.metro_name, { direction: 'top', offset: [0, -6] });
        metroEvents(feature, layer);
      }
    });
    // Phones: the "M" icons for when the map is zoomed in.
    metroIconLayer = metros && isPhone && L.geoJSON(metros, {
      pointToLayer: function (feature, latlng) {
        return L.marker(latlng, {
          icon: metroIcon(feature.properties.lines.split(' / '), false),
          title: 'Métro ' + feature.properties.metro_name,
          zIndexOffset: 1000
        });
      },
      onEachFeature: function (feature, layer) {
        metroIconById[feature.properties.metro_id] = layer;
        metroEvents(feature, layer);
      }
    });
    if (metroLayer) { drawMetroLines(); }

    const bixiLayer = L.geoJSON(data || [], {
      pointToLayer: function (feature, latlng) {
        return L.circleMarker(latlng, {
          radius: isPhone ? 5 : 4, weight: 1, color: '#4a4a4a', fillOpacity: 1, fillColor: classes[4].colour
        });
      },
      onEachFeature: function (feature, layer) {
        // A function, so the popup shows the latest status when it opens.
        layer.bindPopup(function () { return popupFor(feature.properties); });
      }
    });
    allStations = bixiLayer.getLayers();
    stationsLayer = L.layerGroup().addTo(map);
    if (metroLayer) {
      updateMetroView();
      map.on('zoomend', updateMetroView);
    }

    addControls();
    addLocateControl();
    setUpFindBox(metros);
    setUpTripCheck(metros);
    if (bixiMissing) {
      document.getElementById('status').textContent = 'The BIXI station file could not be loaded, so only métro ' +
        'stations and STM service status are shown. Try reloading the page.';
    } else {
      document.getElementById('status').innerHTML = '<span id="count"></span>, loading live availability...' + metroNote();
      refilter();
      loadStatus();
      setInterval(loadStatus, REFRESH_MS);
    }
    loadMetroStatus();
    setInterval(loadMetroStatus, STM_REFRESH_MS);
  })
  .catch(function (err) {
    document.getElementById('status').textContent =
      'Could not load the BIXI or the metro station file, so the map cannot show any stations. Try reloading the page.';
    document.getElementById('stm-updated').textContent =
      'STM service status was not checked, because the map could not load its station data. Try reloading the page.';
    console.error(err);
  });

// A map panel whose heading is a button: click it to fold the panel away and see more of the map.
function collapsiblePanel(className, headingHTML, bodyHTML) {
  const div = L.DomUtil.create('div', className + ' collapsed');   // starts closed
  div.innerHTML = '<button type="button" class="panel-toggle" aria-expanded="false">' + headingHTML +
    '<i class="arrow" aria-hidden="true"></i></button><div class="panel-body">' + bodyHTML + '</div>';
  const button = div.querySelector('.panel-toggle');
  button.addEventListener('click', function () {
    const collapsed = div.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
  });
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  return div;
}

function addControls() {
  // The toggle: bikes or docks.
  const toggle = L.control({ position: 'topright' });
  toggle.onAdd = function () {
    const div = collapsiblePanel('panel', '<strong>I want to...</strong>',
      '<label><input type="radio" name="mode" value="bikes" checked> take a bike</label>' +
      '<label><input type="radio" name="mode" value="docks"> return a bike</label>' +
      '<hr><label><input type="checkbox" id="near-only"> Only stations near a metro (<span class="walk-m">' + walkM +
      '</span> m)</label>');
    div.addEventListener('change', function (e) {
      if (e.target.id === 'near-only') {
        nearOnly = e.target.checked;
        refilter();
        return;
      }
      mode = e.target.value;
      document.getElementById('legend-title').textContent = mode === 'bikes' ? 'Bikes available' : 'Free docks';
      restyle();
      refilter();
    });
    return div;
  };
  toggle.addTo(map);

  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = function () {
    return collapsiblePanel('panel legend', '<strong id="legend-title">Bikes available</strong>',
      classes.map(function (c) {
        return '<span class="patch-key" style="background:' + c.colour + '"></span>' + c.label;
      }).join('<br>') +
      '<br><span class="patch-key" style="background:' + METRO_LAND + '"></span>Land nearest a métro station' +
      '<br><span class="metro-key round"></span>Metro station (white: transfer)' +
      (isPhone ? '<br><span class="metro-key">M</span>Metro station, zoomed in' : '') +
      '<br><span class="down-key round"></span>Station affected by a disruption' +
      '<br><span class="area-key"></span>Your walking distance' +
      '<br><span class="line-key"></span>Disrupted stretch of line' +
      '<br><span class="line-key dashed"></span>Disruption, stations unknown');
  };
  legend.addTo(map);
}

// Messages about finding a place go to the map button and to the yellow box in the side panel.
let locateDot, locateMsg;

let locateMsgTimer;

// On phones the message beside the map button disappears after 4 seconds, so it does not cover the map.
// (It stays in the side panel under "More information".)
function setFindMessage(text) {
  [locateMsg, document.getElementById('find-msg')].forEach(function (el) { if (el) { el.textContent = text; } });
  if (isPhone && locateMsg) {
    clearTimeout(locateMsgTimer);
    locateMsgTimer = setTimeout(function () { locateMsg.textContent = ''; }, 4000);
  }
}

function startLocate() {
  setFindMessage('Finding your location...');
  map.locate({ setView: false, enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

// "Show my location": a button under the zoom buttons. It asks for the location only when clicked.
function addLocateControl() {
  const control = L.control({ position: 'topleft' });
  control.onAdd = function () {
    const div = L.DomUtil.create('div', 'locate');
    div.innerHTML = '<button type="button" class="locate-button" title="Show my location" ' +
      'aria-label="Show my location and the transit within walking distance">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">' +
      '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>' +
      '<path d="M12 1v4M12 19v4M1 12h4M19 12h4"/></svg></button>' +
      '<p class="locate-msg" aria-live="polite"></p>';
    locateMsg = div.querySelector('.locate-msg');
    div.querySelector('button').addEventListener('click', startLocate);
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  control.addTo(map);

  map.on('locationfound', function (e) {
    if (!MONTREAL_BOUNDS.contains(e.latlng)) {
      setFindMessage('You seem to be outside Montréal, so the map stays where it is.');
      return;
    }
    if (locateDot) {
      locateDot.setLatLng(e.latlng);
    } else {
      locateDot = L.circleMarker(e.latlng, {
        radius: 7, weight: 3, color: '#ffffff', fillColor: '#1a73e8', fillOpacity: 1
      }).addTo(map);
    }
    locateDot.bindPopup('<strong>You are here</strong><br><small>Accurate to about ' +
      Math.round(e.accuracy) + ' m</small>');
    map.closePopup();   // e.g. a metro popup from an earlier choice
    selectArea(e.latlng, walkM, 'you');
    setFindMessage('Showing ' + walkM + ' m around you.');
  });

  map.on('locationerror', function (e) {
    setFindMessage(e.code === 1
      ? 'Location access was blocked. You can allow it in your browser settings.'
      : 'Your location could not be found. Try again in a moment.');
  });
}

// The metro_id whose name matches what was typed (exact first, then partial), or undefined.
function findMetroId(text) {
  const typed = normalise(text);
  const ids = Object.keys(metroById);
  const nameOf = function (id) { return normalise(metroById[id].feature.properties.metro_name); };
  return ids.find(function (i) { return nameOf(i) === typed; }) ||
    ids.find(function (i) { return nameOf(i).indexOf(typed) > -1; });
}

// The yellow box in the side panel: "Use my location" and the metro station search.
function setUpFindBox(metros) {
  document.getElementById('find-me').addEventListener('click', startLocate);
  const form = document.getElementById('metro-search');
  if (!metros) {
    form.hidden = true;
    return;
  }
  const names = Object.keys(metroById).map(function (id) { return metroById[id].feature.properties.metro_name; })
    .sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  const list = document.getElementById('metro-names');
  names.forEach(function (name) {
    const option = document.createElement('option');
    option.value = name;
    list.appendChild(option);
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const typed = document.getElementById('metro-input').value;
    if (!typed.trim()) { setFindMessage('Type the name of a métro station.'); return; }
    const id = findMetroId(typed);
    if (!id) { setFindMessage('No métro station matches that name. Pick one from the list.'); return; }
    const layer = metroById[id];
    selectMetro(layer);
    shownMetro(id).openPopup();
    setFindMessage('Showing ' + walkM + ' m around Métro ' + layer.feature.properties.metro_name + '.');
  });
}

// Phones: the header shows only the title; "More information" opens the status line and the side panel.
document.getElementById('info-toggle').addEventListener('click', function () {
  const open = document.body.classList.toggle('info-open');
  this.setAttribute('aria-expanded', String(open));
  this.textContent = open ? 'Less information' : 'More information';
  map.invalidateSize();   // the map got shorter or taller
});

// ---- Walking distance slider ----------------------------------------------------------------------------

// "3:45" (minutes:seconds) under an hour, "2 h 05" beyond.
function walkTimeText(metres) {
  const seconds = Math.round(metres / WALK_M_PER_MIN * 60);
  if (seconds >= 3600) {
    const minutes = Math.round(seconds / 60);
    return Math.floor(minutes / 60) + ' h ' + String(minutes % 60).padStart(2, '0');
  }
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

// "300 m" or "12.5 km"
function distanceText(metres) {
  return metres >= 1000 ? (metres / 1000).toFixed(1).replace(/\.0$/, '') + ' km' : metres + ' m';
}

// The slider runs from 100 m to the farthest station from the chosen place, spaced proportionally:
// the left half covers about 100 m to 2 km (short walks stay easy to pick), the right half reaches every station.
const MIN_WALK_M = 100;
let maxWalkM = 1500;

function metresFor(position) {
  const m = MIN_WALK_M * Math.pow(maxWalkM / MIN_WALK_M, position / 1000);
  const step = m < 1000 ? 50 : m < 10000 ? 100 : 500;
  return Math.min(maxWalkM, Math.round(m / step) * step);
}

function positionFor(metres) {
  return Math.round(1000 * Math.log(metres / MIN_WALK_M) / Math.log(maxWalkM / MIN_WALK_M));
}

// The farthest BIXI or metro station from this place, rounded up to the next kilometre (at least 1.5 km).
function setSliderMax(latlng) {
  let far = 1500;
  allStations.concat(Object.keys(metroById).map(function (id) { return metroById[id]; })).forEach(function (layer) {
    far = Math.max(far, map.distance(latlng, layer.getLatLng()));
  });
  maxWalkM = Math.ceil(far / 1000) * 1000;
  walkM = Math.min(walkM, maxWalkM);
  document.getElementById('walk-slider').value = positionFor(walkM);
  updateWalkLabels();
}

function updateWalkLabels() {
  document.getElementById('radius-value').textContent = (walkM / 1000).toFixed(2);
  document.getElementById('walk-value').textContent = walkTimeText(walkM);
  document.querySelectorAll('.walk-m').forEach(function (el) { el.textContent = walkM; });
  const [min, sec] = walkTimeText(walkM).split(':');
  document.getElementById('walk-slider').setAttribute('aria-valuetext',
    walkM + ' metres, about ' + Number(min) + ' minutes ' + Number(sec) + ' seconds of walking');
}

(function setUpSlider() {
  const slider = document.getElementById('walk-slider');
  slider.value = positionFor(walkM);
  updateWalkLabels();
  slider.addEventListener('input', function () {
    walkM = metresFor(Number(slider.value));
    updateWalkLabels();
    if (selection) {
      selection.radius = walkM;
      selectCircle.setRadius(walkM);
      setFindMessage('Showing ' + distanceText(walkM) + ' around ' + selection.label + '.');
    }
    if (stationsLayer) { refilter(); }
  });
  // When the slider is let go, zoom so the whole circle fits.
  slider.addEventListener('change', function () {
    if (selection) { map.fitBounds(selection.latlng.toBounds(walkM * 2), { padding: [20, 20] }); }
  });
})();

// ---- Coloured land patches, donut and lists ----------------------------------------------------------------
// Inside the circle, each bit of land belongs to its nearest station (a Voronoi cell, cut to the circle).
// Worked out in Web Mercator metres; areas are corrected back to real square metres with cos(latitude)^2.

const CRS = L.CRS.EPSG3857;

function scheduleOverview() {
  if (overviewQueued) { return; }
  overviewQueued = true;
  requestAnimationFrame(function () { overviewQueued = false; updateOverview(); });
}

// Keeps the part of `poly` that is closer to a than to b.
function clipCloserTo(poly, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = (p.x - mx) * dx + (p.y - my) * dy, fq = (q.x - mx) * dx + (q.y - my) * dy;
    if (fp <= 0) { out.push(p); }
    if ((fp <= 0) !== (fq <= 0)) {
      const t = fp / (fp - fq);
      out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    }
  }
  return out;
}

function polygonArea(poly) {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) / 2;
}

function farthest(point, poly) {
  return poly.reduce(function (m, v) { return Math.max(m, Math.hypot(v.x - point.x, v.y - point.y)); }, 0);
}

// The categories the land is split into (map patches, donut slices and the "Top modes" list).
function landCategories() {
  const what = mode === 'bikes' ? 'bikes' : 'free docks';
  return [
    { id: 'metro', label: 'Métro station', colour: METRO_LAND },
    { id: 3, label: 'Bixi, 10 or more ' + what, colour: classes[3].colour },
    { id: 2, label: 'Bixi, 4 to 9 ' + what, colour: classes[2].colour },
    { id: 1, label: 'Bixi, 1 to 3 ' + what, colour: classes[1].colour },
    { id: 0, label: 'Bixi, no ' + what, colour: classes[0].colour },
    { id: 4, label: 'Bixi, closed / no data', colour: classes[4].colour },
    { id: 'none', label: 'No station nearby', colour: NO_STATION_LAND }
  ];
}

function bixiClass(stationId) {
  const n = countFor(status[stationId]);
  if (n === null) { return 4; }
  return classes.findIndex(function (c) { return n >= c.min && n <= c.max; });
}

// Splits the circle between the stations around it. Returns [{ category, latlngs, areaM2 }].
function landPatches(center, radius) {
  const c = CRS.project(center);
  const k = 1 / Math.cos(center.lat * Math.PI / 180);   // Mercator metres per real metre here
  const R = radius * k;
  const circle = [];
  for (let i = 0; i < 96; i++) {
    const a = i / 96 * 2 * Math.PI;
    circle.push({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) });
  }
  const reach = R + Math.max(R, 500 * k);   // stations just outside the circle can still own land inside it
  const sites = [];
  allStations.forEach(function (layer) {
    if (!passesNearFilter(layer)) { return; }
    sites.push({ p: CRS.project(layer.getLatLng()), category: bixiClass(layer.feature.properties.station_id) });
  });
  Object.keys(metroById).forEach(function (id) {
    sites.push({ p: CRS.project(metroById[id].getLatLng()), category: 'metro' });
  });
  const near = sites.filter(function (s) { return Math.hypot(s.p.x - c.x, s.p.y - c.y) <= reach; });
  if (!near.length) {
    return [{ category: 'none', poly: circle, areaM2: polygonArea(circle) / (k * k) }].map(toLatLngs);
  }

  // Stations go into grid squares, so each one only compares itself with stations nearby, ring by ring outward.
  const CELL = 400 * k;
  const grid = {};
  let minGX = Infinity, maxGX = -Infinity, minGY = Infinity, maxGY = -Infinity;
  near.forEach(function (site, i) {
    site.gx = Math.floor(site.p.x / CELL);
    site.gy = Math.floor(site.p.y / CELL);
    (grid[site.gx + ',' + site.gy] = grid[site.gx + ',' + site.gy] || []).push(i);
    minGX = Math.min(minGX, site.gx); maxGX = Math.max(maxGX, site.gx);
    minGY = Math.min(minGY, site.gy); maxGY = Math.max(maxGY, site.gy);
  });
  const maxRing = Math.max(maxGX - minGX, maxGY - minGY);

  const patches = [];
  near.forEach(function (site, i) {
    let cell = circle;
    let maxR = farthest(site.p, cell);
    for (let ring = 0; ring <= maxRing && cell.length >= 3; ring++) {
      if ((ring - 1) * CELL > 2 * maxR) { break; }   // every station from here on is too far away to take any land
      const ids = [];
      for (let gx = site.gx - ring; gx <= site.gx + ring; gx++) {
        for (let gy = site.gy - ring; gy <= site.gy + ring; gy++) {
          if (Math.max(Math.abs(gx - site.gx), Math.abs(gy - site.gy)) !== ring) { continue; }   // only this ring
          (grid[gx + ',' + gy] || []).forEach(function (j) { if (j !== i) { ids.push(j); } });
        }
      }
      ids.sort(function (a, b) {
        return Math.hypot(near[a].p.x - site.p.x, near[a].p.y - site.p.y) - Math.hypot(near[b].p.x - site.p.x, near[b].p.y - site.p.y);
      });
      for (let n = 0; n < ids.length && cell.length >= 3; n++) {
        const other = near[ids[n]];
        const d = Math.hypot(other.p.x - site.p.x, other.p.y - site.p.y);
        if (d > 2 * maxR) { continue; }   // too far away to take any of this cell
        if (d === 0) {                    // two stations in the same spot: the first one keeps the land
          if (ids[n] < i) { cell = []; }
          continue;
        }
        cell = clipCloserTo(cell, site.p, other.p);
        maxR = farthest(site.p, cell);
      }
    }
    if (cell.length >= 3) { patches.push({ category: site.category, poly: cell, areaM2: polygonArea(cell) / (k * k) }); }
  });
  return patches.map(toLatLngs);
}

function toLatLngs(patch) {
  patch.latlngs = patch.poly.map(function (v) { return CRS.unproject(L.point(v.x, v.y)); });
  return patch;
}

function updateOverview() {
  if (!patchLayer) { patchLayer = L.layerGroup().addTo(map); }
  patchLayer.clearLayers();
  const empty = !selection;
  document.getElementById('overview-empty').hidden = !empty;
  document.getElementById('overview').hidden = empty;
  document.getElementById('modes-block').hidden = empty;
  if (empty) { return; }

  const patches = landPatches(selection.latlng, selection.radius);
  const categories = landCategories();
  const byId = {};
  categories.forEach(function (cat) { byId[cat.id] = cat; cat.area = 0; });
  patches.forEach(function (patch) {
    const cat = byId[patch.category];
    cat.area += patch.areaM2;
    L.polygon(patch.latlngs, {
      pane: 'patches', interactive: false, color: '#ffffff', weight: 1.5, fillColor: cat.colour, fillOpacity: 0.6   // see-through enough to show the streets
    }).addTo(patchLayer);
  });

  const total = categories.reduce(function (sum, cat) { return sum + cat.area; }, 0);
  document.getElementById('land-area').textContent = hectaresText(total);
  const used = categories.filter(function (cat) { return cat.area > 0; });
  drawDonut(used, total);

  // Top modes: land area per category, largest first (hectares, like the acres in Morphocode).
  const top = document.getElementById('top-modes');
  top.replaceChildren();
  used.slice().sort(function (a, b) { return b.area - a.area; }).forEach(function (cat) {
    top.appendChild(listItem(cat.colour, cat.label, hectaresText(cat.area) + ' ha'));
  });

  // Right now: what is inside the circle.
  let stations = 0, bikes = 0, ebikes = 0, docks = 0;
  allStations.forEach(function (layer) {
    if (!passesNearFilter(layer) || !inSelection(layer)) { return; }
    stations += 1;
    const s = status[layer.feature.properties.station_id];
    if (s && s.is_installed && s.is_renting) {
      bikes += s.num_bikes_available;
      ebikes += s.num_ebikes_available || 0;
      docks += s.num_docks_available;
    }
  });
  const metros = Object.keys(metroById).map(function (id) { return metroById[id]; }).filter(inSelection);
  const now = document.getElementById('right-now');
  now.replaceChildren();
  if (bixiMissing) {
    now.appendChild(listItem(classes[4].colour, 'BIXI stations could not be loaded', ''));
  } else {
    now.appendChild(listItem(classes[3].colour, 'Bixi stations', stations));
    now.appendChild(listItem(classes[2].colour, 'Bikes available (electric)', bikes + ' (' + ebikes + ')'));
    now.appendChild(listItem(classes[1].colour, 'Free docks', docks));
  }
  now.appendChild(listItem(METRO_LAND, metros.length
    ? 'Métro: ' + metros.map(function (m) { return m.feature.properties.metro_name; }).join(', ')
    : 'Métro stations', metros.length));
}

// Square metres as hectares with thousands separators: "1,017.15"
function hectaresText(m2) {
  return (m2 / 10000).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function listItem(colour, name, value) {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = colour;
  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = name;
  const number = document.createElement('span');
  number.className = 'value';
  number.textContent = value;
  li.append(dot, label, number);
  return li;
}

// Donut chart: one ring segment per category, drawn with stroke dashes (pathLength 100 = the whole ring).
function drawDonut(categories, total) {
  const svg = document.getElementById('donut');
  let offset = 0;
  svg.innerHTML = categories.map(function (cat) {
    const share = total ? cat.area / total * 100 : 0;
    const arc = '<circle cx="80" cy="80" r="46" fill="none" stroke="' + cat.colour + '" stroke-width="48" pathLength="100"' +
      ' stroke-dasharray="' + share + ' ' + (100 - share) + '" stroke-dashoffset="' + (-offset) + '"' +
      ' transform="rotate(-90 80 80)"><title>' + escapeHTML(cat.label) + ': ' + Math.round(share) + '%</title></circle>';
    offset += share;
    return arc;
  }).join('');
  svg.setAttribute('aria-label', 'Share of land by nearest station: ' + categories.map(function (cat) {
    return cat.label + ' ' + Math.round(total ? cat.area / total * 100 : 0) + '%';
  }).join(', '));
}

// ---- Check a trip: A to B on the métro ----------------------------------------------------------------------
// Finds the métro route with the fewest stops (a change of line counts as 4 stops), then lists only the STM
// alerts on that route's lines and stations, and whether there are Bixi bikes at the start and docks at the end.

const TRANSFER_COST = 4;
let routeLayer;
let tripEnds = [];       // the start and end dots of the checked trip (click one to explore around it)

function linesAt(id) {
  return Object.keys(lineOrder).filter(function (line) { return lineOrder[line].indexOf(id) > -1; });
}

function metroName(id) {
  return metroById[id].feature.properties.metro_name;
}

// Dijkstra over (station, line) pairs. Returns [{ id, line }, ...] from start to end, or null.
function metroRoute(fromId, toId) {
  const cost = {}, prev = {}, done = {};
  const queue = [];
  linesAt(fromId).forEach(function (line) { const k = fromId + '|' + line; cost[k] = 0; queue.push(k); });
  while (queue.length) {
    queue.sort(function (a, b) { return cost[a] - cost[b]; });
    const key = queue.shift();
    if (done[key]) { continue; }
    done[key] = true;
    const id = key.split('|')[0], line = key.split('|')[1];
    if (id === toId) {
      const path = [];
      for (let k = key; k; k = prev[k]) { path.unshift({ id: k.split('|')[0], line: k.split('|')[1] }); }
      return path;
    }
    const order = lineOrder[line], i = order.indexOf(id);
    const next = [order[i - 1], order[i + 1]].filter(Boolean).map(function (n) { return [n + '|' + line, 1]; })
      .concat(linesAt(id).filter(function (l) { return l !== line; })
        .map(function (l) { return [id + '|' + l, TRANSFER_COST]; }));
    next.forEach(function (pair) {
      const c = cost[key] + pair[1];
      if (!done[pair[0]] && (cost[pair[0]] === undefined || c < cost[pair[0]])) {
        cost[pair[0]] = c;
        prev[pair[0]] = key;
        queue.push(pair[0]);
      }
    });
  }
  return null;
}

// Groups the path into legs: [{ line, ids: [...] }] (a change of line at the same station starts a new leg).
function routeLegs(path) {
  const legs = [];
  path.forEach(function (step) {
    const last = legs[legs.length - 1];
    if (last && last.line === step.line) { last.ids.push(step.id); return; }
    legs.push({ line: step.line, ids: [step.id] });   // first leg, or a change of line at this station
  });
  return legs.filter(function (leg) { return leg.ids.length > 1; });
}

function nearbyBixi(latlng) {
  const out = { stations: 0, bikes: 0, docks: 0 };
  allStations.forEach(function (layer) {
    if (map.distance(latlng, layer.getLatLng()) > walkM) { return; }
    out.stations += 1;
    const s = status[layer.feature.properties.station_id];
    if (s && s.is_installed && s.is_renting) { out.bikes += s.num_bikes_available; out.docks += s.num_docks_available; }
  });
  return out;
}

function untilText(date) {
  if (!date) { return 'Until further notice'; }
  const options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (date.getFullYear() !== new Date().getFullYear()) { options.year = 'numeric'; }
  return 'Posted until ' + date.toLocaleString('en-CA', options);
}

function issueCard(kind, heading, text, small) {
  const card = document.createElement('article');
  card.className = 'stm-alert' + (kind === 'disruption' ? '' : ' ' + kind);
  const title = document.createElement('strong');
  title.textContent = heading;
  card.appendChild(title);
  if (text) { const p = document.createElement('p'); p.textContent = text; card.appendChild(p); }
  if (small) { const sm = document.createElement('small'); sm.textContent = small; card.appendChild(sm); }
  return card;
}

// ---- Addresses: OpenStreetMap's Nominatim, only when "Check my route" is pressed ----
// Its rules: at most one request a second, and credit OpenStreetMap. Results are kept so repeats are free.
const GEOCODE_URL = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ca&bounded=1' +
  '&accept-language=en&viewbox=-74.05,45.75,-73.35,45.35&q=';
const geocodeCache = {};
let nextGeocodeAt = 0;

function geocode(text) {
  const key = normalise(text);
  if (geocodeCache[key]) { return Promise.resolve(geocodeCache[key]); }
  const wait = Math.max(0, nextGeocodeAt - Date.now());
  nextGeocodeAt = Date.now() + wait + 1100;
  return new Promise(function (resolve) { setTimeout(resolve, wait); })
    .then(function () { return fetch(GEOCODE_URL + encodeURIComponent(text)); })
    .then(function (response) {
      if (!response.ok) { throw new Error('HTTP ' + response.status + ' from the address search'); }
      return response.json();
    })
    .then(function (results) {
      if (!results.length) { return null; }
      const place = { latlng: L.latLng(Number(results[0].lat), Number(results[0].lon)),
        label: results[0].display_name.split(',').slice(0, 3).join(',').trim() };
      geocodeCache[key] = place;
      return place;
    });
}

// A métro station name typed exactly is used as the station; anything else is looked up as an address.
function resolvePlace(text) {
  const typed = normalise(text);
  const id = Object.keys(metroById).find(function (i) { return normalise(metroName(i)) === typed; });
  if (id) { return Promise.resolve({ latlng: metroById[id].getLatLng(), label: 'Métro ' + metroName(id), stationId: id }); }
  return geocode(text);
}

// The few métro stations closest to a place (the closest one is always included).
function nearestStations(latlng, count) {
  return Object.keys(metroById)
    .map(function (id) { return { id: id, d: map.distance(latlng, metroById[id].getLatLng()) }; })
    .sort(function (a, b) { return a.d - b.d; })
    .filter(function (x, i) { return i === 0 || x.d <= 2000; })
    .slice(0, count);
}

const STOP_MIN = 2, CHANGE_MIN = 5;   // rough métro times, only used to choose between stations

// The best plan: walk to a station, ride, walk from a station; or simply walk if that is quicker.
function planTrip(from, to) {
  const starts = from.stationId ? [{ id: from.stationId, d: 0 }] : nearestStations(from.latlng, 3);
  const ends = to.stationId ? [{ id: to.stationId, d: 0 }] : nearestStations(to.latlng, 3);
  let best = null;
  starts.forEach(function (a) {
    ends.forEach(function (b) {
      if (a.id === b.id) { return; }
      const path = metroRoute(a.id, b.id);
      if (!path) { return; }
      const legs = routeLegs(path);
      const stops = legs.reduce(function (n, leg) { return n + leg.ids.length - 1; }, 0);
      const minutes = (a.d + b.d) / WALK_M_PER_MIN + stops * STOP_MIN + (legs.length - 1) * CHANGE_MIN;
      if (!best || minutes < best.minutes) {
        best = { fromId: a.id, toId: b.id, walkStart: a.d, walkEnd: b.d, path: path, legs: legs, minutes: minutes };
      }
    });
  });
  const direct = map.distance(from.latlng, to.latlng);
  if (!best || direct / WALK_M_PER_MIN <= best.minutes) { return { walkOnly: true, direct: direct }; }
  return best;
}

function walkText(metres) {
  const distance = metres >= 1000 ? (metres / 1000).toFixed(1) + ' km' : (Math.round(metres / 10) * 10) + ' m';
  return 'about ' + distance + ' (' + Math.max(1, Math.round(metres / WALK_M_PER_MIN)) + ' min)';
}

function terminusFor(leg) {
  const order = lineOrder[leg.line];
  const forward = order.indexOf(leg.ids[leg.ids.length - 1]) > order.indexOf(leg.ids[0]);
  return metroName(forward ? order[order.length - 1] : order[0]);
}

// One numbered direction: a coloured circle, the instruction, and optionally the stops along the way.
function stepItem(colour, text, stops) {
  const li = document.createElement('li');
  li.style.setProperty('--step-colour', colour);
  if (colour === lineColours.Yellow) { li.className = 'dark-text'; }   // a white number would not show on yellow
  li.appendChild(document.createTextNode(text));
  if (stops) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Show the ' + stops.length + ' stations';
    const list = document.createElement('ol');
    list.className = 'stop-list';
    stops.forEach(function (name) { const s = document.createElement('li'); s.textContent = name; list.appendChild(s); });
    details.append(summary, list);
    li.appendChild(details);
  }
  return li;
}

function showTrip(from, to) {
  const plan = planTrip(from, to);
  const steps = document.getElementById('trip-steps');
  const issues = document.getElementById('trip-issues');
  steps.replaceChildren();
  issues.replaceChildren();
  const WALK_COLOUR = '#555555';

  if (plan.walkOnly) {
    steps.appendChild(stepItem(WALK_COLOUR, 'Walk ' + walkText(plan.direct) + ' from ' + from.label + ' to ' + to.label +
      '. Walking is quicker than taking the métro for this trip.'));
  } else {
    if (plan.walkStart) {
      steps.appendChild(stepItem(WALK_COLOUR, 'Walk ' + walkText(plan.walkStart) + ' from ' + from.label + ' to ' +
        metroName(plan.fromId) + ' station.'));
    }
    plan.legs.forEach(function (leg, n) {
      const first = metroName(leg.ids[0]), last = metroName(leg.ids[leg.ids.length - 1]);
      const ride = leg.ids.length - 1;
      steps.appendChild(stepItem(lineColours[leg.line],
        (n === 0 ? 'At ' + first + ', take' : 'At ' + first + ', change to') + ' the ' + leg.line + ' line toward ' +
        terminusFor(leg) + '. Ride ' + ride + ' stop' + (ride === 1 ? '' : 's') + ' and get off at ' + last + '.',
        leg.ids.map(metroName)));
    });
    if (plan.walkEnd) {
      steps.appendChild(stepItem(WALK_COLOUR, 'Walk ' + walkText(plan.walkEnd) + ' from ' + metroName(plan.toId) +
        ' station to ' + to.label + '.'));
    }
    steps.appendChild(stepItem('#111111', 'Arrive at ' + to.label + '.'));

    // Only the alerts on this route, named by line or station instead of STM's "Your line" / "Your stop".
    const routeIds = new Set(plan.path.map(function (step) { return step.id; }));
    const routeLines = plan.legs.map(function (leg) { return leg.line; });
    metroAlerts.forEach(function (alert) {
      const onRoute = alert.stations.filter(function (id) { return routeIds.has(id); });
      const lineHit = alert.wholeLine && alert.lines.some(function (line) { return routeLines.indexOf(line) > -1; });
      if (!onRoute.length && !lineHit) { return; }
      const where = onRoute.length
        ? onRoute.map(metroName).join(', ') + (alert.kind === 'notice' ? ' station' : '')
        : alert.lines.filter(function (line) { return routeLines.indexOf(line) > -1; }).join(', ') + ' line';
      issues.appendChild(issueCard(alert.kind, (alert.kind === 'disruption' ? 'Disruption: ' : 'Station notice: ') + where,
        alert.description, untilText(alert.until)));
    });
  }

  // A place far from every métro station is often the wrong match for a name (e.g. another campus).
  const FAR_M = 2000;
  [[from, plan.walkOnly ? 0 : plan.walkStart], [to, plan.walkOnly ? 0 : plan.walkEnd]].forEach(function (pair) {
    if (pair[1] > FAR_M) {
      issues.prepend(issueCard('notice', 'Check this place: ' + pair[0].label,
        'It is ' + walkText(pair[1]).split(' (')[0] + ' from the nearest métro station. ' +
        'If this is not the place you meant, add a street number or the neighbourhood.', ''));
    }
  });

  // Bixi at both ends: bikes where you start, docks where you finish.
  if (!bixiMissing) {
    const start = nearbyBixi(from.latlng);
    const end = nearbyBixi(to.latlng);
    if (!start.bikes) {
      issues.appendChild(issueCard('notice', 'Bixi: no bikes near ' + from.label,
        'No Bixi bikes available within ' + walkM + ' m of where you start right now.', ''));
    }
    if (!end.docks) {
      issues.appendChild(issueCard('notice', 'Bixi: no free docks near ' + to.label,
        'No free Bixi docks within ' + walkM + ' m of where you finish right now, so you may not be able to return a bike there.', ''));
    }
    issues.appendChild(issueCard('ok', 'Bixi backup', null, 'Within ' + walkM + ' m: ' + start.bikes + ' bikes near ' +
      from.label + ', ' + end.docks + ' free docks near ' + to.label + '.'));
  }
  if (!issues.querySelector('.stm-alert:not(.ok)')) {
    issues.prepend(issueCard('ok', plan.walkOnly ? 'No métro needed for this trip.'
      : 'No STM disruptions or notices on your route right now.', null, ''));
  }
  document.getElementById('trip-result').hidden = false;

  // On the map: start and end points, dashed walking lines, and the métro route highlighted under the coloured lines.
  if (!routeLayer) { routeLayer = L.layerGroup().addTo(map); }
  routeLayer.clearLayers();
  const walk = { pane: 'selectArea', interactive: false, color: '#111111', weight: 2, dashArray: '2 6' };
  const points = [from.latlng, to.latlng];
  if (plan.walkOnly) {
    L.polyline(points, walk).addTo(routeLayer);
  } else {
    L.polyline([from.latlng, metroById[plan.fromId].getLatLng()], walk).addTo(routeLayer);
    L.polyline([metroById[plan.toId].getLatLng(), to.latlng], walk).addTo(routeLayer);
    plan.legs.forEach(function (leg) {
      L.polyline(latLngsFor(leg.ids), { pane: 'selectArea', interactive: false, color: '#111111', weight: 10, opacity: 0.3 })
        .addTo(routeLayer);
      latLngsFor(leg.ids).forEach(function (p) { points.push(p); });
    });
  }
  // The two ends are clickable: each opens the walking-distance explorer (circle, land patches, Bixi) around it.
  tripEnds = [[from, 'Start', '#111111'], [to, 'End', '#c0261f']].map(function (end) {
    const place = end[0];
    return L.circleMarker(place.latlng, { radius: 9, weight: 3, color: '#ffffff', fillColor: end[2], fillOpacity: 1 })
      .bindTooltip(end[1] + ': ' + place.label, { direction: 'top', offset: [0, -8] })
      .on('click', function () {
        map.closePopup();
        selectArea(place.latlng, walkM, place.label);
        setFindMessage('Showing ' + walkM + ' m around ' + place.label + '.');
      })
      .addTo(routeLayer);
  });
  map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  L.popup({ offset: [0, -8], maxWidth: 240 })
    .setLatLng(from.latlng)
    .setContent('<strong>See what is waiting at each end</strong><br>' + (isPhone ? 'Tap' : 'Click') +
      ' the black start dot or the red end dot ' +
      'to see the Bixi bikes and free docks within walking distance.')
    .openOn(map);
}

function setUpTripCheck(metros) {
  const form = document.getElementById('trip-form');
  if (!metros) {
    form.hidden = true;
    document.getElementById('trip-msg').textContent = 'The métro station file did not load, so trips cannot be checked.';
    return;
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const msg = document.getElementById('trip-msg');
    const button = form.querySelector('button');
    const fromText = document.getElementById('trip-from').value.trim();
    const toText = document.getElementById('trip-to').value.trim();
    if (!fromText || !toText) { msg.textContent = 'Type where you start and where you are going.'; return; }
    msg.textContent = 'Looking up your addresses...';
    button.disabled = true;
    // One after the other, so the address search gets at most one request a second.
    resolvePlace(fromText).then(function (from) {
      return resolvePlace(toText).then(function (to) { return [from, to]; });
    }).then(function (places) {
      const missing = [fromText, toText].filter(function (t, i) { return !places[i]; });
      if (missing.length) {
        msg.textContent = 'Could not find "' + missing.join('" or "') + '" in Montréal. Try adding a street number or the neighbourhood.';
        return;
      }
      msg.textContent = '';
      showTrip(places[0], places[1]);
    }).catch(function (err) {
      console.error(err);
      msg.textContent = 'The address search is not available right now. You can still type métro station names.';
    }).finally(function () { button.disabled = false; });
  });
}
