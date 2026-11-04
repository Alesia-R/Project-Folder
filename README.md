# Bixi or Metro? Live Bixi availability around Montréal metro stations

GEOG 464, A2 MVP. Alesia Rambure-Keim.

## Five sentences

1. **Problem:** Right now the average commuter cannot easily find out whether it is more convenient to take a Bixi or the metro for a short distance, especially when there are delays in service or bikes are running out.
2. **Audience:** The average commuter, especially in high-density areas where many types of transport come together.
3. **Core action:** A commuter can see, right now, whether there are Bixi bikes (or free docks) at the stations within a 4-minute walk of their metro station.
4. **Data:** BIXI's open GBFS feed (station locations, and live bikes and docks), and the STM's GTFS feed (the 68 metro stations and their lines).
5. **Not a routing app:** the idea is real-time availability and service status for short distances, faster to read than opening both the transit app and the Bixi app.

## Folder

```
bixi-metro-mvp/
  data/
    bixi_station_information.json  BIXI station list, saved from the GBFS feed on 2026-10-09
    stm_metro_stations.csv         68 metro stations from the STM GTFS (stops.txt), with their lines
    bixi_stations.geojson          written by the notebook: 1,088 stations + nearest metro and distance
    metro_stations.geojson         written by the notebook: 68 stations + Bixi stations and docks within 300 m
  notebooks/
    bixi_metro.ipynb               reads, cleans, joins, writes and checks the two GeoJSON files
  site/
    index.html, style.css, app.js  the map page
  README.md
```

## How to run it

1. Open the whole `bixi-metro-mvp` folder in VS Code (not just `site/`, because the page loads `../data/`).
2. Run `notebooks/bixi_metro.ipynb` top to bottom. The last two cells should print `All checks passed` and `Metro file OK`.
3. Install Node.js 20.6 or newer if it is not already installed.
4. Create a `.env` file in the project folder (you can copy `.env.example`) and set `STM_API_KEY=your_stm_api_key`. Keep `.env` private; it is excluded from Git. The service-status endpoint uses the API key (`apiKey` request header); it does not require the separate API secret.
5. In a terminal opened at the project folder, run `node --env-file=.env server.js` and open `http://localhost:3000`. The local server securely proxies the STM service-status request. The STM feed and BIXI availability refresh every 60 seconds.

## The pipeline

- **Cleaning:** 1,121 stations in the feed. 33 dropped because they are outside a box around Greater Montréal: 4 test stations at 0, 0, 25 in Sherbrooke and 4 in Chambly. 0 duplicate ids. 1,088 kept. Columns kept: `station_id`, `name`, `capacity`.
- **Join:** both layers converted to MTM zone 8 (EPSG:32188) so distances are in metres. Each Bixi station gets its nearest metro (`metro_name`, `lines`, `metro_dist_m`) and `near_metro` (within 300 m, about a 4-minute walk). Each metro station gets `bixi_nearby` and `docks_nearby`.
- **Result:** 209 of 1,088 Bixi stations are within 300m of a metro station. Langelier is the only metro station with no Bixi station within 300m.
- **Live data:** bike and dock counts change every few seconds, so they are not saved in the GeoJSON. The page reads `station_status.json` from BIXI and joins it to the stations by `station_id`. A local server proxies STM's i3 service-status API so the key is not exposed in the browser.

## Sources and licences

| Data | Source | Licence |
|---|---|---|
| Bixi stations and live availability | [BIXI Montréal GBFS feed], listed on [Données Québec](https://www.donneesquebec.ca/recherche/fr/dataset/89fdc53c-cf70-485f-ab1a-9b10044d9f15) | Creative Commons Attribution, © BIXI Montréal |
| Metro stations and lines; live service status | [STM open data](https://www.stm.info/en/about/developers), listed on [Données Québec](https://www.donneesquebec.ca/recherche/fr/dataset/a0073997-3a02-4c34-8acf-758a2ee950f4) | CC BY 4.0, © Société de transport de Montréal |
| Basemap | Esri World Street Map | © Esri, HERE, Garmin, USGS, © OpenStreetMap contributors |

## Not in this iteration

- It does not include trip times or routing because this is not a routing app.
- Bixi stations outside Montréal are not supposed to be here, but some are shown. I'm not sure how to fix that. 
- It runs locally for A2 and a public link comes in A3.

## Testing

- **Check cells:** the notebook's check cells test the count (1,088), the coordinate system (EPSG:4326), a box around Montréal, and that every popup field exists. The box is what caught the 4 test stations at latitude 0, longitude 0, which would have put dots off the coast of Africa.
- **Stranger test:** Adam Garcia used the site to search for the nearest metro near his home. He was unable to find any bixi stations around his location since the radius for bixi stations around the metro that I had originally imput was too small, so I increased the size to 300m. 

## AI disclosure

- **Lane:** Blue
- **Tools and model:** I copied what I had used in lab 3 and 4 myself in order to help me model it. Then, I used the Bixi page and Claude in the Claude app. 
- **What I asked Claude:** Claude read the code I had written for my other labs, then helped me create the Bixi cell print each cleaning step's count, added a guard in `app.js` so the near-metro checkbox does not crash if the live feed fails, and drafted the souce and license part in this README. I also asked why my code failed at the last minute. It also helped me understand the Bixi GBFS. 
- **What I kept from my own work:** the Bixi/metro join, the 300 m cut-off, the live `station_status` fetch and the bike/dock toggle in `app.js`.
- **What I accepted, changed or rejected, and why:** I accepted the changes to the layout since they looked nice and the interace was easier to use. My code failed at the last minute, and I accepted the changes to help re-boot it -- I had too many copies on my computer, so I gave it permission to clean up my folders. Claude suggested adding some more complex parts to make it seem more professional and that is what I rejected. I rejected that because I did not fully understand the code and it was out of my rhelm, and not authentic to my work. Also, I kept that page reads `station_status.json` from BIXI and joins it to the stations by `station_id`. It also helped me create the Geojson for the bixi file and metro.
- **How I tested it:** I re-ran the notebook (both checks pass) and opened the page with Live Server. I checked it with my testing person as well. 
- **What stayed mine:** The idea, the audience, the story text, the 300 m choice, and cutting Twitter scraping from this iteration, the data, the information I put in. 

## After the demo
- neighbours answer: It would be nice if there was some way to connect the metro stops into actual lines so that it isnt just random stops. The visualisation would be better. 
- Today I will fix: I changed the display first and organized them in a way that presents all the stops as connected per line. For example, all greens tops, conencted with a through green line. 
Then, IF the metro station is down, I highlighted them in red, IF multiple sequential stations are down, I made the affected segment red. In the future, I will fix the bus data coming from the API to be connected to a busstop.sph in order to see the radius of metro stops that may also be down.  

## A3 card and three tests
 1. 
 2. 
 3. 

## Pre-flight report 
(Lab 7) | Check | Result | What I did | 
| --- | --- | --- | 
| 1. Cold start | pass / fault: It passed, no red lines. 

| 2. Read every label | 
    1. de la Gauchetière / St-Alexandre
    Capacity: 19 docks
    Nearest metro: Square-Victoria–OACI (Orange), 136 m
    No live data 

    Some bixi stations (when grey) read 'no live data' in the popup. It is also in the legend already. 

| 3. Ask twice | No issues. 

| 4. The edge | No issues. 

| 5. The data does not come | I blocked metro_stations.geojson data in Network and my entire map went blank. In the side panel, it just reads "Live STM service status. Loading STM service status..." and the title bar reads "Could not load the station files. Open the console (F12) for details." 
  The console is reading error "app.js:420 TypeError: Failed to fetch
    at getJSON (app.js:367:10)
    at app.js:373:56" 

    I made a change in app.js so that if the metro file crashes or if the bixi file crashes, instead of reading "Live STM service status
    Loading STM service status..." in the status bar, the description clearly describes what is happening. 

    The side bar now says "The sidebar says: "STM service status was not checked, because the map could not load its station data. Try reloading the page" if the bixi file fails. 

    If the metro file fails, it reads "Checked at 5:52 PM. The metro station file did not load, so notices are listed here but not shown on the map."

    I took "Open the console (F12) for details" out of the messages, since a commuter won't use it.

| 6. On a phone (size view and my phone) |
  The "want to..." and "Bikes available" tabs block the view of the map when it is on a phone. I added two toggle arrows that allows the user to close the tabs in order to see the map better. 

    The fold away panels both have a arrow beside their heading. Clicking the heading or the arrow to fold the panel down to just its title, and clickig it again opens it. 
    
    Both use the same small function, collapsiblePanel, and the styles are at the bottom of style.css.

| 7. Mouse in my pocket |



| 8. Accessibility audit | ... | ... |