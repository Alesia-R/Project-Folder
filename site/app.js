// BIXI stations: positions from the notebook's GeoJSON, availability live from BIXI's GBFS feed.
// Metro stations: from the STM's GTFS feed, cross-listed with BIXI in the notebook.

// On phones, start zoomed in on downtown so the metro markers do not overlap (touch targets, WCAG 2.5.8).
const isPhone = window.matchMedia('(max-width: 700px)').matches;
const map = L.map('map', { preferCanvas: true })
  .setView(isPhone ? [45.505, -73.57] : [45.52, -73.6], isPhone ? 14 : 12);
map.createPane('selectArea').style.zIndex = 340;   // the chosen circle, under the metro lines and the BIXI dots
map.createPane('metroStops').style.zIndex = 450;   // computer metro dots, above the BIXI dots

// Esri World Street Map: a clean street map with street names, softer than OpenStreetMap. No API key needed.
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Base map &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, USGS, &copy; OpenStreetMap contributors | Station data: <a href="https://bixi.com/en/open-data">BIXI Montréal</a>'
}).addTo(map);

const STATUS_URL = 'https://gbfs.velobixi.com/gbfs/en/station_status.json';
const REFRESH_MS = 60 * 1000;   // GBFS updates often; once a minute is plenty
const STM_STATUS_URL = '/api/stm/service-status';
const STM_REFRESH_MS = 60 * 1000;

// Colour classes: how many of the thing you are looking for (bikes or docks).
const classes = [
  { label: 'None', min: 0, max: 0, colour: '#d62728' },
  { label: '1 to 3', min: 1, max: 3, colour: '#ff7f0e' },
  { label: '4 to 9', min: 4, max: 9, colour: '#bcbd22' },
  { label: '10 or more', min: 10, max: Infinity, colour: '#2ca02c' },
  { label: 'Closed / no data', colour: '#999999' }
];

const WALK_M = 300;      // same cut-off as the notebook: "near a metro"
const LOCATE_RADIUS_M = 700;   // "Use my location" shows the BIXI stations within this radius
const METRO_RADIUS_M = WALK_M; // a chosen metro station shows the BIXI stations within this radius (same as its popup)
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
let nearOnly = false;    // the filter: only BIXI stations within WALK_M of a metro
let stationsLayer;       // the BIXI circles on the map (all of them, or only the near ones)
let allStations = [];    // every BIXI circle, shown or not
let metroLayer;
let metroById = {};      // metro_id -> marker
let disruptionLayer;     // red segments and dashed lines drawn over the metro lines
let selection = null;    // { latlng, radius, label }: the circle chosen by location, metro click or search
let selectCircle;        // the circle drawn for it
let bixiMissing = false; // the BIXI station file did not load: the map shows only the metro and STM status
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

// Live totals for the BIXI stations within WALK_M of a metro station, counted on the fly.
function metroPopup(p, latlng) {
  let stations = 0, bikes = 0, docks = 0;
  allStations.forEach(function (layer) {
    if (map.distance(latlng, layer.getLatLng()) > WALK_M) { return; }
    stations += 1;
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
  if (stations === 0) { return html + '<br><em>No BIXI station within ' + WALK_M + ' m</em>'; }
  return html + '<br>' + stations + ' BIXI station' + (stations > 1 ? 's' : '') + ' within ' + WALK_M + ' m (' +
    p.docks_nearby + ' docks)<br>Right now: ' + bikes + ' bikes, ' + docks + ' free docks';
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
    return { kind: 'notice', title: title, description: description, lines: lines, stations: stations, wholeLine: false };
  }
  if (!stations.length) {
    const text = normalise(texts);
    lines.forEach(function (line) { stations = stations.concat(stationsFromText(text, line)); });
  }
  return { kind: 'disruption', title: title, description: description, lines: lines, stations: stations,
    wholeLine: stations.length === 0 };
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
  if (down) { return { radius: 5, weight: 2, color: '#7a0000', fillColor: '#d62728', fillOpacity: 1 }; }
  if (lines.length > 1) { return { radius: 5, weight: 2, color: '#000000', fillColor: '#ffffff', fillOpacity: 1 }; }
  return { radius: 4, weight: 1.5, color: '#ffffff', fillColor: lineColours[lines[0]], fillOpacity: 1 };
}

function latLngsFor(ids) {
  return ids.map(function (id) { return metroById[id].getLatLng(); });
}

// One polyline per line, through its stations in order, under the BIXI dots.
function drawMetroLines() {
  map.createPane('metroLines').style.zIndex = 350;
  Object.keys(lineOrder).forEach(function (line) {
    L.polyline(latLngsFor(lineOrder[line]), {
      pane: 'metroLines', color: lineColours[line], weight: 5, opacity: 0.85, interactive: false
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

  metroLayer.eachLayer(function (layer) {
    const lines = layer.feature.properties.lines.split(' / ');
    const isDown = down.has(layer.feature.properties.metro_id);
    if (layer.setIcon) { layer.setIcon(metroIcon(lines, isDown)); } else { layer.setStyle(metroDotStyle(lines, isDown)); }
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

function inSelection(layer) {
  return map.distance(selection.latlng, layer.getLatLng()) <= selection.radius;
}

// Phones show every BIXI station. Computers show none until a place is chosen, then only those inside its circle.
function refilter() {
  stationsLayer.clearLayers();
  const waiting = !isPhone && !selection;
  allStations.forEach(function (layer) {
    if (waiting) { return; }
    if (nearOnly && !layer.feature.properties.near_metro) { return; }
    if (!isPhone && !inSelection(layer)) { return; }
    stationsLayer.addLayer(layer);
  });
  const shown = stationsLayer.getLayers().length;
  const countEl = document.getElementById('count');
  if (!countEl) { return; }   // the live feed failed and the status line was replaced
  if (waiting) {
    countEl.textContent = allStations.length + ' BIXI stations. Choose your location or a métro station to see them';
  } else if (!isPhone) {
    countEl.textContent = shown + ' BIXI station' + (shown === 1 ? '' : 's') + ' within ' + selection.radius +
      ' m of ' + selection.label + (nearOnly ? ' (only those near a metro)' : '');
  } else {
    countEl.textContent = nearOnly
      ? shown + ' of ' + allStations.length + ' stations within ' + WALK_M + ' m of a metro'
      : allStations.length + ' stations';
  }
}

// Draws (or moves) the one circle, shows the BIXI stations inside it and zooms to it.
function selectArea(latlng, radius, label) {
  selection = { latlng: latlng, radius: radius, label: label };
  if (selectCircle) {
    selectCircle.setLatLng(latlng).setRadius(radius);
  } else {
    selectCircle = L.circle(latlng, {
      radius: radius, pane: 'selectArea', interactive: false,
      color: '#1F2D5A', weight: 2, fillColor: '#1F2D5A', fillOpacity: 0.08
    }).addTo(map);
  }
  refilter();
  map.fitBounds(latlng.toBounds(radius * 2), { padding: [20, 20], animate: false });
}

function selectMetro(layer) {
  selectArea(layer.getLatLng(), METRO_RADIUS_M, 'Métro ' + layer.feature.properties.metro_name);
}

function restyle() {
  allStations.forEach(function (layer) {
    const n = countFor(status[layer.feature.properties.station_id]);
    layer.setStyle({ fillColor: colourFor(n) });
  });
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

    // Metro stations: a square in the line's colour; transfer stations get a black outline.
    metroLayer = metros && L.geoJSON(metros, {
      pointToLayer: function (feature, latlng) {
        const lines = feature.properties.lines.split(' / ');
        if (!isPhone) {
          return L.circleMarker(latlng, Object.assign({ pane: 'metroStops' }, metroDotStyle(lines, false)));
        }
        return L.marker(latlng, {
          icon: metroIcon(lines, false),
          title: 'Métro ' + feature.properties.metro_name,
          zIndexOffset: 1000
        });
      },
      onEachFeature: function (feature, layer) {
        metroById[feature.properties.metro_id] = layer;
        layer.bindPopup(function () { return metroPopup(feature.properties, layer.getLatLng()); });
        if (!isPhone) { layer.bindTooltip('Métro ' + feature.properties.metro_name, { direction: 'top', offset: [0, -4] }); }
        layer.on('click', function () { selectMetro(layer); });
      }
    });
    if (metroLayer) { drawMetroLines(); }

    const bixiLayer = L.geoJSON(data || [], {
      pointToLayer: function (feature, latlng) {
        return L.circleMarker(latlng, {
          radius: isPhone ? 5 : 3.5, weight: 1, color: '#ffffff', fillOpacity: 0.9, fillColor: '#999999'
        });
      },
      onEachFeature: function (feature, layer) {
        // A function, so the popup shows the latest status when it opens.
        layer.bindPopup(function () { return popupFor(feature.properties); });
      }
    });
    allStations = bixiLayer.getLayers();
    stationsLayer = L.layerGroup().addTo(map);
    if (metroLayer) { metroLayer.addTo(map); }

    addControls();
    addLocateControl();
    setUpFindBox(metros);
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
  const div = L.DomUtil.create('div', className);
  div.innerHTML = '<button type="button" class="panel-toggle" aria-expanded="true">' + headingHTML +
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
      '<hr><label><input type="checkbox" id="near-only"> Only stations near a metro (' + WALK_M + ' m)</label>');
    div.addEventListener('change', function (e) {
      if (e.target.id === 'near-only') {
        nearOnly = e.target.checked;
        refilter();
        return;
      }
      mode = e.target.value;
      document.getElementById('legend-title').textContent = mode === 'bikes' ? 'Bikes available' : 'Free docks';
      restyle();
    });
    return div;
  };
  toggle.addTo(map);

  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = function () {
    return collapsiblePanel('panel legend', '<strong id="legend-title">Bikes available</strong>',
      classes.map(function (c) {
        return '<span style="background:' + c.colour + '"></span>' + c.label;
      }).join('<br>') +
      (isPhone ? '<br><span class="metro-key">M</span>Metro station' +
        '<br><span class="down-key">M</span>Station affected by a disruption'
        : '<br><span class="metro-key round"></span>Metro station (white: transfer)' +
        '<br><span class="down-key round"></span>Station affected by a disruption') +
      '<br><span class="area-key"></span>Area you chose' +
      '<br><span class="line-key"></span>Disrupted stretch of line' +
      '<br><span class="line-key dashed"></span>Disruption, stations unknown');
  };
  legend.addTo(map);
}

// Messages about finding a place go to the map button and to the yellow box in the side panel.
let locateDot, locateMsg;

function setFindMessage(text) {
  [locateMsg, document.getElementById('find-msg')].forEach(function (el) { if (el) { el.textContent = text; } });
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
      'aria-label="Show my location and the BIXI stations within ' + LOCATE_RADIUS_M + ' m">' +
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
    selectArea(e.latlng, LOCATE_RADIUS_M, 'you');
    setFindMessage('Showing ' + LOCATE_RADIUS_M + ' m around you.');
  });

  map.on('locationerror', function (e) {
    setFindMessage(e.code === 1
      ? 'Location access was blocked. You can allow it in your browser settings.'
      : 'Your location could not be found. Try again in a moment.');
  });
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
    const typed = normalise(document.getElementById('metro-input').value);
    if (!typed.trim()) { setFindMessage('Type the name of a métro station.'); return; }
    const ids = Object.keys(metroById);
    const nameOf = function (id) { return normalise(metroById[id].feature.properties.metro_name); };
    const id = ids.find(function (i) { return nameOf(i) === typed; }) ||
      ids.find(function (i) { return nameOf(i).indexOf(typed) > -1; });
    if (!id) { setFindMessage('No métro station matches that name. Pick one from the list.'); return; }
    const layer = metroById[id];
    selectMetro(layer);
    layer.openPopup();
    setFindMessage('Showing ' + METRO_RADIUS_M + ' m around Métro ' + layer.feature.properties.metro_name + '.');
  });
}
