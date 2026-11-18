<h1 align="center">GOLD OUTLOOK</h1>
<h3 align="center">One metal. Four horizons. Show your work.</h3>

<p align="center">
  <img alt="Python 3.11+" src="https://img.shields.io/badge/python-3.11%2B-3776AB?logo=python&logoColor=white">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white">
  <img alt="scikit-learn" src="https://img.shields.io/badge/scikit--learn-F7931E?logo=scikitlearn&logoColor=white">
  <img alt="React + TypeScript" src="https://img.shields.io/badge/React-TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Tests" src="https://img.shields.io/badge/tests-266%20%2B%20190%20browser-2EA44F">
</p>

<p align="center">
  <a href="#run-it"><img alt="Run it" src="https://img.shields.io/badge/%E2%96%B6%20RUN%20IT-D6B878?style=for-the-badge&labelColor=0b0e12"></a>
  <a href="docs/GUIDE.md"><img alt="Full guide" src="https://img.shields.io/badge/FULL%20GUIDE-7AB6FF?style=for-the-badge&labelColor=0b0e12"></a>
  <a href="docs/GUIDE.md#current-measured-results"><img alt="Results" src="https://img.shields.io/badge/RESULTS-6B7480?style=for-the-badge&labelColor=0b0e12"></a>
</p>

<p align="center">
  <a href="#run-it"><img src="docs/screenshots/forecast-demo.gif" alt="Choose a horizon, press Predict, and the forecast is drawn on the same chart. Switch to Line, hide the forecast, open the Details tabs." width="920"></a>
</p>
<p align="center"><b>Pick a horizon. Press Predict. See it on the chart.</b></p>

<br>

<table>
<tr>
<td width="66%" align="center"><a href="docs/GUIDE.md#how-learning-works"><img src="docs/screenshots/learning-tour.gif" alt="Scrolling tour of the Learning page"></a></td>
<td width="34%" align="center"><a href="docs/GUIDE.md#the-screen"><img src="docs/screenshots/mobile-demo.gif" alt="Phone-sized Predict flow"></a></td>
</tr>
<tr>
<td align="center"><b>It shows its homework</b><br><sub>worker · active model per horizon · every candidate</sub></td>
<td align="center"><b>Works on your phone</b><br><sub>390 px, same workspace</sub></td>
</tr>
</table>

<table>
<tr>
<td width="50%" align="center"><a href="docs/GUIDE.md#paper-trading-simulation-only"><img src="docs/screenshots/paper.png" alt="Paper trading"></a></td>
<td width="50%" align="center"><a href="docs/GUIDE.md#alerts-sell-review-notifications"><img src="docs/screenshots/alerts-settings.png" alt="Alerts and settings"></a></td>
</tr>
<tr>
<td align="center"><b>Paper-trade it</b><br><sub>simulated · gold only · no broker</sub></td>
<td align="center"><b>Get alerted</b><br><sub>price levels via n8n + Twilio</sub></td>
</tr>
</table>

<br>

<a name="run-it"></a>
<h2 align="center">&#9654; Run it</h2>

```bash
./start.sh                       # installs, builds, opens the app
./scripts/worker.sh install      # optional: keeps learning with the browser closed (macOS)
```

<p align="center"><sub>Forecasts: next settlement · 1 · 5 · 20 sessions &nbsp;|&nbsp; COMEX gold futures (GC=F) &nbsp;|&nbsp; every forecast stored before its outcome exists</sub></p>

> [!NOTE]
> Honest by design: **no model beats "the price stays put" yet**, and the app says so on screen. [See the numbers →](docs/GUIDE.md#current-measured-results) &nbsp;·&nbsp; Not investment advice.

<p align="center"><a href="docs/GUIDE.md"><b>Full guide: how it learns, results, what is verified, operations →</b></a></p>
