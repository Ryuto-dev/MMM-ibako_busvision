/**
 * test/route-mode.test.js
 *
 * mode: "route" (系統絞り込み + 複数のりば統合) の表示ロジックのテスト。
 *
 * MMM-ibako_busvision.js はブラウザ前提 (Module.register / document) なので、
 * ここでは Module.register を捕捉してモジュール定義オブジェクトを取り出し、
 * 表示ロジックのメソッドだけを単体で検証する。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const { parseApproachPage } = require("../lib/parser");

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

// --- モジュール定義を取り出す ------------------------------------------------

function loadModuleDefinition () {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "MMM-ibako_busvision.js"),
    "utf8"
  );
  let captured = null;
  const sandbox = {
    Module: { register: (name, def) => { captured = def; } },
    Log: { info () {}, error () {}, warn () {}, debug () {} },
    document: {
      createElement: () => ({
        classList: { add () {}, remove () {} },
        appendChild () {},
        style: {},
        set textContent (v) { this._t = v; },
        get textContent () { return this._t; }
      })
    },
    setInterval: () => 0,
    clearInterval: () => {},
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (!captured) throw new Error("Module.register が呼ばれませんでした");
  return captured;
}

const DEF = loadModuleDefinition();

/** 表示ロジックだけを持つ軽量インスタンスを作る。 */
function makeInstance (config, stopDataEntries = []) {
  const inst = Object.create(DEF);
  inst.config = { ...DEF.defaults, ...config };
  inst.stopData = new Map(stopDataEntries);
  inst.stopErrors = new Map();
  inst.loaded = true;
  inst.identifier = "test";
  inst.translate = (k, vars) => {
    if (!vars) return k;
    return `${k}:${Object.values(vars).join(",")}`;
  };
  return inst;
}

/**
 * テスト用の便オブジェクト。
 * `??` ではなく hasOwnProperty で判定することで、
 * routeNumber: null を明示的に渡せるようにする。
 */
function dep (opts = {}) {
  const pick = (key, fallback) =>
    Object.prototype.hasOwnProperty.call(opts, key) ? opts[key] : fallback;
  return {
    routeNumber: pick("routeNumber", "52"),
    routeName: pick("routeName", "大串公園→水戸駅北口"),
    destination: pick("destination", "水戸駅（北口）行き"),
    effectiveAt: pick("effectiveAt", "2026-08-29T05:00:00.000Z"),
    minutesUntil: pick("minutesUntil", 30),
    isBeforeDeparture: pick("isBeforeDeparture", true),
    isRunning: pick("isRunning", false),
    time: pick("time", { hour: 14, minute: 0 }),
    state: pick("state", "beforeDeparture")
  };
}

// ---------------------------------------------------------------------------

describe("系統フィルタ (routeFilterSet / matchesRoute)", () => {
  test("routes を文字列 Set に正規化する", () => {
    const inst = makeInstance({ routes: ["52", 50, " 28 ", "", null] });
    const set = inst.routeFilterSet();
    assert.deepStrictEqual([...set].sort(), ["28", "50", "52"]);
  });

  test("数値指定 (50) と文字列 ('50') が一致する", () => {
    const inst = makeInstance({ routes: [50] });
    assert.strictEqual(inst.matchesRoute(dep({ routeNumber: "50" })), true);
  });

  test("指定外の系統は除外される", () => {
    const inst = makeInstance({ routes: ["52", "50"] });
    assert.strictEqual(inst.matchesRoute(dep({ routeNumber: "52" })), true);
    assert.strictEqual(inst.matchesRoute(dep({ routeNumber: "50" })), true);
    assert.strictEqual(inst.matchesRoute(dep({ routeNumber: "28" })), false);
  });

  test("routes が空ならすべて通す", () => {
    const inst = makeInstance({ routes: [] });
    assert.strictEqual(inst.matchesRoute(dep({ routeNumber: "99" })), true);
  });

  test("filterRoutes: false なら絞り込まない", () => {
    const inst = makeInstance({ routes: ["52"], filterRoutes: false });
    assert.strictEqual(inst.matchesRoute(dep({ routeNumber: "28" })), true);
  });

  test("系統番号を持たない便は除外される", () => {
    const inst = makeInstance({ routes: ["52"] });
    const d = dep({ routeNumber: null, routeName: "石塚車庫－イオン内原" });
    assert.strictEqual(inst.matchesRoute(d), false);
  });

  test("系統番号が分離できなかった便も路線名から救済される", () => {
    const inst = makeInstance({ routes: ["52"] });
    const d = dep({ routeNumber: null, routeName: "52 大串公園→水戸駅北口" });
    assert.strictEqual(inst.matchesRoute(d), true);
  });

  test("英字を含む系統番号も大小文字を無視して一致する", () => {
    const inst = makeInstance({ routes: ["k5"] });
    assert.strictEqual(inst.matchesRoute(dep({ routeNumber: "K5" })), true);
  });
});

describe("複数のりばの統合 (mergedDepartures)", () => {
  const poleA = {
    stopName: "水戸駅（北口）",
    updateTimeText: "2026/08/29 13:01",
    stop: { stopCd: 51, poleCd: 3 },
    poleName: null,
    departures: [
      dep({ routeNumber: "52", effectiveAt: "2026-08-29T05:10:00.000Z", destination: "A行き" }),
      dep({ routeNumber: "28", effectiveAt: "2026-08-29T05:05:00.000Z", destination: "B行き" })
    ]
  };
  const poleB = {
    stopName: "水戸駅（北口）",
    updateTimeText: "2026/08/29 13:02",
    stop: { stopCd: 51, poleCd: 7 },
    poleName: null,
    departures: [
      dep({ routeNumber: "50", effectiveAt: "2026-08-29T05:02:00.000Z", destination: "C行き" }),
      dep({ routeNumber: "52", effectiveAt: "2026-08-29T05:20:00.000Z", destination: "D行き" })
    ]
  };

  test("複数のりばの便が 1 本のリストに統合される", () => {
    const inst = makeInstance(
      { mode: "route", routes: [], maxEntries: 10, keepPastMinutes: 99999999 },
      [["51:3", poleA], ["51:7", poleB]]
    );
    assert.strictEqual(inst.mergedDepartures().length, 4);
  });

  test("統合結果が時刻順に並ぶ", () => {
    const inst = makeInstance(
      { mode: "route", routes: [], maxEntries: 10, keepPastMinutes: 99999999 },
      [["51:3", poleA], ["51:7", poleB]]
    );
    // vm コンテキスト由来の配列は Array プロトタイプが異なるため
    // deepStrictEqual ではなく値の比較で検証する
    const times = inst.mergedDepartures().map((d) => d.effectiveAt);
    const sorted = [...times].sort();
    assert.strictEqual(times.join(","), sorted.join(","));
  });

  test("系統 52/50 だけに絞り込める", () => {
    const inst = makeInstance(
      { mode: "route", routes: ["52", "50"], maxEntries: 10, keepPastMinutes: 99999999 },
      [["51:3", poleA], ["51:7", poleB]]
    );
    const got = inst.mergedDepartures();
    assert.strictEqual(got.length, 3);
    assert.ok(got.every((d) => ["52", "50"].includes(d.routeNumber)));
  });

  test("maxEntries はリスト全体に適用される", () => {
    const inst = makeInstance(
      { mode: "route", routes: [], maxEntries: 2, keepPastMinutes: 99999999 },
      [["51:3", poleA], ["51:7", poleB]]
    );
    assert.strictEqual(inst.mergedDepartures().length, 2);
  });

  test("同一便が複数のりばに現れても重複排除される", () => {
    const dup = dep({
      routeNumber: "52",
      effectiveAt: "2026-08-29T05:10:00.000Z",
      destination: "A行き"
    });
    const inst = makeInstance(
      { mode: "route", routes: [], maxEntries: 10, keepPastMinutes: 99999999 },
      [
        ["51:3", { ...poleA, departures: [dup] }],
        ["51:7", { ...poleB, departures: [{ ...dup }] }]
      ]
    );
    assert.strictEqual(inst.mergedDepartures().length, 1);
  });

  test("どののりば由来かの情報が付く (showOriginPole 用)", () => {
    const inst = makeInstance(
      { mode: "route", routes: ["50"], maxEntries: 10, keepPastMinutes: 99999999 },
      [["51:3", poleA], ["51:7", poleB]]
    );
    const got = inst.mergedDepartures();
    assert.strictEqual(got[0]._sourceKey, "51:7");
    assert.strictEqual(got[0]._sourceLabel, "水戸駅（北口）");
    assert.strictEqual(got[0]._sourcePole, "のりば7");
  });

  test("showBeforeDeparture: false で発車前を除外できる", () => {
    const mixed = {
      ...poleA,
      departures: [
        dep({ routeNumber: "52", isBeforeDeparture: true, isRunning: false }),
        dep({
          routeNumber: "52",
          isBeforeDeparture: false,
          isRunning: true,
          effectiveAt: "2026-08-29T05:30:00.000Z"
        })
      ]
    };
    const inst = makeInstance(
      {
        mode: "route",
        routes: ["52"],
        maxEntries: 10,
        keepPastMinutes: 99999999,
        showBeforeDeparture: false
      },
      [["51:3", mixed]]
    );
    const got = inst.mergedDepartures();
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].isRunning, true);
  });
});

describe("実データ (fixture) との組み合わせ", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", "running.html"),
    "utf8"
  );
  const data = parseApproachPage(html);
  data.stop = { stopCd: 200, poleCd: 1 };

  test("fixture から系統番号が取得できている", () => {
    const numbers = data.departures.map((d) => d.routeNumber).filter(Boolean);
    assert.ok(numbers.length > 0, "系統番号が 1 つも取れていない");
  });

  test("fixture に存在する系統で絞り込むと結果が返る", () => {
    const target = data.departures.find((d) => d.routeNumber).routeNumber;
    const inst = makeInstance(
      {
        mode: "route",
        routes: [target],
        maxEntries: 20,
        keepPastMinutes: 99999999,
        maxMinutes: 0
      },
      [["200:1", data]]
    );
    const got = inst.mergedDepartures();
    assert.ok(got.length > 0);
    assert.ok(got.every((d) => d.routeNumber === target));
  });

  test("存在しない系統で絞り込むと空になる", () => {
    const inst = makeInstance(
      { mode: "route", routes: ["99999"], maxEntries: 20, keepPastMinutes: 99999999 },
      [["200:1", data]]
    );
    assert.strictEqual(inst.mergedDepartures().length, 0);
  });
});

describe("自動タイトル生成 (autoRouteTitle)", () => {
  test("routes 指定ありならバス停名 + 系統", () => {
    const inst = makeInstance(
      { mode: "route", routes: ["52", "50"] },
      [["51:3", { stopName: "水戸駅（北口）", departures: [], stop: { stopCd: 51, poleCd: 3 } }]]
    );
    assert.strictEqual(inst.autoRouteTitle(), "ROUTE_TITLE:水戸駅（北口）,52/50");
  });

  test("同じバス停の複数のりばは名前を重複させない", () => {
    const inst = makeInstance(
      { mode: "route", routes: [] },
      [
        ["51:3", { stopName: "水戸駅（北口）", departures: [], stop: { stopCd: 51, poleCd: 3 } }],
        ["51:7", { stopName: "水戸駅（北口）", departures: [], stop: { stopCd: 51, poleCd: 7 } }]
      ]
    );
    assert.strictEqual(inst.autoRouteTitle(), "水戸駅（北口）");
  });

  test("label が設定されていれば label を使う", () => {
    const inst = makeInstance(
      { mode: "route", routes: [] },
      [[
        "51:3",
        {
          stopName: "水戸駅（北口）",
          departures: [],
          stop: { stopCd: 51, poleCd: 3, label: "水戸駅北口 3番のりば" }
        }
      ]]
    );
    assert.strictEqual(inst.autoRouteTitle(), "水戸駅北口 3番のりば");
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
