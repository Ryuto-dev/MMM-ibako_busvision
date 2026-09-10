/**
 * node_helper.js — MMM-ibako_busvision
 *
 * バックエンド側。Bus-Vision のページを定期取得し、
 * 解析結果をフロントエンド (MMM-ibako_busvision.js) に送る。
 *
 * 設計方針:
 *  - node_helper はモジュール種別ごとに 1 インスタンスしか作られないため、
 *    複数のモジュールインスタンス (identifier) を Map で管理する。
 *  - 同一 stopCd/poleCd を複数インスタンスが見ている場合、
 *    取得は 1 回にまとめてサーバ負荷を減らす (フェッチをキー単位で共有)。
 *  - インターバルはユーザ設定より短くならないよう下限クランプする。
 */

"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");

const { fetchApproach, normalizeInterval, MIN_INTERVAL_MS } = require("./lib/fetcher");

module.exports = NodeHelper.create({
  requiresVersion: "2.20.0",

  start () {
    /** identifier -> { config, stopKeys[] } */
    this.instances = new Map();
    /** "stopCd:poleCd" -> { timer, intervalMs, etag, subscribers:Set<identifier>, failures } */
    this.pollers = new Map();
    Log.info(`${this.name}: node_helper started`);
  },

  stop () {
    for (const poller of this.pollers.values()) {
      if (poller.timer) clearTimeout(poller.timer);
    }
    this.pollers.clear();
    this.instances.clear();
    Log.info(`${this.name}: node_helper stopped`);
  },

  // -------------------------------------------------------------------------

  socketNotificationReceived (notification, payload) {
    switch (notification) {
      case "IBAKO_CONFIG":
        this.registerInstance(payload.identifier, payload.config);
        break;
      case "IBAKO_FORCE_UPDATE":
        this.forceUpdate(payload.identifier);
        break;
      case "IBAKO_SUSPEND":
        this.setInstanceActive(payload.identifier, false);
        break;
      case "IBAKO_RESUME":
        this.setInstanceActive(payload.identifier, true);
        break;
      default:
        break;
    }
  },

  // -------------------------------------------------------------------------

  /** stop 定義からポーラーのキーを作る。 */
  stopKey (stop) {
    return `${stop.stopCd}:${stop.poleCd ?? 1}`;
  },

  /**
   * モジュールインスタンスを登録し、必要なポーラーを起動する。
   */
  registerInstance (identifier, config) {
    const stops = this.normalizeStops(config);
    if (stops.length === 0) {
      Log.error(`${this.name}: [${identifier}] 有効な stops 設定がありません`);
      this.sendSocketNotification("IBAKO_ERROR", {
        identifier,
        error: "設定エラー: stops に stopCd を指定してください"
      });
      return;
    }

    const { ms: intervalMs, clamped } = normalizeInterval(config.updateInterval);
    if (clamped) {
      Log.warn(
        `${this.name}: updateInterval が短すぎるため ${MIN_INTERVAL_MS / 1000} 秒に引き上げました ` +
        "(茨城交通のサーバ負荷軽減のため)"
      );
    }

    const previous = this.instances.get(identifier);
    if (previous) {
      // 再登録 (設定変更) の場合は古い購読を外す
      for (const key of previous.stopKeys) this.unsubscribe(key, identifier);
    }

    const stopKeys = stops.map((s) => this.stopKey(s));
    this.instances.set(identifier, { config, stops, stopKeys, intervalMs, active: true });

    Log.info(
      `${this.name}: [${identifier}] 登録 stops=${stopKeys.join(", ")} ` +
      `interval=${intervalMs / 1000}s`
    );

    stops.forEach((stop, i) => {
      // 複数バス停を同時に叩かないよう、少しずつずらして開始する
      this.subscribe(stop, identifier, intervalMs, i * 1500);
    });
  },

  /** config.stops / config.stopCd を正規化して配列にする。 */
  normalizeStops (config) {
    const raw = [];
    if (Array.isArray(config.stops)) raw.push(...config.stops);
    // 単一バス停の簡易指定にも対応
    if (config.stopCd !== undefined && config.stopCd !== null) {
      raw.push({ stopCd: config.stopCd, poleCd: config.poleCd, label: config.label });
    }

    const out = [];
    const seen = new Set();
    for (const entry of raw) {
      if (entry === null || entry === undefined) continue;
      const stopCd = typeof entry === "object" ? entry.stopCd : entry;
      const n = parseInt(stopCd, 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      const poleCd = typeof entry === "object" && entry.poleCd !== undefined
        ? parseInt(entry.poleCd, 10) || 1
        : 1;
      const key = `${n}:${poleCd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        stopCd: n,
        poleCd,
        label: (typeof entry === "object" && entry.label) || null
      });
    }
    return out;
  },

  // -------------------------------------------------------------------------

  /**
   * 指定バス停のポーリングを購読する。
   * 同じバス停を別インスタンスが既に見ていればフェッチは共有される。
   */
  subscribe (stop, identifier, intervalMs, startDelayMs) {
    const key = this.stopKey(stop);
    let poller = this.pollers.get(key);

    if (!poller) {
      poller = {
        stop,
        intervalMs,
        subscribers: new Set(),
        etag: null,
        lastResult: null,
        failures: 0,
        timer: null,
        inFlight: false
      };
      this.pollers.set(key, poller);
    }

    poller.subscribers.add(identifier);
    // 複数インスタンスが違う間隔を要求した場合は「最も長い間隔」を採用しない。
    // 最短要求を尊重しつつ下限は守る (どのインスタンスも欲しい鮮度を得られる)。
    poller.intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(poller.intervalMs, intervalMs));

    // 既にデータがあれば即座に新規購読者へ返す (無駄なリクエストを避ける)
    if (poller.lastResult) {
      this.sendSocketNotification("IBAKO_DATA", {
        identifier,
        key,
        stop,
        data: poller.lastResult
      });
    }

    if (!poller.timer) {
      poller.timer = setTimeout(() => this.poll(key), Math.max(0, startDelayMs || 0));
    }
  },

  /** 購読を解除し、購読者がいなくなればポーラーを止める。 */
  unsubscribe (key, identifier) {
    const poller = this.pollers.get(key);
    if (!poller) return;
    poller.subscribers.delete(identifier);
    if (poller.subscribers.size === 0) {
      if (poller.timer) clearTimeout(poller.timer);
      this.pollers.delete(key);
      Log.info(`${this.name}: ポーリング停止 ${key} (購読者なし)`);
    }
  },

  /**
   * poller の購読者のうち、1 つでも「表示中 (active)」のインスタンスがあるか。
   * MMM-pages などで全インスタンスが非表示 (suspend) になっている間は
   * 実際のフェッチをスキップし、茨城交通のサーバへ無駄なアクセスをしない。
   * (README の「suspend() 中はポーリングを停止する」という記述を実装で保証する)
   */
  hasActiveSubscriber (poller) {
    for (const identifier of poller.subscribers) {
      const inst = this.instances.get(identifier);
      // インスタンス情報が見つからない場合は安全側 (フェッチする) に倒す
      if (!inst || inst.active !== false) return true;
    }
    return false;
  },

  setInstanceActive (identifier, active) {
    const inst = this.instances.get(identifier);
    if (!inst) return;
    const wasActive = inst.active !== false;
    inst.active = active;

    // 非表示 → 表示に切り替わったタイミング (resume) で、
    // データが古ければすぐに再取得して手元の情報を最新化する。
    // (suspend 中はフェッチ自体をスキップしているため)
    if (active && !wasActive) {
      for (const key of inst.stopKeys) {
        const poller = this.pollers.get(key);
        if (!poller) continue;

        // 直近データを即座に返す (追加のリクエストなしで UI をすぐ更新できる)
        if (poller.lastResult) {
          this.sendSocketNotification("IBAKO_DATA", {
            identifier,
            key,
            stop: poller.stop,
            data: poller.lastResult
          });
        }

        const staleMs = poller.lastResult
          ? Date.now() - new Date(poller.lastResult.fetchedAt || 0).getTime()
          : Infinity;

        if (!poller.inFlight && staleMs >= poller.intervalMs) {
          if (poller.timer) clearTimeout(poller.timer);
          poller.timer = setTimeout(() => this.poll(key), 0);
        }
      }
    }
  },

  /** 手動更新。直近に取得済みなら再利用してサーバを叩かない。 */
  forceUpdate (identifier) {
    const inst = this.instances.get(identifier);
    if (!inst) return;
    for (const key of inst.stopKeys) {
      const poller = this.pollers.get(key);
      if (!poller) continue;
      if (poller.timer) clearTimeout(poller.timer);
      poller.timer = setTimeout(() => this.poll(key), 0);
    }
  },

  // -------------------------------------------------------------------------

  /** 1 回分の取得処理。完了後に次回のタイマーを張る。 */
  async poll (key) {
    const poller = this.pollers.get(key);
    if (!poller) return;
    if (poller.inFlight) return;

    // 購読者全員が非表示 (suspend) の間は実際のフェッチをスキップする。
    // MMM-pages で他のページを表示している間、茨城交通のサーバへ
    // 無駄なアクセスをしないための措置 (README 記載のポーリング停止)。
    // 短い間隔で「表示に戻ったか」だけを再確認し続ける。
    if (!this.hasActiveSubscriber(poller)) {
      poller.timer = setTimeout(() => this.poll(key), Math.min(poller.intervalMs, 5000));
      return;
    }

    poller.inFlight = true;
    poller.timer = null;

    let nextDelay = poller.intervalMs;

    try {
      const result = await fetchApproach(poller.stop, { etag: poller.etag });

      if (result.notModified) {
        Log.debug(`${this.name}: ${key} 変更なし (304)`);
      } else {
        poller.etag = result.etag;
        poller.lastResult = result;
        poller.failures = 0;

        for (const identifier of poller.subscribers) {
          this.sendSocketNotification("IBAKO_DATA", {
            identifier,
            key,
            stop: poller.stop,
            data: result
          });
        }
        Log.info(
          `${this.name}: ${key} ${result.stopName || "?"} — ` +
          `${result.departures.length} 便 (更新 ${result.updateTimeText || "?"})`
        );
      }
    } catch (err) {
      poller.failures += 1;
      // 指数バックオフ (最大 10 分) — 障害時にサーバを叩き続けない
      const backoff = Math.min(
        poller.intervalMs * Math.pow(2, poller.failures),
        10 * 60 * 1000
      );
      nextDelay = Math.max(poller.intervalMs, backoff);

      Log.error(
        `${this.name}: ${key} 取得失敗 (${poller.failures} 回目): ${err.message} ` +
        `→ 次回 ${Math.round(nextDelay / 1000)} 秒後`
      );

      for (const identifier of poller.subscribers) {
        this.sendSocketNotification("IBAKO_ERROR", {
          identifier,
          key,
          stop: poller.stop,
          error: err.message,
          failures: poller.failures
        });
      }
    } finally {
      poller.inFlight = false;
      if (this.pollers.has(key)) {
        poller.timer = setTimeout(() => this.poll(key), nextDelay);
      }
    }
  }
});
