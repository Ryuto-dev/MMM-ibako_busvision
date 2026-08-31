#!/usr/bin/env node
/**
 * tools/preview.js
 *
 * MagicMirror 本体なしでモジュールの表示を確認するためのプレビューサーバ。
 * Module.register / translate / Log を最小実装で模擬し、
 * 実際の MMM-ibako_busvision.js と CSS をそのまま読み込んで描画する。
 *
 *   node tools/preview.js                       # 既定バス停 (東前団地西 上り/下り)
 *   node tools/preview.js --stops 345:1,200:1
 *   node tools/preview.js --port 8080
 *   node tools/preview.js --fixture             # 保存済み HTML を使う (通信しない)
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { parseApproachPage } = require("../lib/parser");
const { fetchApproach } = require("../lib/fetcher");

// --- 引数 -------------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = parseInt(getArg("port", "3000"), 10);
const USE_FIXTURE = argv.includes("--fixture");
/** --routes 52,50 を付けると mode:"route" のプレビューも表示する */
const ROUTES = getArg("routes", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const STOPS = getArg("stops", "345:1,345:2")
  .split(",")
  .map((s) => {
    const [stopCd, poleCd] = s.split(":");
    return { stopCd: parseInt(stopCd, 10), poleCd: parseInt(poleCd || "1", 10) };
  })
  .filter((s) => Number.isFinite(s.stopCd));

const FIXTURES = {
  "345:1": "before_departure.html",
  "345:2": "before_departure.html",
  "200:1": "running.html",
  "500:1": "no_bus.html"
};

// --- データ取得 -------------------------------------------------------------
async function loadStop (stop) {
  const key = `${stop.stopCd}:${stop.poleCd}`;
  if (USE_FIXTURE) {
    const file = FIXTURES[key] || "running.html";
    const html = fs.readFileSync(path.join(ROOT, "test/fixtures", file), "utf8");
    return { key, stop, data: parseApproachPage(html) };
  }
  const data = await fetchApproach(stop);
  return { key, stop, data };
}

// --- HTML 生成 --------------------------------------------------------------
function renderPage (payload, routes) {
  const moduleJs = fs.readFileSync(path.join(ROOT, "MMM-ibako_busvision.js"), "utf8");
  const moduleCss = fs.readFileSync(path.join(ROOT, "css/MMM-ibako_busvision.css"), "utf8");
  const ja = fs.readFileSync(path.join(ROOT, "translations/ja.json"), "utf8");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>MMM-ibako_busvision preview</title>
<style>
  /* MagicMirror 相当の最小スタイル */
  body {
    margin: 0; padding: 28px;
    background: #000; color: #fff;
    font-family: "Roboto", "Noto Sans JP", "Hiragino Sans", sans-serif;
    font-weight: 300;
    font-size: 20px;
    -webkit-font-smoothing: antialiased;
  }
  .dimmed  { color: #666; }
  .normal  { color: #999; }
  .bright  { color: #fff; }
  .xsmall  { font-size: 15px; line-height: 20px; }
  .small   { font-size: 19px; line-height: 25px; }
  .medium  { font-size: 26px; line-height: 32px; }
  .light   { font-weight: 300; }
  .region  { max-width: 480px; }
  .preview-frame {
    border: 1px dashed #333; padding: 14px; margin-bottom: 22px;
    max-width: 470px;
  }
  .preview-label { color:#555; font-size:13px; margin-bottom:8px; letter-spacing:.08em; }
${moduleCss}
</style>
</head>
<body>

<div class="preview-frame">
  <div class="preview-label">timeFormat: "both" / showLocation: true</div>
  <div id="mount-a" class="region"></div>
</div>

<div class="preview-frame">
  <div class="preview-label">compact: true / timeFormat: "relative"</div>
  <div id="mount-b" class="region"></div>
</div>

<div class="preview-frame">
  <div class="preview-label">走行中のみ (showBeforeDeparture: false)</div>
  <div id="mount-c" class="region"></div>
</div>

<div class="preview-frame">
  <div class="preview-label">mode: "route" — 系統 ${routes.join("/") || "(すべて)"} を統合して時刻順に表示</div>
  <div id="mount-d" class="region"></div>
</div>

<script>
// ---- MagicMirror API の最小モック ----------------------------------------
const PAYLOAD = ${JSON.stringify(payload)};
const ROUTES = ${JSON.stringify(routes)};
const TRANSLATIONS = ${ja};

const Log = { info: console.log, error: console.error, warn: console.warn, debug: () => {} };

const registry = {};
const Module = {
  register (name, def) { registry[name] = def; }
};

function instantiate (name, config, mountId) {
  const def = registry[name];
  const inst = Object.assign({
    name,
    identifier: "preview_" + mountId,
    hidden: false,
    data: { header: null },
    config: Object.assign({}, def.defaults, config),
    file: (f) => f,
    translate (key, vars) {
      let s = TRANSLATIONS[key];
      if (s === undefined) return key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.split("{" + k + "}").join(String(v));
        }
      }
      return s;
    },
    sendSocketNotification () {},
    sendNotification () {},
    updateDom () { render(inst, mountId); }
  }, def);

  if (typeof inst.start === "function") inst.start();

  // node_helper からのデータ到着を模擬
  for (const entry of PAYLOAD) {
    inst.socketNotificationReceived("IBAKO_DATA", {
      identifier: inst.identifier,
      key: entry.key,
      stop: entry.stop,
      data: entry.data
    });
  }
  render(inst, mountId);
  return inst;
}

function render (inst, mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  mount.innerHTML = "";
  mount.appendChild(inst.getDom());
}

// ---- モジュール本体を読み込む --------------------------------------------
${moduleJs}

// ---- 3 パターンで描画 ----------------------------------------------------
instantiate("MMM-ibako_busvision", {
  stops: PAYLOAD.map(e => e.stop),
  maxEntries: 4,
  showNotice: true,
  showRouteName: true
}, "mount-a");

instantiate("MMM-ibako_busvision", {
  stops: PAYLOAD.map(e => e.stop),
  maxEntries: 3,
  compact: true,
  timeFormat: "relative"
}, "mount-b");

instantiate("MMM-ibako_busvision", {
  stops: PAYLOAD.map(e => e.stop),
  maxEntries: 4,
  showBeforeDeparture: false
}, "mount-c");

instantiate("MMM-ibako_busvision", {
  mode: "route",
  routes: ROUTES,
  stops: PAYLOAD.map(e => e.stop),
  maxEntries: 8,
  showOriginPole: true
}, "mount-d");
</script>
</body>
</html>`;
}

// --- サーバ -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/data") {
      const payload = [];
      for (const stop of STOPS) payload.push(await loadStop(stop));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    const payload = [];
    for (const stop of STOPS) {
      try {
        payload.push(await loadStop(stop));
      } catch (err) {
        console.error(`取得失敗 ${stop.stopCd}:${stop.poleCd} — ${err.message}`);
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPage(payload, ROUTES));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Error: ${err.message}\n${err.stack}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`preview server: http://0.0.0.0:${PORT}/`);
  console.log(`  stops   : ${STOPS.map((s) => `${s.stopCd}:${s.poleCd}`).join(", ")}`);
  console.log(`  routes  : ${ROUTES.join(", ") || "(すべて)"}`);
  console.log(`  source  : ${USE_FIXTURE ? "fixture (通信しない)" : "live (Bus-Vision)"}`);
});
