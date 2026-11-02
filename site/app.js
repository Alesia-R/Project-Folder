// BIXI stations: positions from the notebook's GeoJSON, availability live from BIXI's GBFS feed.
// Metro stations: from the STM's GTFS feed, cross-listed with BIXI in the notebook.

const map = L.map('map', { preferCanvas: true }).setView([45.52, -73.6], 12);

// CARTO Positron: a quiet light-grey base map so the metro lines and Bixi dots stand out.
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  subdomains: 'abcd',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a> | Station data: <a href="https://bixi.com/en/open-data">BIXI Montréal</a>'
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
    iconSize: [16, 16]
  });
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
    layer.setIcon(metroIcon(lines, down.has(layer.feature.properties.metro_id)));
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
        'Checked at ' + new Date().toLocaleTimeString();
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

function refilter() {
  stationsLayer.clearLayers();
  allStations.forEach(function (layer) {
    if (!nearOnly || layer.feature.properties.near_metro) { stationsLayer.addLayer(layer); }
  });
  const shown = stationsLayer.getLayers().length;
  const countEl = document.getElementById('count');
  if (!countEl) { return; }   // the live feed failed and the status line was replaced
  countEl.textContent = nearOnly
    ? shown + ' of ' + allStations.length + ' stations within ' + WALK_M + ' m of a metro'
    : allStations.length + ' stations';
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
        new Date(data.last_updated * 1000).toLocaleTimeString();
      refilter();
    })
    .catch(function (err) {
      document.getElementById('status').textContent =
        'Stations loaded, but live availability could not be fetched. Open the console (F12) for details.';
      console.error(err);
    });
}

function getJSON(url) {
  return fetch(url).then(function (response) {
    if (!response.ok) { throw new Error('HTTP ' + response.status + ' loading ' + url); }
    return response.json();
  });
}

Promise.all([getJSON('../data/bixi_stations.geojson'), getJSON('../data/metro_stations.geojson')])
  .then(function (results) {
    const data = results[0];
    const metros = results[1];

    // Metro stations: a square in the line's colour; transfer stations get a black outline.
    metroLayer = L.geoJSON(metros, {
      pointToLayer: function (feature, latlng) {
        return L.marker(latlng, {
          icon: metroIcon(feature.properties.lines.split(' / '), false),
          title: 'Métro ' + feature.properties.metro_name,
          zIndexOffset: 1000
        });
      },
      onEachFeature: function (feature, layer) {
        metroById[feature.properties.metro_id] = layer;
        layer.bindPopup(function () { return metroPopup(feature.properties, layer.getLatLng()); });
      }
    });
    drawMetroLines();

    const bixiLayer = L.geoJSON(data, {
      pointToLayer: function (feature, latlng) {
        return L.circleMarker(latlng, {
          radius: 5, weight: 1, color: '#ffffff', fillOpacity: 0.9, fillColor: '#999999'
        });
      },
      onEachFeature: function (feature, layer) {
        // A function, so the popup shows the latest status when it opens.
        layer.bindPopup(function () { return popupFor(feature.properties); });
      }
    });
    allStations = bixiLayer.getLayers();
    stationsLayer = L.layerGroup().addTo(map);
    metroLayer.addTo(map);

    addControls();
    document.getElementById('status').innerHTML = '<span id="count"></span>, loading live availability...';
    refilter();
    loadStatus();
    setInterval(loadStatus, REFRESH_MS);
    loadMetroStatus();
    setInterval(loadMetroStatus, STM_REFRESH_MS);
  })
  .catch(function (err) {
    document.getElementById('status').textContent =
      'Could not load the station files. Open the console (F12) for details.';
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
      '<br><span class="metro-key">M</span>Metro station' +
      '<br><span class="down-key">M</span>Station affected by a disruption' +
      '<br><span class="line-key"></span>Disrupted stretch of line' +
      '<br><span class="line-key dashed"></span>Disruption, stations unknown');
  };
  legend.addTo(map);
}
