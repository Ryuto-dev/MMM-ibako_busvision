/* eslint-disable no-useless-escape */
/**
 * lib/parser.js
 *
 * 茨城交通 Bus-Vision (mc.bus-vision.jp/ibako) の
 * 「通過全車両接近表示」ページ (approachSpecifiedStop.html) を
 * 解析して構造化データに変換する純粋関数群。
 *
 * 依存ライブラリなし (正規表現ベース) なので Node / ブラウザ双方から使える。
 * テストは test/parser.test.js を参照。
 */

"use strict";

// ---------------------------------------------------------------------------
// 低レベルユーティリティ
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  yen: "¥",
  middot: "·"
};

/**
 * HTML エンティティをデコードする。
 * Bus-Vision は `&lt;br/&gt;` のように二重エスケープされた値を返す箇所があるため
 * 数値文字参照と主要な名前付き参照の両方を扱う。
 */
function decodeEntities (str) {
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
    });
}

/**
 * Bus-Vision の「お知らせ」欄で使われる独自の擬似マークアップを除去する。
 *
 * サイト側は HTML タグを `[[` `]]` に、実体参照を `[[quot]]` のように
 * 置き換えた文字列をそのまま出力してくる。例:
 *
 *   お忘れ物の問合せはこちらから[[a href=[[quot]]https://…[[quot]]]]Find[[/a]]
 *
 * そのまま表示すると意味不明になるので、擬似タグを取り除き
 * リンクテキストだけを残す。
 */
const PSEUDO_ENTITIES = {
  quot: '"',
  apos: "'",
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  yen: "¥"
};

function stripPseudoMarkup (str) {
  if (!str || str.indexOf("[[") === -1) return str || "";
  return String(str)
    // [[quot]] などの擬似実体参照 → 対応する文字
    .replace(/\[\[([a-zA-Z]+)\]\]/g, (m, name) => {
      const key = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(PSEUDO_ENTITIES, key)) return PSEUDO_ENTITIES[key];
      if (key === "br") return " ";
      return m; // [[a]] のような擬似タグは後段で処理
    })
    // [[br/]] は改行相当
    .replace(/\[\[\s*br\s*\/?\s*\]\]/gi, " ")
    // [[a href="…"]] / [[/a]] のような擬似タグ → 除去 (中のテキストは残す)
    .replace(/\[\[\s*\/?\s*[a-zA-Z][^\]]*?\]\]/g, " ")
    // 取り残された括弧
    .replace(/\[\[|\]\]/g, " ");
}

/** タグを除去し、空白を正規化したプレーンテキストにする。 */
function toText (html) {
  if (!html) return "";
  return stripPseudoMarkup(
    decodeEntities(
      String(html)
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]*>/g, "")
    )
  )
    .replace(/[\u3000\s]+/g, " ")
    .trim();
}

/**
 * `id="..."` を持つ要素の内側の HTML を取り出す。
 *
 * Bus-Vision の HTML は Teeda 製で、同じ id が繰り返し出現する
 * (仕様上は不正だが実際にそうなっている) ため、
 * DOM ではなく「与えられた断片の中で最初に一致するもの」を返す方針を取る。
 * ネストしたタグにも耐えられるよう、開始タグ以降を深さカウントで走査する。
 */
function extractById (fragment, id) {
  if (!fragment) return null;
  const open = new RegExp(`<(\\w+)([^>]*\\sid="${escapeRe(id)}"[^>]*)>`);
  const m = open.exec(fragment);
  if (!m) return null;

  // 自己閉鎖タグ (<input ... /> や <img ... />) は中身を持たない
  const tagName = m[1].toLowerCase();
  if (/\/\s*$/.test(m[2]) || ["input", "img", "br", "hr", "meta", "link"].includes(tagName)) {
    return "";
  }

  const start = m.index + m[0].length;
  const scanner = new RegExp(`<(/?)${escapeRe(tagName)}\\b[^>]*?(/?)>`, "gi");
  scanner.lastIndex = start;
  let depth = 1;
  let hit;
  while ((hit = scanner.exec(fragment)) !== null) {
    if (hit[2] === "/") continue; // 自己閉鎖 → 深さに影響しない
    depth += hit[1] === "/" ? -1 : 1;
    if (depth === 0) return fragment.slice(start, hit.index);
  }
  // 閉じタグが見つからない場合は残り全部 (壊れた HTML への保険)
  return fragment.slice(start);
}

/** id を持つ要素のテキストを取り出す。存在しなければ null。 */
function textById (fragment, id) {
  const inner = extractById(fragment, id);
  return inner === null ? null : toText(inner);
}

/** 正規表現用のエスケープ。 */
function escapeRe (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 空文字列を null に丸める。 */
function nullIfEmpty (s) {
  return s === null || s === undefined || s === "" ? null : s;
}

// ---------------------------------------------------------------------------
// 時刻の解析
// ---------------------------------------------------------------------------

/** "13:54" のような文字列から {hour, minute} を取り出す。 */
function parseHm (str) {
  if (!str) return null;
  const m = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(str);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour > 47 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Bus-Vision が返す時刻はすべて日本標準時 (JST, UTC+9 / サマータイムなし)。
 *
 * MagicMirror が動く端末のタイムゾーンが JST でない場合
 * (Docker の UTC コンテナなど) に時刻がずれるのを防ぐため、
 * 「JST の壁時計時刻」を明示的に絶対時刻 (epoch) へ変換する。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の年月日時分から epoch ミリ秒を作る。 */
function jstToEpoch (year, month, day, hour, minute) {
  return Date.UTC(year, month, day, hour, minute, 0, 0) - JST_OFFSET_MS;
}

/** epoch から JST の暦日 (年/月/日) を取り出す。 */
function epochToJstParts (epochMs) {
  const shifted = new Date(epochMs + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes()
  };
}

/**
 * `updateTime` ("2026/08/29 13:01") を Date に変換する。
 * サーバ側の「現在時刻」を基準にすることで、
 * MagicMirror 端末の時計ずれの影響を受けにくくする。
 * 文字列は JST として解釈する。
 */
function parseUpdateTime (str) {
  if (!str) return null;
  const m = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(str);
  if (!m) return null;
  return new Date(
    jstToEpoch(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10)
    )
  );
}

/**
 * 時刻 (hh:mm) を基準日時と同じ JST の日付に載せて Date にする。
 * Bus-Vision は 24時以降を "24:30" と表記することがあり、
 * また日付をまたぐ便 (基準より大きく過去の時刻) も現れるため、
 * 「基準時刻より 3 時間以上前なら翌日」と解釈して補正する。
 */
function resolveDateTime (hm, reference) {
  if (!hm || !reference) return null;
  const ref = epochToJstParts(reference.getTime());
  let epoch = jstToEpoch(ref.year, ref.month, ref.day, hm.hour, hm.minute);
  const diffMin = (epoch - reference.getTime()) / 60000;
  if (diffMin < -180) epoch += 24 * 60 * 60 * 1000;
  return new Date(epoch);
}

// ---------------------------------------------------------------------------
// 「発車前 / 走行中」判定
// ---------------------------------------------------------------------------

/**
 * 便 1 件の状態を判定する。
 *
 * 実サイトで確認した 2 系統の表示:
 *
 *  (A) 始発バス停を発車する前 (= まだ動き出していない)
 *      - `passInfo`     : "発車前"
 *      - `approachInfo` : "13:50に大串公園を発車予定"
 *      - `passTimeFrom` : "13:54"                     ← 予定のみ
 *      - 詳細に `isExistsStart-stop` (始発停留所) ブロックがある
 *
 *  (B) 発車後 (= 走行中で位置が取れる)
 *      - `passInfo`     : "ほぼ定刻" / "約7分遅れ" など
 *      - `approachInfo` : "あと22分で到着予定"
 *      - `passTimeFrom` : "定刻13:13（予測13:24）"     ← 定刻 + 予測
 *      - 詳細に `isExistsPass` (現在通過中の停留所) ブロックがある
 */
function detectState (raw) {
  const passInfo = raw.passInfo || "";
  const hasPass = raw._hasPassBlock;
  const hasStart = raw._hasStartBlock;

  if (/発車前|未発車|出庫前/.test(passInfo)) return "beforeDeparture";
  if (hasPass) return "running";
  // "あと N 分で到着" が出ていれば走行中とみなす
  if (/あと\s*\d+\s*分/.test(raw.approachInfo || "")) return "running";
  // 定刻/予測の 2 値が出ているのは走行中のみ
  if (/定刻/.test(raw.passTimeFromText || "") && /予測/.test(raw.passTimeFromText || "")) return "running";
  if (hasStart) return "beforeDeparture";
  return "unknown";
}

/**
 * 遅延情報を `passInfo` から数値化する。
 *  "ほぼ定刻"   → { minutes: 0, onTime: true }
 *  "約7分遅れ"  → { minutes: 7 }
 *  "約3分早発"  → { minutes: -3 }
 *  "発車前"     → null (走行前なので遅延概念なし)
 */
function parseDelay (passInfo) {
  if (!passInfo) return null;
  if (/発車前|未発車|出庫前/.test(passInfo)) return null;
  if (/ほぼ定刻|定刻通り|定時/.test(passInfo)) {
    return { minutes: 0, onTime: true, text: passInfo };
  }
  const late = /約?\s*(\d+)\s*分\s*(?:以上)?\s*遅/.exec(passInfo);
  if (late) return { minutes: parseInt(late[1], 10), onTime: false, text: passInfo };
  const early = /約?\s*(\d+)\s*分\s*(?:以上)?\s*(?:早発|早い|早着)/.exec(passInfo);
  if (early) return { minutes: -parseInt(early[1], 10), onTime: false, text: passInfo };
  return { minutes: null, onTime: null, text: passInfo };
}

/**
 * `passTimeFrom` から「対象バス停の発車時刻」を取り出す。
 *   発車前: "13:54"                  → scheduled 13:54 / predicted なし
 *   走行中: "定刻13:13（予測13:24）"  → scheduled 13:13 / predicted 13:24
 */
function parsePassTimeFrom (text) {
  const out = { scheduled: null, predicted: null, raw: text || null };
  if (!text) return out;

  const sched = /定刻\s*(\d{1,2}[:：]\d{1,2})/.exec(text);
  const pred = /予測\s*(\d{1,2}[:：]\d{1,2})/.exec(text);

  if (sched) out.scheduled = parseHm(sched[1]);
  if (pred) out.predicted = parseHm(pred[1]);

  if (!out.scheduled && !out.predicted) {
    // 予定のみのパターン (発車前)
    out.scheduled = parseHm(text);
  }
  return out;
}

/** `passTimeInfo` ("13:54発 ⇒ 14:13着（予定）") を分解する。 */
function parsePassTimeInfo (text) {
  const out = { departure: null, arrival: null, estimated: null, raw: text || null };
  if (!text) return out;
  const dep = /(\d{1,2}[:：]\d{1,2})\s*発/.exec(text);
  const arr = /(\d{1,2}[:：]\d{1,2})\s*着/.exec(text);
  if (dep) out.departure = parseHm(dep[1]);
  if (arr) out.arrival = parseHm(arr[1]);
  if (/予測/.test(text)) out.estimated = "predicted";
  else if (/予定/.test(text)) out.estimated = "scheduled";
  return out;
}

/** "3個前" → 3 */
function parseStopsBefore (text) {
  if (!text) return null;
  const m = /(\d+)\s*個前/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

/** 路線名 "52 大串公園→..." の先頭を系統番号として切り出す。 */
function splitRoute (routeNm) {
  const out = { routeNumber: null, routeName: routeNm || null };
  if (!routeNm) return out;
  const m = /^([0-9A-Za-z]{1,4})\s+(.*)$/.exec(routeNm);
  if (m) {
    out.routeNumber = m[1];
    out.routeName = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// メインパーサ
// ---------------------------------------------------------------------------

const BLOCK_SPLIT = /<div\s+class="approachData"\s*>/g;

/** 便 1 件 (approachData ブロック) を解析する。 */
function parseDeparture (block, index, referenceTime) {
  const raw = {
    number: textById(block, "number"),
    approachInfo: textById(block, "approachInfo"),
    nextTimespan: textById(block, "nextTimespanInfo"),
    passTimeInfo: textById(block, "passTimeInfo"),
    passTimeStartDiff: textById(block, "passTimeStartDiffText"),
    routeNm: textById(block, "routeNm"),
    destNm: textById(block, "destNm"),
    remarks: textById(block, "remarksMsg"),
    passInfo: null,
    startStopNm: textById(block, "stopNmStart"),
    passStopNm: textById(block, "stopNmPass"),
    passTimeFromText: textById(block, "passTimeFromText"),
    startTimeText: textById(block, "passTimeStartText-start"),
    _hasStartBlock: /id="isExistsStart-stop"/.test(block),
    _hasPassBlock: /id="isExistsPass"/.test(block)
  };

  // passInfo は `class="passInfoText"` を持つ span に入っている。
  // (同名 id が別用途のコメント内にもあるため class で絞る)
  const passInfoMatch = /<span[^>]*id="passInfo"[^>]*class="passInfoText"[^>]*>([\s\S]*?)<\/span>/.exec(block);
  raw.passInfo = passInfoMatch ? toText(passInfoMatch[1]) : null;

  // 「何個前」— 発車前は beforeFromInfo-1、走行中は beforeFromInfo-pass
  const beforeText =
    textById(block, "beforeFromInfo-pass") ||
    (block.match(/id="beforeFromInfo-\d+"[^>]*>([\s\S]*?)<\/span>/) || [])[1] ||
    null;

  const state = detectState(raw);
  const passTimeFrom = parsePassTimeFrom(raw.passTimeFromText);
  const passTimeInfo = parsePassTimeInfo(raw.passTimeInfo);
  const route = splitRoute(raw.routeNm);

  // 実際に来る時刻: 予測があれば予測、なければ予定
  const effectiveHm = passTimeFrom.predicted || passTimeFrom.scheduled || passTimeInfo.departure;
  const effectiveAt = resolveDateTime(effectiveHm, referenceTime);
  const scheduledAt = resolveDateTime(passTimeFrom.scheduled, referenceTime);

  let minutesUntil = null;
  if (effectiveAt && referenceTime) {
    minutesUntil = Math.round((effectiveAt.getTime() - referenceTime.getTime()) / 60000);
  }
  // "あと22分で到着予定" が明示されている場合はそちらを優先 (サーバ計算値)
  const explicitMin = /あと\s*(\d+)\s*分/.exec(raw.approachInfo || "");
  if (explicitMin) minutesUntil = parseInt(explicitMin[1], 10);
  // "まもなく" 系
  if (/まもなく|間もなく|接近中|到着します/.test(raw.approachInfo || "")) {
    if (minutesUntil === null || minutesUntil > 1) minutesUntil = 0;
  }

  return {
    index,
    number: raw.number ? parseInt(raw.number, 10) : index + 1,

    // 状態
    state,                                 // "beforeDeparture" | "running" | "unknown"
    isBeforeDeparture: state === "beforeDeparture",
    isRunning: state === "running",

    // 時刻
    scheduledTime: passTimeFrom.scheduled,   // {hour, minute} | null
    predictedTime: passTimeFrom.predicted,   // {hour, minute} | null
    time: effectiveHm,                       // 表示に使う時刻
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
    effectiveAt: effectiveAt ? effectiveAt.toISOString() : null,
    minutesUntil,

    // 遅延
    delay: parseDelay(raw.passInfo),
    statusText: nullIfEmpty(raw.passInfo),

    // 路線
    routeNumber: route.routeNumber,
    routeName: route.routeName,
    destination: nullIfEmpty(raw.destNm),

    // 位置
    originStop: nullIfEmpty(raw.startStopNm),
    currentStop: nullIfEmpty(raw.passStopNm),
    stopsBefore: parseStopsBefore(beforeText),

    // 補足
    approachInfo: nullIfEmpty(raw.approachInfo),
    nextTimespan: nullIfEmpty(raw.nextTimespan),
    tripArrival: passTimeInfo.arrival,
    tripDeparture: passTimeInfo.departure,
    remarks: nullIfEmpty(raw.remarks),
    startDiff: nullIfEmpty(raw.passTimeStartDiff)
  };
}

/**
 * approachSpecifiedStop.html の HTML 全体を解析する。
 *
 * @param {string} html  取得した HTML
 * @param {object} [opts]
 * @param {Date}   [opts.now]  updateTime が読めなかった場合のフォールバック基準時刻
 * @returns {object} 解析結果
 */
function parseApproachPage (html, opts = {}) {
  const source = String(html || "");

  const stopName = textById(source, "stopNmSpecifiedTitle");
  const updateTimeText = textById(source, "updateTime");
  const updatedAt = parseUpdateTime(updateTimeText);
  const referenceTime = updatedAt || opts.now || new Date(Date.now());

  const poleName = textById(source, "poleNmSpecified");
  const notice = textById(source, "content");

  const noApproach = /id="isNotExistsApproach"/.test(source);
  const errorMsg = textById(source, "errorMsg");

  // ヘッダ・フッタを含む全文から approachData ブロックを切り出す
  const parts = source.split(BLOCK_SPLIT).slice(1);
  const departures = parts
    .map((block, i) => parseDeparture(block, i, referenceTime))
    .filter((d) => d.time || d.approachInfo);

  // 到着時刻順に整列 (サーバ側もほぼ順序どおりだが保険)
  departures.sort((a, b) => {
    if (a.effectiveAt && b.effectiveAt) return a.effectiveAt.localeCompare(b.effectiveAt);
    return a.index - b.index;
  });
  departures.forEach((d, i) => { d.index = i; });

  return {
    stopName: nullIfEmpty(stopName),
    poleName: nullIfEmpty(poleName),
    updateTimeText: nullIfEmpty(updateTimeText),
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    referenceTime: referenceTime.toISOString(),
    notice: nullIfEmpty(notice),
    departures,
    hasDepartures: departures.length > 0,
    noApproach: noApproach || departures.length === 0,
    message: noApproach ? nullIfEmpty(errorMsg) : null
  };
}

/**
 * selectStop.html の一覧から {name, stopCd} を抽出する (バス停コード検索用)。
 */
function parseStopList (html) {
  const source = String(html || "");
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*href="([^"]*stopCd(?:From|To|Specified)=(\d+)[^"]*)"[^>]*>([\s\S]{0,400}?)<\/a>/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const stopCd = parseInt(m[2], 10);
    const name = toText(m[3]);
    if (!name || seen.has(`${stopCd}:${name}`)) continue;
    seen.add(`${stopCd}:${name}`);
    out.push({ stopCd, name });
  }
  return out;
}

module.exports = {
  parseApproachPage,
  parseStopList,
  // テスト・再利用のために内部関数も公開
  _internal: {
    decodeEntities,
    stripPseudoMarkup,
    toText,
    extractById,
    textById,
    parseHm,
    parseUpdateTime,
    resolveDateTime,
    jstToEpoch,
    epochToJstParts,
    JST_OFFSET_MS,
    detectState,
    parseDelay,
    parsePassTimeFrom,
    parsePassTimeInfo,
    parseStopsBefore,
    splitRoute
  }
};
