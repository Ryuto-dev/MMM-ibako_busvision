/**
 * test/parser.test.js
 *
 * 実サイトから取得した HTML (test/fixtures/*.html) を使ったパーサのテスト。
 * 実行: npm test
 */

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { parseApproachPage, _internal } = require("../lib/parser");

const FIXTURES = path.join(__dirname, "fixtures");
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

let passed = 0;
let failed = 0;

function test (name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u001b[31m✗\u001b[0m ${name}`);
    console.log(`      ${err.message}`);
  }
}

function describe (name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ---------------------------------------------------------------------------

describe("低レベルユーティリティ", () => {
  test("decodeEntities: 名前付き / 数値参照", () => {
    assert.strictEqual(_internal.decodeEntities("a&amp;b&#65;&#x42;"), "a&bAB");
  });

  test("toText: タグ除去と全角空白の正規化", () => {
    assert.strictEqual(_internal.toText("<span>52 A</span>　<b>B</b>"), "52 A B");
  });

  test("stripPseudoMarkup: [[a href=[[quot]]...]] 形式の擬似マークアップを除去", () => {
    const raw = "お忘れ物の問合せはこちらから[[a href=[[quot]]https://www.ibako.co.jp/inquiry/lost.html[[quot]]]]Find[[/a]]";
    const out = _internal.stripPseudoMarkup(raw).replace(/\s+/g, " ").trim();
    assert.strictEqual(out, "お忘れ物の問合せはこちらから Find");
    assert.ok(!/\[\[|\]\]/.test(out), "角括弧が残っていない");
  });

  test("stripPseudoMarkup: 擬似マークアップが無い文字列はそのまま", () => {
    assert.strictEqual(_internal.stripPseudoMarkup("通常のお知らせ"), "通常のお知らせ");
  });

  test("toText: お知らせ欄の擬似マークアップも除去される", () => {
    const html = '<span id="content">A[[a href=[[quot]]http://x[[quot]]]]Find[[/a]]B</span>';
    assert.strictEqual(_internal.toText(html), "A Find B");
  });

  test("extractById: ネストしたタグを正しく取り出す", () => {
    const html = '<div id="x"><div>in</div>ner</div><div>out</div>';
    assert.strictEqual(_internal.extractById(html, "x"), "<div>in</div>ner");
  });

  test("extractById: 自己閉鎖タグは空文字", () => {
    assert.strictEqual(_internal.extractById('<input id="a" value="1" />', "a"), "");
  });

  test("parseHm", () => {
    assert.deepStrictEqual(_internal.parseHm("13:54"), { hour: 13, minute: 54 });
    assert.deepStrictEqual(_internal.parseHm("定刻 9:05 です"), { hour: 9, minute: 5 });
    assert.strictEqual(_internal.parseHm("なし"), null);
  });

  test("parseUpdateTime: JST の壁時計時刻として復元できる", () => {
    const d = _internal.parseUpdateTime("2026/08/29 13:01");
    const jst = _internal.epochToJstParts(d.getTime());
    assert.strictEqual(jst.year, 2026);
    assert.strictEqual(jst.month, 7);
    assert.strictEqual(jst.day, 29);
    assert.strictEqual(jst.hour, 13);
    assert.strictEqual(jst.minute, 1);
  });

  test("parseUpdateTime: JST として解釈される (端末TZ非依存)", () => {
    // 2026/08/29 13:01 JST === 2026-08-29T04:01:00Z
    const d = _internal.parseUpdateTime("2026/08/29 13:01");
    assert.strictEqual(d.toISOString(), "2026-08-29T04:01:00.000Z");
  });

  test("resolveDateTime: 深夜をまたぐ便は翌日扱い (JST基準)", () => {
    const ref = new Date(_internal.jstToEpoch(2026, 7, 29, 23, 50));
    const dt = _internal.resolveDateTime({ hour: 0, minute: 20 }, ref);
    const jst = _internal.epochToJstParts(dt.getTime());
    assert.strictEqual(jst.day, 30);
    assert.strictEqual(jst.hour, 0);
    assert.strictEqual(jst.minute, 20);
  });

  test("resolveDateTime: 直近の過去は当日扱い (遅延バス)", () => {
    const ref = new Date(_internal.jstToEpoch(2026, 7, 29, 13, 30));
    const dt = _internal.resolveDateTime({ hour: 13, minute: 13 }, ref);
    const jst = _internal.epochToJstParts(dt.getTime());
    assert.strictEqual(jst.day, 29);
    assert.strictEqual(jst.hour, 13);
  });

  test("resolveDateTime: 24時以降表記 (24:30) を翌日に正規化", () => {
    const ref = new Date(_internal.jstToEpoch(2026, 7, 29, 23, 55));
    const dt = _internal.resolveDateTime({ hour: 24, minute: 30 }, ref);
    const jst = _internal.epochToJstParts(dt.getTime());
    assert.strictEqual(jst.day, 30);
    assert.strictEqual(jst.hour, 0);
    assert.strictEqual(jst.minute, 30);
  });

  test("parseDelay", () => {
    assert.strictEqual(_internal.parseDelay("発車前"), null);
    assert.deepStrictEqual(_internal.parseDelay("ほぼ定刻").minutes, 0);
    assert.strictEqual(_internal.parseDelay("ほぼ定刻").onTime, true);
    assert.strictEqual(_internal.parseDelay("約7分遅れ").minutes, 7);
    assert.strictEqual(_internal.parseDelay("約3分早発").minutes, -3);
  });

  test("parsePassTimeFrom: 発車前 (予定のみ)", () => {
    const r = _internal.parsePassTimeFrom("13:54");
    assert.deepStrictEqual(r.scheduled, { hour: 13, minute: 54 });
    assert.strictEqual(r.predicted, null);
  });

  test("parsePassTimeFrom: 走行中 (定刻 + 予測)", () => {
    const r = _internal.parsePassTimeFrom("定刻13:13（予測13:24）");
    assert.deepStrictEqual(r.scheduled, { hour: 13, minute: 13 });
    assert.deepStrictEqual(r.predicted, { hour: 13, minute: 24 });
  });

  test("parsePassTimeInfo", () => {
    const r = _internal.parsePassTimeInfo("13:54発 ⇒ 14:13着（予定）");
    assert.deepStrictEqual(r.departure, { hour: 13, minute: 54 });
    assert.deepStrictEqual(r.arrival, { hour: 14, minute: 13 });
    assert.strictEqual(r.estimated, "scheduled");
  });

  test("splitRoute: 系統番号を分離", () => {
    const r = _internal.splitRoute("52 大串公園→東前団地→水戸駅北口");
    assert.strictEqual(r.routeNumber, "52");
    assert.strictEqual(r.routeName, "大串公園→東前団地→水戸駅北口");
  });

  test("splitRoute: 系統番号なし", () => {
    const r = _internal.splitRoute("石塚車庫－イオン内原");
    assert.strictEqual(r.routeNumber, null);
    assert.strictEqual(r.routeName, "石塚車庫－イオン内原");
  });

  test("parseStopsBefore", () => {
    assert.strictEqual(_internal.parseStopsBefore("15個前"), 15);
    assert.strictEqual(_internal.parseStopsBefore(""), null);
  });
});

describe("fixture: 発車前 (東前団地西 stopCd=345 poleCd=1)", () => {
  const result = parseApproachPage(read("before_departure.html"));

  test("バス停名を取得できる", () => {
    assert.strictEqual(result.stopName, "東前団地西");
  });

  test("更新時刻を取得できる", () => {
    assert.strictEqual(result.updateTimeText, "2026/08/29 13:01");
    assert.ok(result.updatedAt.startsWith("2026-08-29"));
  });

  test("お知らせを取得できる", () => {
    assert.ok(result.notice && result.notice.includes("内原駅"));
  });

  test("便が 1 件以上ある", () => {
    assert.ok(result.hasDepartures);
    assert.ok(result.departures.length >= 3, `got ${result.departures.length}`);
  });

  const first = result.departures[0];

  test("先頭便が「発車前」状態と判定される", () => {
    assert.strictEqual(first.state, "beforeDeparture");
    assert.strictEqual(first.isBeforeDeparture, true);
    assert.strictEqual(first.isRunning, false);
  });

  test("発車前の便は予測時刻を持たない (予定のみ)", () => {
    assert.deepStrictEqual(first.scheduledTime, { hour: 13, minute: 54 });
    assert.strictEqual(first.predictedTime, null);
    assert.deepStrictEqual(first.time, { hour: 13, minute: 54 });
  });

  test("発車前の便は遅延情報を持たない", () => {
    assert.strictEqual(first.delay, null);
    assert.strictEqual(first.statusText, "発車前");
  });

  test("路線 / 行先 / 始発停留所を取得できる", () => {
    assert.strictEqual(first.routeNumber, "52");
    assert.strictEqual(first.destination, "水戸駅（北口）行き");
    assert.strictEqual(first.originStop, "大串公園");
    assert.strictEqual(first.stopsBefore, 3);
  });

  test("発車前の便は現在位置 (currentStop) を持たない", () => {
    assert.strictEqual(first.currentStop, null);
  });

  test("minutesUntil が更新時刻基準で算出される (13:01 → 13:54 = 53分)", () => {
    assert.strictEqual(first.minutesUntil, 53);
  });

  test("便は時刻順に並んでいる", () => {
    const times = result.departures.map((d) => d.effectiveAt).filter(Boolean);
    const sorted = [...times].sort();
    assert.deepStrictEqual(times, sorted);
  });
});

describe("fixture: 走行中を含む (柳町一丁目 stopCd=200 poleCd=1)", () => {
  const result = parseApproachPage(read("running.html"));

  test("バス停名を取得できる", () => {
    assert.strictEqual(result.stopName, "柳町一丁目");
  });

  test("走行中の便が存在する", () => {
    const running = result.departures.filter((d) => d.isRunning);
    assert.ok(running.length >= 1, "走行中の便が見つからない");
  });

  const running = result.departures.find((d) => d.isRunning);

  test("走行中の便は定刻と予測の両方を持つ", () => {
    assert.deepStrictEqual(running.scheduledTime, { hour: 13, minute: 13 });
    assert.deepStrictEqual(running.predictedTime, { hour: 13, minute: 24 });
  });

  test("表示時刻は予測時刻が優先される", () => {
    assert.deepStrictEqual(running.time, running.predictedTime);
  });

  test("遅延が数値化される (約7分遅れ)", () => {
    assert.strictEqual(running.delay.minutes, 7);
    assert.strictEqual(running.delay.onTime, false);
  });

  test("走行中の便は現在通過中の停留所を持つ", () => {
    assert.strictEqual(running.currentStop, "保和苑入口");
    assert.strictEqual(running.stopsBefore, 15);
  });

  test('"あと22分で到着予定" が minutesUntil に反映される', () => {
    assert.strictEqual(running.minutesUntil, 22);
  });

  test("同じページ内に発車前の便も共存して正しく判定される", () => {
    const before = result.departures.filter((d) => d.isBeforeDeparture);
    assert.ok(before.length >= 1);
    assert.ok(before.every((d) => d.predictedTime === null));
  });

  test("すべての便が state を判定できている (unknown なし)", () => {
    const unknown = result.departures.filter((d) => d.state === "unknown");
    assert.strictEqual(unknown.length, 0, `unknown が ${unknown.length} 件`);
  });
});

describe("fixture: 接近情報なし (総合学校前 stopCd=500)", () => {
  const result = parseApproachPage(read("no_bus.html"));

  test("バス停名は取得できる", () => {
    assert.strictEqual(result.stopName, "総合学校前");
  });

  test("noApproach が true", () => {
    assert.strictEqual(result.noApproach, true);
    assert.strictEqual(result.hasDepartures, false);
    assert.strictEqual(result.departures.length, 0);
  });

  test("サイトのメッセージを取得できる", () => {
    assert.ok(result.message && result.message.includes("接近情報はありません"));
  });
});

describe("異常系", () => {
  test("空文字列でも例外を投げない", () => {
    const r = parseApproachPage("");
    assert.strictEqual(r.stopName, null);
    assert.strictEqual(r.noApproach, true);
  });

  test("null でも例外を投げない", () => {
    const r = parseApproachPage(null);
    assert.strictEqual(r.departures.length, 0);
  });

  test("HTML ではないゴミデータでも例外を投げない", () => {
    const r = parseApproachPage("<html><body>maintenance</body></html>");
    assert.strictEqual(r.hasDepartures, false);
  });
});

describe("fetcher: インターバルのクランプ", () => {
  const { normalizeInterval, MIN_INTERVAL_MS } = require("../lib/fetcher");

  test("1 秒指定は下限まで引き上げられる (サーバ負荷対策)", () => {
    const r = normalizeInterval(1);
    assert.strictEqual(r.ms, MIN_INTERVAL_MS);
    assert.strictEqual(r.clamped, true);
  });

  test("60 秒指定はそのまま", () => {
    const r = normalizeInterval(60);
    assert.strictEqual(r.ms, 60000);
    assert.strictEqual(r.clamped, false);
  });

  test("不正値は下限になる", () => {
    assert.strictEqual(normalizeInterval("abc").ms, MIN_INTERVAL_MS);
  });
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
