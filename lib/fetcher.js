/**
 * lib/fetcher.js
 *
 * Bus-Vision へのアクセス層。
 *
 * 【サーバ負荷への配慮】茨城交通のサーバに迷惑をかけないため、
 * 以下のガードを実装している:
 *
 *  1. MIN_INTERVAL_MS  : どんな設定値であっても、1 バス停あたり
 *                        この間隔より短いリクエストは行わない (下限クランプ)。
 *  2. GLOBAL_THROTTLE  : プロセス全体で見て、リクエストは必ず
 *                        GLOBAL_MIN_GAP_MS 以上の間隔を空けて直列に送る。
 *                        (複数バス停を設定しても同時多発アクセスにならない)
 *  3. 指数バックオフ    : 失敗時は待ち時間を倍々にして再試行間隔を広げる。
 *  4. 304 / ETag 対応  : 変化がなければ本文を受け取らない。
 */

"use strict";

const { parseApproachPage } = require("./parser");

const BASE_URL = "https://mc.bus-vision.jp/ibako/view/approachSpecifiedStop.html";

/** 1 バス停あたりの最短ポーリング間隔 (ミリ秒)。設定がこれより短ければ切り上げる。 */
const MIN_INTERVAL_MS = 30 * 1000;

/** プロセス全体で連続リクエストの間に必ず空ける間隔 (ミリ秒)。 */
const GLOBAL_MIN_GAP_MS = 1200;

/** リクエストのタイムアウト (ミリ秒)。 */
const DEFAULT_TIMEOUT_MS = 15 * 1000;

const USER_AGENT =
  "MMM-ibako_busvision/1.0 (MagicMirror module; +https://github.com/Ryuto-dev/MMM-ibako_busvision)";

// --- グローバル直列化キュー ---------------------------------------------------
let lastRequestAt = 0;
let queueTail = Promise.resolve();

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fn をグローバルキューに載せて実行する。
 * 直前のリクエストから GLOBAL_MIN_GAP_MS 経過するまで待機する。
 */
function enqueue (fn) {
  const run = queueTail.then(async () => {
    const wait = GLOBAL_MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // キューが例外で止まらないようにする
  queueTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 設定値のインターバルを安全な範囲にクランプする。
 * @param {number} seconds ユーザ設定 (秒)
 * @returns {{ms:number, clamped:boolean}}
 */
function normalizeInterval (seconds) {
  const requested = Number(seconds);
  const ms = Number.isFinite(requested) ? requested * 1000 : MIN_INTERVAL_MS;
  if (ms < MIN_INTERVAL_MS) {
    return { ms: MIN_INTERVAL_MS, clamped: true };
  }
  return { ms, clamped: false };
}

/** 接近情報ページの URL を組み立てる。 */
function buildUrl (stop) {
  const params = new URLSearchParams({
    stopCdSpecified: String(stop.stopCd),
    poleCdSpecified: String(stop.poleCd ?? 1),
    lang: "0"
  });
  return `${BASE_URL}?${params.toString()}`;
}

/**
 * 1 バス停分の接近情報を取得して解析する。
 *
 * @param {object} stop            {stopCd, poleCd}
 * @param {object} [opts]
 * @param {number} [opts.timeout]  タイムアウト (ms)
 * @param {string} [opts.etag]     前回の ETag (304 判定用)
 * @returns {Promise<object>} {notModified} または解析結果 + {etag, url}
 */
async function fetchApproach (stop, opts = {}) {
  const url = buildUrl(stop);
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;

  return enqueue(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers = {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ja,en;q=0.8"
      };
      if (opts.etag) headers["If-None-Match"] = opts.etag;

      const res = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: "follow"
      });

      if (res.status === 304) {
        return { notModified: true, url, etag: opts.etag };
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText}`);
        err.status = res.status;
        throw err;
      }

      const html = await res.text();
      const parsed = parseApproachPage(html, { now: new Date(Date.now()) });
      return {
        ...parsed,
        url,
        etag: res.headers.get("etag") || null,
        fetchedAt: new Date(Date.now()).toISOString()
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

module.exports = {
  fetchApproach,
  normalizeInterval,
  buildUrl,
  MIN_INTERVAL_MS,
  GLOBAL_MIN_GAP_MS,
  BASE_URL
};
