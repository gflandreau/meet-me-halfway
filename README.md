# Meet Me Halfway 💕

A cute, colorful web app that finds the perfect middle between two people. Enter two locations (address or zip) and it shows restaurants, cafés, and hangout spots near the geographic midpoint — great for dates, friend meetups, or anywhere you want to meet in between.

**Live site:** https://gflandreau.github.io/meet-me-halfway/

## How it works
- **Geocoding:** [Nominatim](https://nominatim.org/) (OpenStreetMap)
- **Places:** [Overpass API](https://overpass-api.de/)
- **Map:** [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles

All free, no API keys required.

## Run it locally
```bash
python -m http.server 5500 --directory .
```
Then open http://localhost:5500

## Tech
Plain HTML, CSS, and JavaScript — no build step.
