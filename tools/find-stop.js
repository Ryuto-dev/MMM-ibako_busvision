#!/usr/bin/env node
/**
 * tools/find-stop.js
 *
 * バス停名から stopCd を検索するユーティリティ。
 * config.js に書く stopCd / poleCd を調べるために使う。
 *
 *   node tools/find-stop.js 東前団地
 *   node tools/find-stop.js 東前団地 --check
 *
 * --check を付けると、見つかった stopCd について poleCd=1/2 の
 * 接近情報を実際に取得し、どちらがどの方向かを表示する。
 *
 * 【仕組み】Bus-Vision の停留所一覧 (selectStop.html) は 10 件ごとの
 * ページングで、2 ページ目以降は jsessionid 付き POST が必要なため
 * Cookie セッションを維持しながら「次へ」を送る。
 * サーバ負荷を避けるため各リクエストの間に待機を入れている。
 */

"use strict";

const { parseStopList } = require("../lib/parser");
const { fetchApproach } = require("../lib/fetcher");

const ORIGIN = "https://mc.bus-vision.jp";
const BASE = `${ORIGIN}/ibako/view`;
const UA = "MMM-ibako_busvision/1.0 (stop lookup tool)";

/** リクエスト間の待機 (ミリ秒) — サーバに優しく。 */
const REQUEST_GAP_MS = 800;
/** 1 つの 50音インデックスで辿る最大ページ数 (暴走防止)。 */
const MAX_PAGES = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 最小限の Cookie ジャー --------------------------------------------------
const cookies = new Map();

function storeCookies (res) {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  for (const line of raw) {
    const [pair] = String(line).split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader () {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function request (url, options = {}) {
  const headers = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml",
    ...(options.headers || {})
  };
  const jar = cookieHeader();
  if (jar) headers.Cookie = jar;

  const res = await fetch(url, { ...options, headers, redirect: "follow" });
  storeCookies(res);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  await sleep(REQUEST_GAP_MS);
  return html;
}

// --- HTML から情報を拾う ----------------------------------------------------

/** form 内の hidden フィールドを name=value で集める。 */
function collectHiddenFields (html) {
  const fields = {};
  const re = /<input[^>]*type="hidden"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const name = (/name="([^"]*)"/.exec(tag) || [])[1];
    const value = (/value="([^"]*)"/.exec(tag) || [])[1] ?? "";
    if (name) fields[name] = value;
  }
  return fields;
}

/** POST 先 (jsessionid 付き action) を取り出す。 */
function formAction (html) {
  const m = /<form[^>]*action="([^"]+)"/i.exec(html);
  if (!m) return null;
  return m[1].startsWith("http") ? m[1] : ORIGIN + m[1];
}

/** 現在ページ / 総ページ数。 */
function pageInfo (html) {
  const cur = (/id="pageNo-top"[^>]*>(\d+)</.exec(html) || [])[1];
  const total = (/id="totalPageNo-top"[^>]*>(\d+)</.exec(html) || [])[1];
  return {
    current: cur ? parseInt(cur, 10) : 1,
    total: total ? parseInt(total, 10) : 1
  };
}

/** 「次へ」ボタンが存在するか。 */
function hasNext (html) {
  return /id="doNextTop"/.test(html);
}

// --- 停留所一覧の取得 -------------------------------------------------------

/** 50音インデックス (onCd) をサイトから動的に取得する。 */
async function loadOnCodes () {
  const html = await request(
    `${BASE}/selectStopon.html?siteConf=2&isFromStop=true&stopCdFrom=-1&stopCdTo=-1&lang=0`
  );
  const codes = [];
  const seen = new Set();
  const re = /href="[^"]*onCd=(\d+)[^"]*"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const code = parseInt(m[1], 10);
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

/**
 * 1 つの onCd について全ページを辿って {stopCd, name} を集める。
 * @param {Map<number,string>} sink 収集先
 */
async function collectByOnCode (onCd, sink) {
  let html = await request(
    `${BASE}/selectStop.html?searchType=2&isFromStop=true` +
    `&stopCdFrom=-1&stopCdTo=-1&onCd=${onCd}&lang=0`
  );

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    for (const s of parseStopList(html)) {
      if (!sink.has(s.stopCd)) sink.set(s.stopCd, s.name);
    }

    const info = pageInfo(html);
    if (!hasNext(html) || info.current >= info.total) break;

    const action = formAction(html);
    if (!action) break;

    const fields = collectHiddenFields(html);
    const body = new URLSearchParams(fields);
    body.set("form:doNextTop", "次へ");

    html = await request(action, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${BASE}/selectStop.html`
      }
    });
  }
}

// --- メイン -----------------------------------------------------------------

async function main () {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  if (!query) {
    console.log("使い方: node tools/find-stop.js <バス停名の一部> [--check]");
    console.log("例:     node tools/find-stop.js 東前団地 --check");
    process.exit(1);
  }

  console.log(`「${query}」を検索します。\n`);

  const onCodes = await loadOnCodes();
  if (onCodes.length === 0) {
    throw new Error("50音インデックスを取得できませんでした (サイト構成が変わった可能性)");
  }
  console.log(`50音インデックス ${onCodes.length} 件を検出。停留所一覧を取得します…`);
  console.log("(サーバに負荷をかけないよう間隔を空けて取得するため数分かかります)\n");

  const all = new Map();
  for (let i = 0; i < onCodes.length; i += 1) {
    const onCd = onCodes[i];
    process.stdout.write(`\r  [${i + 1}/${onCodes.length}] 取得中… 累計 ${all.size} 件`);
    try {
      await collectByOnCode(onCd, all);
    } catch (err) {
      process.stdout.write(`\n  (onCd=${onCd} 失敗: ${err.message})\n`);
    }
  }
  process.stdout.write(`\r  完了: バス停 ${all.size} 件\n\n`);

  const hits = [...all.entries()]
    .filter(([, name]) => name.includes(query))
    .sort((a, b) => a[1].localeCompare(b[1], "ja"));

  if (hits.length === 0) {
    console.log("該当するバス停が見つかりませんでした。");
    console.log("表記 (漢字/カナ) を変えるか、より短いキーワードで試してください。");
    return;
  }

  console.log(`${hits.length} 件見つかりました:\n`);

  if (!check) {
    for (const [stopCd, name] of hits) {
      console.log(`  ${name}  (stopCd: ${stopCd})`);
      console.log(
        `    ${BASE}/approachSpecifiedStop.html` +
        `?stopCdSpecified=${stopCd}&poleCdSpecified=1&lang=0`
      );
    }
    console.log("\n方向 (poleCd) を確認するには --check を付けて実行してください。");
    return;
  }

  const targets = hits.slice(0, 5);
  console.log(`上位 ${targets.length} 件について poleCd 1 / 2 を確認します。\n`);

  for (const [stopCd, name] of targets) {
    console.log(`■ ${name} (stopCd=${stopCd})`);
    for (const poleCd of [1, 2]) {
      try {
        const data = await fetchApproach({ stopCd, poleCd });
        const dests = [
          ...new Set(data.departures.map((d) => d.destination || d.routeName).filter(Boolean))
        ].slice(0, 3);
        console.log(
          `   poleCd=${poleCd} → ` +
          (data.hasDepartures
            ? `${data.departures.length} 便 / 行先: ${dests.join(" , ")}`
            : (data.message || "接近情報なし"))
        );
        console.log(
          `     config: { stopCd: ${stopCd}, poleCd: ${poleCd}, label: "${name}" }`
        );
      } catch (err) {
        console.log(`   poleCd=${poleCd} → 取得失敗: ${err.message}`);
      }
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(`\nエラー: ${err.message}`);
  process.exit(1);
});
