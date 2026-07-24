# DrowsyGuard — IoT Driver Safety System

A browser-based driver drowsiness detector with a live fleet safety dashboard.

## Pages

- `index.html` — camera-based drowsiness detection using MediaPipe Face Mesh and Eye Aspect Ratio (EAR)
- `dashboard.html` — live fleet dashboard with MQTT telemetry, GPS mapping, alerts, history, and ThingSpeak charting

## Run locally

Open `index.html` for the detector or `dashboard.html` for the dashboard. Camera access works best when the site is served over HTTPS or from localhost.

## Deployment

This repository is published through GitHub Pages. The driver detector is available at the site root, and the dashboard is at `/dashboard.html`.

## Note

The current demo uses a public MQTT broker. Use an authenticated, private broker before connecting real vehicle or driver data.
