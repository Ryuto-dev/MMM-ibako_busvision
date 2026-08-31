/* global Module, Log */

/**
 * MMM-ibako_busvision.js
 *
 * 茨城交通 Bus-Vision のバス接近情報を MagicMirror² に表示するモジュール。
 * データ取得は node_helper.js が担当し、こちらは描画のみを行う。
 */

"use strict";

Module.register("MMM-ibako_busvision", {
  // -------------------------------------------------------------------------
  // 既定設定
  // -------------------------------------------------------------------------
  defaults: {
    /**
     * 表示モード
     *
     *  "stop"  : バス停ごとにセクションを分けて表示する (既定)
     *  "route" : 複数のバス停 / のりばをまとめ、系統番号で絞り込んで
     *            1 本の時刻順リストとして表示する
     *
     * 例) 水戸駅（北口）をこれから通過する 52 番と 50 番だけを一覧表示:
     *   {
     *     module: "MMM-ibako_busvision",
     *     position: "top_left",
     *     config: {
     *       mode: "route",
     *       routes: ["52", "50"],
     *       title: "水戸駅北口 52/50系統",
     *       stops: [
     *         { stopCd: 51, poleCd: 3 },
     *         { stopCd: 51, poleCd: 7 }
     *       ],
     *       maxEntries: 6
     *     }
     *   }
     */
    mode: "stop",

    /**
     * mode: "route" のときに表示する系統番号。
     * 空配列ならすべての系統を表示する。
     * 文字列 / 数値どちらでも可 ( ["52", 50] のような混在も許容 )。
     */
    routes: [],

    /**
     * routes に含まれない系統をどう扱うか。
     *   true  : 除外する (既定)
     *   false : 除外せず、系統名でのソートのみ行う
     */
    filterRoutes: true,

    /** mode: "route" のときのリスト見出し。null ならバス停名から自動生成。 */
    title: null,

    /**
     * mode: "route" で、どのバス停から来た便かを行に表示するか。
     * 複数のりばを混ぜる場合に有用。
     */
    showOriginPole: false,

    /**
     * 表示するバス停。
     *   stops: [
     *     { stopCd: 345, poleCd: 1, label: "東前団地西（上り）" }
     *   ]
     * stopCd / poleCd は Bus-Vision の URL パラメータと同じ値。
     *   https://mc.bus-vision.jp/ibako/view/approachSpecifiedStop.html
     *       ?stopCdSpecified=345&poleCdSpecified=1&lang=0
     *   → stopCd: 345, poleCd: 1
     * label を省略するとサイト上のバス停名がそのまま使われる。
     */
    stops: [],

    /** 更新間隔 (秒)。サーバ負荷対策として 30 秒未満は 30 秒に切り上げられる。 */
    updateInterval: 60,

    /**
     * 表示する便数。
     *   mode: "stop"  → 1 バス停あたりの件数
     *   mode: "route" → リスト全体の件数
     */
    maxEntries: 3,

    /** この分数より先の便は表示しない (0 / null で無制限)。 */
    maxMinutes: 0,

    /** 表示要素の ON/OFF */
    showHeaderPerStop: true,   // バス停名の見出し
    showRouteNumber: true,     // 系統番号バッジ
    showDestination: true,     // 行先
    showRouteName: false,      // 路線名 (経由) — 長いので既定は非表示
    showDelay: true,           // 遅延 / 定刻表示
    showLocation: true,        // 現在位置 (走行中) / 始発 (発車前)
    showUpdateTime: true,      // 最終更新時刻
    showNotice: false,         // サイトのお知らせ

    /**
     * 残り時間の表示方法
     *   "relative" : 「あと 12 分」
     *   "absolute" : 「13:54」
     *   "both"     : 「13:54 (あと 12 分)」
     */
    timeFormat: "both",

    /** 残り時間がこの分数以下なら強調表示する。 */
    highlightWithinMinutes: 5,

    /** すでに発車時刻を過ぎた便を何分まで残すか。 */
    keepPastMinutes: 1,

    /** 「発車前」の便も表示するか (false なら走行中のみ) */
    showBeforeDeparture: true,

    /** 画面上の残り時間を 1 秒ごとに再計算する (サーバへのアクセスは発生しない) */
    tickAnimation: true,

    /** 取得エラー時にエラー内容を画面に出す */
    showErrors: true,

    /** テーブル幅を抑える (小さい列で使う場合) */
    compact: false
  },

  requiresVersion: "2.20.0",

  // -------------------------------------------------------------------------
  // ライフサイクル
  // -------------------------------------------------------------------------

  start () {
    Log.info(`${this.name}: starting`);

    /** key ("stopCd:poleCd") -> 解析結果 */
    this.stopData = new Map();
    /** key -> エラーメッセージ */
    this.stopErrors = new Map();

    this.loaded = false;
    this.configError = null;

    if (!Array.isArray(this.config.stops) || this.config.stops.length === 0) {
      if (this.config.stopCd === undefined) {
        this.configError =
          "config.js の stops にバス停を設定してください (例: stops: [{ stopCd: 345, poleCd: 1 }])";
      }
    }

    this.sendSocketNotification("IBAKO_CONFIG", {
      identifier: this.identifier,
      config: this.config
    });

    if (this.config.tickAnimation) {
      this.tickTimer = setInterval(() => {
        if (!this.hidden && this.loaded) this.updateDom();
      }, 30 * 1000);
    }
  },

  suspend () {
    this.sendSocketNotification("IBAKO_SUSPEND", { identifier: this.identifier });
  },

  resume () {
    this.sendSocketNotification("IBAKO_RESUME", { identifier: this.identifier });
  },

  getStyles () {
    return [this.file("css/MMM-ibako_busvision.css")];
  },

  getTranslations () {
    return {
      ja: "translations/ja.json",
      en: "translations/en.json"
    };
  },

  socketNotificationReceived (notification, payload) {
    if (!payload || payload.identifier !== this.identifier) return;

    switch (notification) {
      case "IBAKO_DATA":
        this.stopErrors.delete(payload.key);
        this.stopData.set(payload.key, { ...payload.data, stop: payload.stop });
        this.loaded = true;
        this.updateDom(this.config.animationSpeed || 500);
        break;

      case "IBAKO_ERROR":
        if (payload.key) {
          this.stopErrors.set(payload.key, payload.error);
        } else {
          this.configError = payload.error;
        }
        this.loaded = true;
        this.updateDom();
        break;

      default:
        break;
    }
  },

  notificationReceived (notification) {
    // 他モジュールからの明示的な更新要求に対応
    if (notification === "IBAKO_BUSVISION_UPDATE") {
      this.sendSocketNotification("IBAKO_FORCE_UPDATE", { identifier: this.identifier });
    }
  },

  // -------------------------------------------------------------------------
  // 表示ヘルパ
  // -------------------------------------------------------------------------

  /**
   * config.routes を比較しやすい形 (大文字トリム済み文字列の Set) にする。
   * 数値指定 (50) と文字列指定 ("50") のどちらでも一致するようにする。
   */
  routeFilterSet () {
    if (this._routeSet) return this._routeSet;
    const list = Array.isArray(this.config.routes) ? this.config.routes : [];
    this._routeSet = new Set(
      list
        .map((r) => (r === null || r === undefined ? "" : String(r).trim().toUpperCase()))
        .filter((r) => r !== "")
    );
    return this._routeSet;
  },

  /**
   * 便が系統フィルタに合致するか。
   * 系統番号が取れない便 (routeNumber === null) は、
   * 路線名に系統番号らしい文字列が含まれるかで救済する。
   */
  matchesRoute (dep) {
    const wanted = this.routeFilterSet();
    if (wanted.size === 0 || !this.config.filterRoutes) return true;

    if (dep.routeNumber && wanted.has(String(dep.routeNumber).trim().toUpperCase())) {
      return true;
    }

    // 系統番号が分離できなかった便のフォールバック
    // (例: routeName = "石塚車庫－イオン内原" のように番号を持たない路線)
    if (!dep.routeNumber && dep.routeName) {
      const head = /^([0-9A-Za-z]{1,4})[\s　:：-]/.exec(dep.routeName);
      if (head && wanted.has(head[1].toUpperCase())) return true;
    }
    return false;
  },

  /** 時刻 / 表示条件による共通の絞り込み。 */
  passesTimeWindow (dep) {
    const now = Date.now();
    const keepPast = (this.config.keepPastMinutes || 0) * 60000;
    const maxMinutes = Number(this.config.maxMinutes) || 0;

    if (!this.config.showBeforeDeparture && dep.isBeforeDeparture) return false;

    if (dep.effectiveAt) {
      const t = new Date(dep.effectiveAt).getTime();
      if (t + keepPast < now) return false;
      if (maxMinutes > 0 && (t - now) / 60000 > maxMinutes) return false;
    }
    return true;
  },

  /** mode: "stop" — 1 バス停分の便を絞り込む。 */
  filterDepartures (data) {
    return (data.departures || [])
      .filter((d) => this.passesTimeWindow(d) && this.matchesRoute(d))
      .slice(0, Math.max(1, this.config.maxEntries));
  },

  /**
   * mode: "route" — 全バス停 / のりばの便を統合し、
   * 系統で絞り込んで時刻順に並べた 1 本のリストを作る。
   */
  mergedDepartures () {
    const merged = [];

    for (const [key, data] of this.stopData.entries()) {
      for (const dep of data.departures || []) {
        if (!this.passesTimeWindow(dep)) continue;
        if (!this.matchesRoute(dep)) continue;
        merged.push({
          ...dep,
          _sourceKey: key,
          _sourceLabel:
            (data.stop && data.stop.label) || data.stopName || null,
          _sourcePole: data.poleName || (data.stop ? `のりば${data.stop.poleCd}` : null)
        });
      }
    }

    // 同一便が複数のりばに重複して現れる場合を除去
    // (同じ時刻・同じ系統・同じ行先なら同一便とみなす)
    const seen = new Set();
    const unique = [];
    for (const dep of merged) {
      const sig = [
        dep.effectiveAt || `${dep.time ? dep.time.hour : "?"}:${dep.time ? dep.time.minute : "?"}`,
        dep.routeNumber || dep.routeName || "?",
        dep.destination || "?"
      ].join("|");
      if (seen.has(sig)) continue;
      seen.add(sig);
      unique.push(dep);
    }

    unique.sort((a, b) => {
      if (a.effectiveAt && b.effectiveAt) return a.effectiveAt.localeCompare(b.effectiveAt);
      if (a.effectiveAt) return -1;
      if (b.effectiveAt) return 1;
      return 0;
    });

    return unique.slice(0, Math.max(1, this.config.maxEntries));
  },

  /**
   * 残り時間 (分) を再計算する。
   *
   * effectiveAt は絶対時刻 (ISO/UTC) なので、端末のタイムゾーンが
   * JST でなくても Date.now() との差分は正しく求まる。
   * ただし端末の時計自体が大きくずれている場合は誤差になるため、
   * サーバ計算値と 10 分以上乖離するならサーバ値を採用する。
   */
  liveMinutes (dep) {
    if (!dep.effectiveAt) return dep.minutesUntil;

    const live = Math.round((new Date(dep.effectiveAt).getTime() - Date.now()) / 60000);

    if (dep.minutesUntil !== null && Math.abs(live - dep.minutesUntil) > 10) {
      return dep.minutesUntil;
    }
    return live;
  },

  /**
   * {hour, minute} → "13:54"
   * Bus-Vision の時刻は JST の壁時計時刻なので、
   * 端末のタイムゾーンに関係なくそのまま表示する。
   */
  formatHm (hm) {
    if (!hm) return "--:--";
    return `${String(hm.hour % 24).padStart(2, "0")}:${String(hm.minute).padStart(2, "0")}`;
  },

  /** 残り時間の文字列を作る。 */
  formatCountdown (minutes) {
    if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return "";
    if (minutes < 0) return this.translate("DEPARTED");
    if (minutes === 0) return this.translate("SOON");
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return m === 0
        ? this.translate("IN_HOURS", { hours: h })
        : this.translate("IN_HOURS_MINUTES", { hours: h, minutes: m });
    }
    return this.translate("IN_MINUTES", { minutes });
  },

  // -------------------------------------------------------------------------
  // 描画
  // -------------------------------------------------------------------------

  getDom () {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-ibako-busvision";
    if (this.config.compact) wrapper.classList.add("compact");

    if (this.configError) {
      wrapper.appendChild(this.buildMessage(this.configError, "error"));
      return wrapper;
    }

    if (!this.loaded) {
      wrapper.appendChild(this.buildMessage(this.translate("LOADING"), "dimmed light small"));
      return wrapper;
    }

    const keys = [...this.stopData.keys()];
    // エラーのみのバス停も表示する
    for (const key of this.stopErrors.keys()) {
      if (!keys.includes(key)) keys.push(key);
    }

    if (keys.length === 0) {
      wrapper.appendChild(this.buildMessage(this.translate("NO_DATA"), "dimmed light small"));
      return wrapper;
    }

    if (this.config.mode === "route") {
      wrapper.classList.add("mode-route");
      wrapper.appendChild(this.buildRouteList());
      return wrapper;
    }

    for (const key of keys) {
      wrapper.appendChild(this.buildStopSection(key));
    }
    return wrapper;
  },

  /**
   * mode: "route" のリストを組み立てる。
   * 複数バス停 / のりばを統合し、系統で絞った 1 本のリストにする。
   */
  buildRouteList () {
    const section = document.createElement("div");
    section.className = "ibako-stop ibako-route-list";

    // --- 見出し -------------------------------------------------------------
    if (this.config.showHeaderPerStop) {
      const header = document.createElement("div");
      header.className = "ibako-stop-header";

      const name = document.createElement("span");
      name.className = "ibako-stop-name";
      name.textContent = this.config.title || this.autoRouteTitle();
      header.appendChild(name);

      // 最新の更新時刻 (複数バス停のうち一番新しいもの) を表示
      if (this.config.showUpdateTime) {
        const latest = [...this.stopData.values()]
          .map((d) => d.updateTimeText)
          .filter(Boolean)
          .sort()
          .pop();
        if (latest) {
          const upd = document.createElement("span");
          upd.className = "ibako-update-time dimmed xsmall";
          upd.textContent = this.translate("UPDATED_AT", { time: latest.split(" ").pop() });
          header.appendChild(upd);
        }
      }
      section.appendChild(header);
    }

    // --- お知らせ (重複を除いて 1 回だけ) -----------------------------------
    if (this.config.showNotice) {
      const notices = [
        ...new Set([...this.stopData.values()].map((d) => d.notice).filter(Boolean))
      ];
      for (const text of notices) {
        const notice = document.createElement("div");
        notice.className = "ibako-notice xsmall dimmed";
        notice.textContent = text;
        section.appendChild(notice);
      }
    }

    // --- エラー -------------------------------------------------------------
    if (this.config.showErrors && this.stopErrors.size > 0) {
      const err = [...this.stopErrors.values()][0];
      section.appendChild(
        this.buildMessage(this.translate("FETCH_ERROR", { error: err }), "error xsmall")
      );
    }

    // --- 便一覧 -------------------------------------------------------------
    const departures = this.mergedDepartures();

    if (departures.length === 0) {
      const wanted = this.routeFilterSet();
      const msg = wanted.size > 0
        ? this.translate("NO_BUS_FOR_ROUTES", { routes: [...wanted].join(", ") })
        : this.translate("NO_BUS");
      section.appendChild(this.buildMessage(msg, "dimmed light small"));
      return section;
    }

    const table = document.createElement("table");
    table.className = "ibako-table small";
    for (const dep of departures) {
      table.appendChild(this.buildDepartureRow(dep));
    }
    section.appendChild(table);

    return section;
  },

  /** title 未設定時の見出しを自動生成する ("水戸駅（北口） 52/50系統")。 */
  autoRouteTitle () {
    const names = [
      ...new Set(
        [...this.stopData.values()]
          .map((d) => (d.stop && d.stop.label) || d.stopName)
          .filter(Boolean)
      )
    ];
    const stopPart = names.length > 0 ? names.join(" / ") : this.translate("NO_DATA");

    const wanted = this.routeFilterSet();
    if (wanted.size === 0) return stopPart;
    return this.translate("ROUTE_TITLE", {
      stop: stopPart,
      routes: [...wanted].join("/")
    });
  },

  buildMessage (text, className) {
    const div = document.createElement("div");
    div.className = `ibako-message ${className || ""}`.trim();
    div.textContent = text;
    return div;
  },

  /** バス停 1 つ分のセクションを組み立てる。 */
  buildStopSection (key) {
    const section = document.createElement("div");
    section.className = "ibako-stop";

    const data = this.stopData.get(key);
    const error = this.stopErrors.get(key);

    // --- 見出し -------------------------------------------------------------
    if (this.config.showHeaderPerStop) {
      const header = document.createElement("div");
      header.className = "ibako-stop-header";

      const name = document.createElement("span");
      name.className = "ibako-stop-name";
      const configured = data && data.stop && data.stop.label;
      name.textContent =
        configured || (data && data.stopName) || `stopCd=${key.split(":")[0]}`;
      header.appendChild(name);

      if (data && data.poleName) {
        const pole = document.createElement("span");
        pole.className = "ibako-pole-name dimmed";
        pole.textContent = data.poleName;
        header.appendChild(pole);
      }

      if (this.config.showUpdateTime && data && data.updateTimeText) {
        const upd = document.createElement("span");
        upd.className = "ibako-update-time dimmed xsmall";
        // "2026/08/29 13:01" → "13:01"
        const hm = data.updateTimeText.split(" ").pop();
        upd.textContent = this.translate("UPDATED_AT", { time: hm });
        header.appendChild(upd);
      }

      section.appendChild(header);
    }

    // --- お知らせ -----------------------------------------------------------
    if (this.config.showNotice && data && data.notice) {
      const notice = document.createElement("div");
      notice.className = "ibako-notice xsmall dimmed";
      notice.textContent = data.notice;
      section.appendChild(notice);
    }

    // --- エラー -------------------------------------------------------------
    if (error && this.config.showErrors) {
      section.appendChild(
        this.buildMessage(this.translate("FETCH_ERROR", { error }), "error xsmall")
      );
      // 前回データがあれば古い情報として続けて表示する
      if (!data) return section;
    }

    if (!data) {
      section.appendChild(this.buildMessage(this.translate("LOADING"), "dimmed light small"));
      return section;
    }

    // --- 便一覧 -------------------------------------------------------------
    const departures = this.filterDepartures(data);

    if (departures.length === 0) {
      const msg = data.message || this.translate("NO_BUS");
      section.appendChild(this.buildMessage(msg, "dimmed light small"));
      return section;
    }

    const table = document.createElement("table");
    table.className = "ibako-table small";
    for (const dep of departures) {
      table.appendChild(this.buildDepartureRow(dep));
    }
    section.appendChild(table);

    return section;
  },

  /** 便 1 件の行を組み立てる。 */
  buildDepartureRow (dep) {
    const row = document.createElement("tr");
    row.className = "ibako-row";
    row.classList.add(dep.isBeforeDeparture ? "state-before" : "state-running");

    const minutes = this.liveMinutes(dep);
    if (
      minutes !== null &&
      minutes >= 0 &&
      minutes <= this.config.highlightWithinMinutes
    ) {
      row.classList.add("imminent");
    }

    // --- 1列目: 時刻 / 残り時間 ---------------------------------------------
    const timeCell = document.createElement("td");
    timeCell.className = "ibako-time";

    const fmt = this.config.timeFormat;
    if (fmt === "relative") {
      timeCell.appendChild(this.buildCountdown(minutes));
    } else if (fmt === "absolute") {
      timeCell.appendChild(this.buildClock(dep));
    } else {
      timeCell.appendChild(this.buildClock(dep));
      const cd = this.buildCountdown(minutes);
      cd.classList.add("xsmall", "dimmed");
      timeCell.appendChild(cd);
    }
    row.appendChild(timeCell);

    // --- 2列目: 路線 / 行先 / 位置 ------------------------------------------
    const infoCell = document.createElement("td");
    infoCell.className = "ibako-info";

    const line1 = document.createElement("div");
    line1.className = "ibako-line1";

    if (this.config.showRouteNumber && dep.routeNumber) {
      const badge = document.createElement("span");
      badge.className = "ibako-route-badge";
      badge.textContent = dep.routeNumber;
      line1.appendChild(badge);
    }

    if (this.config.showDestination && dep.destination) {
      const dest = document.createElement("span");
      dest.className = "ibako-destination";
      dest.textContent = dep.destination;
      line1.appendChild(dest);
    } else if (dep.routeName) {
      const dest = document.createElement("span");
      dest.className = "ibako-destination";
      dest.textContent = dep.routeName;
      line1.appendChild(dest);
    }
    infoCell.appendChild(line1);

    if (this.config.showRouteName && dep.routeName) {
      const via = document.createElement("div");
      via.className = "ibako-route-name xsmall dimmed";
      via.textContent = dep.routeName;
      infoCell.appendChild(via);
    }

    // mode: "route" で複数のりばを混ぜている場合、どこから来る便かを示す
    if (this.config.showOriginPole && dep._sourcePole) {
      const pole = document.createElement("div");
      pole.className = "ibako-source-pole xsmall dimmed";
      pole.textContent = dep._sourceLabel
        ? `${dep._sourceLabel} ${dep._sourcePole}`
        : dep._sourcePole;
      infoCell.appendChild(pole);
    }

    if (this.config.showLocation) {
      const loc = this.buildLocationText(dep);
      if (loc) {
        const locDiv = document.createElement("div");
        locDiv.className = "ibako-location xsmall dimmed";
        locDiv.textContent = loc;
        infoCell.appendChild(locDiv);
      }
    }

    if (dep.remarks) {
      const rem = document.createElement("div");
      rem.className = "ibako-remarks xsmall";
      rem.textContent = dep.remarks;
      infoCell.appendChild(rem);
    }

    row.appendChild(infoCell);

    // --- 3列目: 状態 (発車前 / 遅延) ----------------------------------------
    const statusCell = document.createElement("td");
    statusCell.className = "ibako-status";
    if (this.config.showDelay) {
      statusCell.appendChild(this.buildStatusBadge(dep));
    }
    row.appendChild(statusCell);

    return row;
  },

  /** 時刻表示。走行中で遅延がある場合は定刻に取り消し線を入れる。 */
  buildClock (dep) {
    const box = document.createElement("div");
    box.className = "ibako-clock";

    const hasShift =
      dep.isRunning &&
      dep.scheduledTime &&
      dep.predictedTime &&
      (dep.scheduledTime.hour !== dep.predictedTime.hour ||
        dep.scheduledTime.minute !== dep.predictedTime.minute);

    if (hasShift) {
      const sched = document.createElement("span");
      sched.className = "ibako-scheduled-strike dimmed xsmall";
      sched.textContent = this.formatHm(dep.scheduledTime);
      box.appendChild(sched);
    }

    const main = document.createElement("span");
    main.className = "ibako-time-main bright";
    main.textContent = this.formatHm(dep.time);
    box.appendChild(main);

    return box;
  },

  buildCountdown (minutes) {
    const span = document.createElement("div");
    span.className = "ibako-countdown";
    span.textContent = this.formatCountdown(minutes);
    return span;
  },

  /**
   * 位置情報のテキスト。
   *  - 発車前 : 「大串公園 13:50 発車前」(まだ始発を出ていない)
   *  - 走行中 : 「保和苑入口 (15個前)」  (現在通過中の停留所)
   */
  buildLocationText (dep) {
    if (dep.isRunning) {
      if (!dep.currentStop) return dep.approachInfo || null;
      return dep.stopsBefore !== null
        ? this.translate("LOCATION_RUNNING", {
          stop: dep.currentStop,
          count: dep.stopsBefore
        })
        : dep.currentStop;
    }

    // 発車前
    if (dep.originStop) {
      return this.translate("LOCATION_BEFORE", { stop: dep.originStop });
    }
    // 対象バス停自体が始発の場合、originStop は存在しない
    return this.translate("LOCATION_BEFORE_HERE");
  },

  /** 状態バッジ (発車前 / ほぼ定刻 / +7分)。 */
  buildStatusBadge (dep) {
    const badge = document.createElement("span");
    badge.className = "ibako-badge";

    if (dep.isBeforeDeparture) {
      badge.classList.add("badge-before");
      badge.textContent = this.translate("BEFORE_DEPARTURE");
      return badge;
    }

    const delay = dep.delay;
    if (!delay) {
      badge.classList.add("badge-unknown");
      badge.textContent = dep.statusText || "";
      return badge;
    }

    if (delay.onTime) {
      badge.classList.add("badge-ontime");
      badge.textContent = this.translate("ON_TIME");
      return badge;
    }

    if (delay.minutes === null) {
      badge.classList.add("badge-unknown");
      badge.textContent = delay.text || "";
      return badge;
    }

    if (delay.minutes > 0) {
      badge.classList.add("badge-late");
      badge.textContent = this.translate("DELAY_LATE", { minutes: delay.minutes });
    } else if (delay.minutes < 0) {
      badge.classList.add("badge-early");
      badge.textContent = this.translate("DELAY_EARLY", { minutes: Math.abs(delay.minutes) });
    } else {
      badge.classList.add("badge-ontime");
      badge.textContent = this.translate("ON_TIME");
    }
    return badge;
  }
});
