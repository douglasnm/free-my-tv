/*
 * What the home screen shows, kept in localStorage so it opens with numbers:
 *  - the picks: what's trending this week and recent releases, only from the streaming apps on this TV (TMDB, with
 *    the person's own free key from config.properties), three per hour;
 *  - weather, sunrise and sunset (Open-Meteo, every 30 min) and optional crypto prices (Binance, every 5 min).
 * Settings changed on the TV (Prefs) win over config.properties, as on Android. Built without a city (--generic), the
 * TV's time zone gives the city, and its country the currency and the region (zones.js).
 */
var CONFIG = window.CONFIG || {};

var Place = (function () {
  'use strict';
  var EURO = /^(AT|BE|CY|DE|EE|ES|FI|FR|GR|HR|IE|IT|LT|LU|LV|MT|NL|PT|SI|SK)$/;

  /** A time zone's main city: {country, lat, lon, name}, or null. */
  function zone(name) {
    var all = window.ZONES || {}, v = all[name], hops = 0;
    while (v && v.charAt(0) === '=' && hops++ < 3) { name = v.slice(1); v = all[name]; }
    if (!v) return null;
    var p = v.split(',');
    return {country: p[0], lat: p[1], lon: p[2], name: p[3] || name.slice(name.lastIndexOf('/') + 1).replace(/_/g, ' ')};
  }

  var tz = zone(TV.zone()), set = CONFIG.latitude !== '' && CONFIG.latitude !== undefined;
  var country = (CONFIG.tmdbRegion || (tz ? tz.country : '') || 'US').toUpperCase();
  return {
    lat: set ? CONFIG.latitude : tz ? tz.lat : '40.7128',
    lon: set ? CONFIG.longitude : tz ? tz.lon : '-74.0060',
    city: CONFIG.city || (!set && tz ? tz.name : ''),
    country: country,
    currency: (CONFIG.currency || (country === 'BR' ? 'BRL' : EURO.test(country) ? 'EUR' : 'USD')).toUpperCase(),
    /** Fahrenheit for TVs in the US (by their time zone, or their language when it doesn't tell). */
    fahrenheit: tz ? tz.country === 'US' : /-US$/i.test(navigator.language || '')
  };
})();

var Prefs = (function () {
  'use strict';
  var KEY = 'fmtv.prefs';
  var v = {};
  try { v = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function pick(name, fallback) { return v[name] === undefined ? fallback : v[name]; }
  return {
    version: 0,
    language: function () { return pick('language', CONFIG.language || 'auto'); },
    temperature: function () { return pick('temperature', CONFIG.temperature || 'auto'); },
    theme: function () { return pick('theme', 'dark'); },
    weather: function () { return pick('weather', true); },
    us: function () { return pick('us', true); },
    team: function () { return pick('team', true); },
    quotes: function () { return pick('quotes', CONFIG.showCrypto !== false); },
    coin: function (i) { var c = pick('coins', null); return c ? c[i] !== false : true; },
    shelf: function () { return pick('shelf', null); },
    /** The shelf_apps of the build that last set the shelf, so a new one wins once over the TV's choice. */
    shelfConfig: function () { return pick('shelfConfig', ''); },
    set: function (name, value) { v[name] = value; save(); this.version++; },
    setCoin: function (i, on) {
      var c = (pick('coins', null) || [true, true, true, true, true]).slice();
      c[i] = on;
      this.set('coins', c);
    }
  };
})();

var Data = (function () {
  'use strict';

  function store(key, value) { try { localStorage.setItem('fmtv.' + key, JSON.stringify(value)); } catch (e) {} }
  function stored(key) { try { return JSON.parse(localStorage.getItem('fmtv.' + key)); } catch (e) { return null; } }

  /** GET a JSON document; done(error, json). */
  function get(url, headers, done) {
    var x = new XMLHttpRequest();
    var over = false;
    x.open('GET', url, true);
    x.timeout = 10000;
    for (var h in headers) if (headers.hasOwnProperty(h)) x.setRequestHeader(h, headers[h]);
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || over) return;
      over = true;
      if (x.status !== 200) { done(new Error(x.status === 401 ? 'TMDB rejected the key' : 'HTTP ' + x.status)); return; }
      var json;
      try { json = JSON.parse(x.responseText); } catch (e) { done(e); return; }
      done(null, json);
    };
    x.ontimeout = x.onerror = function () { if (!over) { over = true; done(new Error('no connection')); } };
    x.send();
  }

  var listeners = [];
  function changed() { for (var i = 0; i < listeners.length; i++) listeners[i](); }

  // MARK: - Weather

  var PLACE = Place.lat + ',' + Place.lon;
  var weather = null, weatherAt = 0, fetchingWeather = false;
  (function () {
    var w = stored('weather');
    if (w && w.place === PLACE) { weather = parseWeather(w.body); weatherAt = w.at; }
  })();

  /** "2026-10-20T18:31" at the location (Open-Meteo's local time) → epoch ms. */
  function localTime(iso, offsetSeconds) {
    var m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(iso || '');
    if (!m) return 0;
    return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) - offsetSeconds * 1000;
  }

  function parseWeather(o) {
    if (!o || !o.current) return null;
    var off = o.utc_offset_seconds || 0, now = Date.now();
    var w = {
      temp: o.current.temperature_2m, code: o.current.weather_code, isDay: o.current.is_day !== 0,
      max: o.daily.temperature_2m_max[0], min: o.daily.temperature_2m_min[0],
      sunrise: localTime(o.daily.sunrise[0], off), sunset: localTime(o.daily.sunset[0], off), hours: []
    };
    var hr = o.hourly;
    for (var i = 0; hr && i < hr.time.length && w.hours.length < 6; i++) {
      var at = localTime(hr.time[i], off);
      if (at <= now) continue;
      w.hours.push({at: at, temp: hr.temperature_2m[i], code: hr.weather_code[i], day: !hr.is_day || hr.is_day[i] !== 0});
    }
    return w;
  }

  function refreshWeather() {
    var now = Date.now();
    if (fetchingWeather || (now - weatherAt < 30 * 60000 && now >= weatherAt)) return;
    fetchingWeather = true;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + Place.lat + '&longitude=' + Place.lon
        + '&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset'
        + '&hourly=temperature_2m,weather_code,is_day&timezone=auto&forecast_days=2';
    get(url, {}, function (err, body) {
      fetchingWeather = false;
      if (err) return;
      weather = parseWeather(body);
      weatherAt = Date.now();
      store('weather', {place: PLACE, body: body, at: weatherAt});
      changed();
    });
  }

  // MARK: - Prices

  // B3 em vez de criptomoedas: Ibovespa (HG Brasil), dólar (AwesomeAPI) e as 60 ações mais negociadas (brapi, sem
  // chave). Dessa lista saem as maiores altas, as maiores baixas e as mais negociadas, que se alternam na tela.
  var CURRENCY = 'BRL';
  var ROWS = 5;   // Ibovespa, dólar e 3 ações da página atual
  var NAMES = ['Ibovespa', 'Dólar', '', '', ''], LABELS = ['IBOV', 'US$', '', '', ''];
  var prices = [NaN, NaN, NaN, NaN, NaN], changes = [NaN, NaN, NaN, NaN, NaN];
  var market = {ibov: null, usd: null, stocks: [], at: 0}, pricesAt = 0, fetchingPrices = false;
  var pages = [], page = 0, pageTitle = '', rotateListeners = [];

  function buildPages() {
    var s = market.stocks.filter(function (x) { return x.p >= 1; });
    var groups = [
      ['Maiores altas', s.filter(function (x) { return x.c > 0; }).sort(function (a, b) { return b.c - a.c; })],
      ['Maiores baixas', s.filter(function (x) { return x.c < 0; }).sort(function (a, b) { return a.c - b.c; })],
      ['Mais negociadas', s.slice().sort(function (a, b) { return b.v - a.v; })]
    ];
    pages = [];
    for (var start = 0; start < 6; start += 3) {
      for (var g = 0; g < groups.length; g++) {
        var part = groups[g][1].slice(start, start + 3);
        if (part.length) pages.push({title: groups[g][0], items: part});
      }
    }
  }

  function showPage() {
    var pg = pages.length ? pages[page % pages.length] : null;
    pageTitle = pg ? pg.title : '';
    for (var k = 0; k < 3; k++) {
      var x = pg && pg.items[k], i = 2 + k;
      NAMES[i] = LABELS[i] = x ? x.s : '';
      prices[i] = x ? x.p : NaN;
      changes[i] = x ? x.c : NaN;
    }
  }

  function setFixed() {
    prices[0] = market.ibov ? market.ibov[0] : NaN; changes[0] = market.ibov ? market.ibov[1] : NaN;
    prices[1] = market.usd ? market.usd[0] : NaN; changes[1] = market.usd ? market.usd[1] : NaN;
  }

  /** Rows on screen: the two fixed ones and the stocks of the current page. */
  function activeCoins() {
    var out = [];
    if (!Prefs.quotes()) return out;
    for (var i = 0; i < ROWS; i++) if (i < 2 || NAMES[i]) out.push(i);
    return out;
  }

  (function () {
    var m = stored('quotesB3v2');
    if (!m || !m.stocks) return;
    market = m; pricesAt = m.at;
    setFixed(); buildPages(); showPage();
  })();

  setInterval(function () {
    if (pages.length < 2) return;
    page++;
    showPage();
    for (var i = 0; i < rotateListeners.length; i++) rotateListeners[i]();
  }, 8000);

  function refreshPrices() {
    var now = Date.now();
    if (!activeCoins().length || fetchingPrices || (now - pricesAt < 5 * 60000 && now >= pricesAt)) return;
    fetchingPrices = true;
    var pending = 3, got = false;
    function done() {
      if (--pending) return;
      fetchingPrices = false;
      if (!got) return;
      pricesAt = market.at = Date.now();
      setFixed(); buildPages(); showPage();
      store('quotesB3v2', market);
      changed();
    }
    get('https://api.hgbrasil.com/finance?format=json-cors', {}, function (err, o) {
      try { var b = o.results.stocks.IBOVESPA; if (!isNaN(b.points)) { market.ibov = [b.points, b.variation]; got = true; } } catch (e) {}
      try {
        var st = o.results.stocks, cu = o.results.currencies;
        market.nasdaq = [st.NASDAQ.points, st.NASDAQ.variation];
        market.dow = [st.DOWJONES.points, st.DOWJONES.variation];
        market.eur = [cu.EUR.buy, cu.EUR.variation];
      } catch (e) {}
      done();
    });
    get('https://economia.awesomeapi.com.br/json/last/USD-BRL', {}, function (err, o) {
      try { var v = parseFloat(o.USDBRL.bid); if (!isNaN(v)) { market.usd = [v, parseFloat(o.USDBRL.pctChange)]; got = true; } } catch (e) {}
      done();
    });
    get('https://brapi.dev/api/quote/list?sortBy=volume&sortOrder=desc&limit=60&type=stock', {}, function (err, o) {
      try {
        var list = [];
        for (var k = 0; k < o.stocks.length; k++) {
          var r = o.stocks[k];
          if (typeof r.close === 'number' && typeof r.change === 'number') list.push({s: r.stock, p: r.close, c: r.change, v: r.volume || 0});
        }
        if (list.length) { market.stocks = list; got = true; }
      } catch (e) {}
      done();
    });
  }

  /** Rows of the Brazilian card: Ibovespa and the 3 stocks of the page (the dollar goes to the US card). */
  function brRows() {
    var out = [];
    if (!Prefs.quotes()) return out;
    var all = [0, 2, 3, 4];
    for (var k = 0; k < all.length; k++) if (all[k] === 0 || NAMES[all[k]]) out.push(all[k]);
    return out;
  }

  /** The US card: Nasdaq, Dow Jones, and the dollar and euro in reais. */
  function usRows() {
    var m = market;
    function row(name, v, digits, pct, reais) {
      return {name: name, text: v ? (reais ? 'R$ ' : '') + fmt(v[0], digits) : '—', change: v ? v[1] : NaN};
    }
    if (!Prefs.us()) return [];
    return [row('Nasdaq', m.nasdaq, 0), row('Dow Jones', m.dow, 0), row('Dólar', m.usd, 2, 0, true), row('Euro', m.eur, 2, 0, true)];
  }

  // MARK: - Palmeiras (ESPN: results and next games, in every competition)

  var PAL = '2029';
  var team = {live: null, next: [], last: [], at: 0}, fetchingTeam = false;
  (function () { var t = stored('palmeiras'); if (t && t.next) team = t; })();

  var LEAGUES = {'Brazilian Serie A': 'Brasileirão', 'CONMEBOL Libertadores': 'Libertadores', 'Brazilian Campeonato Paulista': 'Paulistão',
    'CONMEBOL Sudamericana': 'Sul-Americana', 'FIFA Club World Cup': 'Mundial de Clubes'};

  function parseEvent(e) {
    var c = e.competitions && e.competitions[0];
    if (!c) return null;
    var me = null, opp = null;
    for (var i = 0; i < c.competitors.length; i++) {
      if (String(c.competitors[i].team.id) === PAL) me = c.competitors[i]; else opp = c.competitors[i];
    }
    if (!me || !opp) return null;
    function score(x) { var v = x.score; if (v && typeof v === 'object') v = v.displayValue; return v === undefined || v === null || v === '' ? '' : String(v); }
    var league = e.league && e.league.name ? e.league.name : '';
    return {id: e.id, at: new Date(e.date).getTime(), state: c.status.type.state, home: me.homeAway === 'home',
      opp: opp.team.shortDisplayName || opp.team.displayName || opp.team.abbreviation, mine: score(me), theirs: score(opp),
      clock: c.status.displayClock || '', league: LEAGUES[league] || league.replace(/^Brazilian /, '')};
  }

  function refreshTeam() {
    var now = Date.now(), every = team.live ? 2 * 60000 : 15 * 60000;
    if (!Prefs.team() || fetchingTeam || (now - team.at < every && now >= team.at)) return;
    fetchingTeam = true;
    var base = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/all/teams/' + PAL + '/schedule';
    var pending = 2, events = {};
    function done() {
      if (--pending) return;
      fetchingTeam = false;
      var list = [];
      for (var id in events) if (events.hasOwnProperty(id)) list.push(events[id]);
      if (!list.length) return;
      list.sort(function (a, b) { return a.at - b.at; });
      var t = {live: null, next: [], last: [], at: Date.now()};
      for (var i = 0; i < list.length; i++) {
        if (list[i].state === 'in') t.live = list[i];
        else if (list[i].state === 'pre') t.next.push(list[i]);
        else if (list[i].state === 'post') t.last.push(list[i]);
      }
      t.last = t.last.slice(-2).reverse();
      t.next = t.next.slice(0, 3);
      team = t;
      store('palmeiras', t);
      changed();
    }
    function take(err, o) {
      try { for (var i = 0; i < o.events.length; i++) { var p = parseEvent(o.events[i]); if (p) events[p.id] = p; } } catch (e) {}
      done();
    }
    get(base, {}, take);
    get(base + '?fixture=true', {}, take);
  }

  // MARK: - Picks (TMDB)

  var KEY = (CONFIG.tmdbKey || '').trim();
  var REGION = Place.country;
  var API = 'https://api.themoviedb.org/3';

  /** Service name on TMDB (part of it, lowercase) → our key, how to find its app on the TV (id, name), its name. */
  var SERVICES = [
    ['netflix', 'netflix', /^netflix$/, /netflix/i, 'Netflix'],
    ['prime video', 'prime', /^amazon$/, /prime video|amazon/i, 'Prime Video'],
    ['disney', 'disney', /disney/, /disney/i, 'Disney+'],
    ['hulu', 'hulu', /^hulu/, /hulu/i, 'Hulu'],
    ['paramount', 'paramount', /paramount|cbs/, /paramount/i, 'Paramount+'],
    ['peacock', 'peacock', /peacock/, /peacock/i, 'Peacock'],
    ['globoplay', 'globoplay', /globoplay/, /globoplay/i, 'Globoplay'],
    ['max', 'max', /hbo|wbd|\.max/, /^(hbo )?max$|hbo max/i, 'Max'],
    ['apple tv', 'appletv', /appletv|apple\.tv/, /apple tv/i, 'Apple TV'],
    ['hotstar', 'hotstar', /hotstar/, /hotstar/i, 'JioHotstar'],
    ['crunchyroll', 'crunchyroll', /crunchyroll/, /crunchyroll/i, 'Crunchyroll']
  ];

  var installed = [];   // the TV's apps, from TV.apps()

  /** The installed app for a service key, or null. */
  function appFor(key) {
    for (var s = 0; s < SERVICES.length; s++) {
      if (SERVICES[s][1] !== key) continue;
      for (var i = 0; i < installed.length; i++) {
        if (SERVICES[s][2].test(installed[i].id) || SERVICES[s][3].test(installed[i].title)) return installed[i];
      }
    }
    return null;
  }

  /** "… Amazon Channel" is sold inside another app; Apple TV is only the streaming service (350; 2 is the store). */
  function service(providerName, providerId) {
    var n = (providerName || '').toLowerCase();
    if (n.indexOf(' channel') >= 0) return null;
    for (var i = 0; i < SERVICES.length; i++) {
      var s = SERVICES[i];
      if (s[1] === 'appletv' && providerId !== 350) continue;
      if (s[0] === 'max' ? /\bmax\b/.test(n) : n.indexOf(s[0]) >= 0) return s;
    }
    return null;
  }

  function tmdb(path, done) {
    var bearer = KEY.indexOf('eyJ') === 0;   // read access token (v4) or API key (v3)
    var url = API + path + (bearer ? '' : (path.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(KEY));
    get(url, bearer ? {Authorization: 'Bearer ' + KEY, Accept: 'application/json'} : {Accept: 'application/json'}, done);
  }

  var cache = stored('recs') || {};
  var picks = cache.picks || [], listAt = cache.listAt || 0, period = cache.period, listLang = cache.lang || '', stamp = cache.stamp || '';
  var fetchingRecs = false, failedAt = 0, recsError = '';

  function saveRecs() { store('recs', {picks: picks, listAt: listAt, period: period, lang: listLang, stamp: stamp}); }

  function hourPeriod(d) {
    var h = d.getHours();
    return h >= 5 && h < 12 ? 0 : h >= 12 && h < 18 ? 1 : 2;
  }

  function sourceStamp() {
    var s = KEY.length + ':' + KEY.slice(-6) + ':' + REGION + (CONFIG.hideAnimation ? ':no-animation' : '');
    for (var i = 0; i < SERVICES.length; i++) s += appFor(SERVICES[i][1]) ? '1' : '0';
    return s;
  }

  function franchise(title) {
    var t = (title || '').toLowerCase(), cut = t.indexOf(':');
    if (cut < 0) cut = t.indexOf(' - ');
    return (cut > 0 ? t.slice(0, cut) : t).replace(/^\s+|\s+$/g, '');
  }

  /** This hour's 3 picks: movies ("movie"), shows ("tv") or both (null). */
  function now(kind) {
    var list = [];
    if (!KEY) return list;
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i];
      if ((kind === null || kind === p.kind) && (!p.detailed || (p.app && appFor(p.app)))) list.push(p);
    }
    if (!list.length) return list;
    var hour = Math.floor(Date.now() / 3600000), out = [], seen = {};
    for (var j = 0; j < list.length && out.length < 3; j++) {
      var q = list[(hour * 3 + j) % list.length], f = franchise(q.title);
      if (!seen[f]) { seen[f] = true; out.push(q); }
    }
    return out;
  }

  /** TMDB's language, as on Android: Latin American Spanish unless the TV is in Spain, and Germany's German. */
  function lang() {
    if (I18N.lang === 'es') return /-ES\b/i.test(navigator.language || '') ? 'es-ES' : 'es-MX';
    if (I18N.lang === 'de') return 'de-DE';   // TMDB's de-AT and de-CH have few translations of their own
    return I18N.locale();
  }

  function day(offset) {
    var d = new Date(Date.now() + offset * 86400000);
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }

  /** TMDB's genres that it leaves in English in some languages. */
  function genre(name) {
    switch (name) {
      case 'Action & Adventure': return tr('genre|Action & Adventure');
      case 'Sci-Fi & Fantasy': return tr('genre|Sci-Fi & Fantasy');
      case 'War & Politics': return tr('genre|War & Politics');
      case 'Kids': return tr('genre|Kids');
      case 'News': return tr('genre|News');
      case 'Soap': return tr('genre|Soap');
      case 'Talk': return tr('genre|Talk');
      default: return name;
    }
  }

  /** The best backdrop: no text over it, the largest, then the best rated. */
  function bestBackdrop(images) {
    var list = images && images.backdrops, best = null, score = -1;
    for (var i = 0; list && i < list.length; i++) {
      var b = list[i];
      if (!b.file_path) continue;
      var s = (b.iso_639_1 === null ? 1e7 : 0) + Math.min(b.width || 0, 3840) * 100 + (b.vote_average || 0);
      if (s > score) { score = s; best = b.file_path; }
    }
    return best;
  }

  /** Genre, runtime or seasons, and the service it's on among the TV's apps. */
  function details(p, done) {
    tmdb('/' + p.kind + '/' + p.id + '?language=' + lang() + '&append_to_response=watch/providers,images&include_image_language=null,'
        + I18N.base + ',en', function (err, o) {
      if (err) { done(err); return; }
      var best = bestBackdrop(o.images);
      if (best) p.backdrop = best;
      var parts = [];
      if (p.kind === 'tv') parts.push(tr('Series'));
      if (o.genres && o.genres.length) {
        parts.push(genre(o.genres[0].name));
      }
      if (p.kind === 'movie' && o.runtime > 0) {
        var h = Math.floor(o.runtime / 60), m = o.runtime % 60;
        parts.push(h ? trf('{h}h {m}m', {h: h, m: m}) : trf('{m}m', {m: m}));
      } else if (p.kind === 'tv' && o.number_of_seasons > 0) {
        parts.push(plural('plural|one:{n} season|other:{n} seasons', o.number_of_seasons));
      }
      var wp = o['watch/providers'], here = wp && wp.results && wp.results[REGION], flat = here && here.flatrate;
      p.app = null;
      for (var i = 0; flat && i < flat.length && !p.app; i++) {
        var s = service(flat[i].provider_name, flat[i].provider_id);
        if (s && appFor(s[1])) { p.app = s[1]; p.service = s[4]; }
      }
      if (p.service && p.app) parts.push(p.service);
      p.meta = parts.join(' · ');
      title(p, o, function () {
        p.detailed = true;
        done(null);
      });
    });
  }

  /**
   * Without a title in the TV's language TMDB answers with the original one, so a Korean series on a German TV reads
   * "닥터X: 하얀 마피아의 시대". Then the English title, when TMDB has one (one more request, only for those).
   */
  function title(p, o, done) {
    var field = p.kind === 'movie' ? 'title' : 'name', own = o[field] || p.title;
    p.title = own;
    if (I18N.lang === 'en' || !own || own !== o['original_' + field] || o.original_language === I18N.base
        || o.original_language === 'en') { done(); return; }
    tmdb('/' + p.kind + '/' + p.id + '?language=en-US', function (err, en) {
      if (!err && en && en[field]) p.title = en[field];
      done();
    });
  }

  /** TMDB's Animation genre (movies and shows: cartoons and anime), left out with hide_animation=true. */
  var ANIMATION = 16;

  function animated(o) {
    for (var i = 0; o.genre_ids && i < o.genre_ids.length; i++) if (o.genre_ids[i] === ANIMATION) return true;
    return false;
  }

  function addPick(list, o, kind) {
    if (!o.backdrop_path) return;
    if (CONFIG.hideAnimation && animated(o)) return;
    list.push({id: o.id, kind: kind, title: kind === 'movie' ? o.title : o.name, backdrop: o.backdrop_path, meta: '', app: null, detailed: false});
  }

  function keyOf(p) { return p.kind + ':' + p.id; }

  function alternate(out, seen, a, b, max) {
    for (var i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) {
      if (i < a.length && !seen[keyOf(a[i])]) { seen[keyOf(a[i])] = true; out.push(a[i]); }
      if (i < b.length && out.length < max && !seen[keyOf(b[i])]) { seen[keyOf(b[i])] = true; out.push(b[i]); }
    }
  }

  /** Runs fn on each item one after the other (the TV's network is shared with what's playing). */
  function each(items, fn, done) {
    var i = 0;
    (function next() {
      if (i >= items.length) { done(); return; }
      fn(items[i++], next);
    })();
  }

  function fetchList(done) {
    tmdb('/watch/providers/movie?language=' + lang() + '&watch_region=' + REGION, function (err, res) {
      if (err) { done(err); return; }
      var ids = [];
      for (var i = 0; res.results && i < res.results.length; i++) {
        var s = service(res.results[i].provider_name, res.results[i].provider_id);
        if (s && appFor(s[1])) ids.push(res.results[i].provider_id);
      }
      if (!ids.length) { done(new Error("none of the TV's streaming apps are on TMDB")); return; }
      var common = '&language=' + lang() + '&watch_region=' + REGION + '&with_watch_monetization_types=flatrate&include_adult=false'
          + '&sort_by=popularity.desc&with_watch_providers=' + encodeURIComponent(ids.join('|'))
          + (CONFIG.hideAnimation ? '&without_genres=' + ANIMATION : '');
      var hot = {movie: [], tv: []}, fresh = {movie: [], tv: []};
      each(['movie', 'tv'], function (kind, next) {
        tmdb('/trending/' + kind + '/week?language=' + lang(), function (e, r) {
          var candidates = [];
          for (var j = 0; !e && j < r.results.length && j < 16; j++) addPick(candidates, r.results[j], kind);
          // Trending is only kept when it's on one of the TV's apps: the details say where.
          each(candidates, function (p, n) {
            details(p, function (de) { if (!de && p.app) hot[kind].push(p); n(); });
          }, next);
        });
      }, function () {
        tmdb('/discover/movie?vote_count.gte=30&primary_release_date.gte=' + day(-365) + '&primary_release_date.lte=' + day(0) + common, function (e1, r1) {
          for (var j = 0; !e1 && j < r1.results.length; j++) addPick(fresh.movie, r1.results[j], 'movie');
          tmdb('/discover/tv?vote_count.gte=20&air_date.gte=' + day(-90) + '&air_date.lte=' + day(0) + common, function (e2, r2) {
            for (var k = 0; !e2 && k < r2.results.length; k++) addPick(fresh.tv, r2.results[k], 'tv');
            var list = [], seen = {};
            alternate(list, seen, hot.movie, hot.tv, 24);
            alternate(list, seen, fresh.movie, fresh.tv, 24);
            if (!list.length) { done(new Error('TMDB returned no recommendations')); return; }
            picks = list;
            done(null);
          });
        });
      });
    });
  }

  /** Fetches the list when stale (6 h, a new period of the day, language, key or apps), then this hour's details. */
  function refreshRecs() {
    if (!KEY || fetchingRecs || !installed.length) return;
    var t = Date.now(), p = hourPeriod(new Date()), st = sourceStamp();
    if (st === stamp && failedAt && t - failedAt < 10 * 60000 && t >= failedAt) return;
    var stale = st !== stamp || p !== period || t - listAt > 6 * 3600000 || t < listAt || !picks.length || listLang !== I18N.lang;
    var wanted = all(), missing = false;
    for (var i = 0; i < wanted.length; i++) missing = missing || !wanted[i].detailed;
    if (!stale && !missing) return;
    fetchingRecs = true;
    stamp = st;
    function finish(err) {
      fetchingRecs = false;
      if (err) { recsError = err.message; failedAt = Date.now(); } else { recsError = ''; failedAt = 0; }
      saveRecs();
      changed();
    }
    function detailWanted() {
      var todo = all().filter(function (x) { return !x.detailed; });
      each(todo, function (x, next) { details(x, function () { next(); }); }, function () { finish(null); });
    }
    if (stale) {
      fetchList(function (err) {
        if (err) { finish(err); return; }
        listAt = Date.now();
        period = p;
        listLang = I18N.lang;
        detailWanted();
      });
    } else {
      detailWanted();
    }
  }

  /** This hour's picks for the three tabs, without repeats (the screensaver shows them too). */
  function all() {
    var out = [], seen = {}, kinds = [null, 'movie', 'tv'];
    for (var k = 0; k < kinds.length; k++) {
      var list = now(kinds[k]);
      for (var i = 0; i < list.length; i++) if (!seen[keyOf(list[i])]) { seen[keyOf(list[i])] = true; out.push(list[i]); }
    }
    return out;
  }

  // MARK: - Formatting

  function fmt(v, digits) {
    try { return v.toLocaleString(I18N.locale(), {minimumFractionDigits: digits, maximumFractionDigits: digits}); } catch (e) { return v.toFixed(digits); }
  }

  var SYMBOLS = {USD: '$', BRL: 'R$ ', EUR: '€', GBP: '£', JPY: '¥'};

  return {
    get pageTitle() { return pageTitle; },
    onRotate: function (fn) { rotateListeners.push(fn); },
    city: Place.city,
    currency: CURRENCY,
    onChange: function (fn) { listeners.push(fn); },
    setApps: function (apps) { installed = apps; },
    appFor: appFor,
    refresh: function () { refreshWeather(); refreshPrices(); refreshTeam(); refreshRecs(); },
    settingsChanged: function () { pricesAt = 0; refreshPrices(); changed(); },
    get weather() { return weather; },
    get weatherAt() { return weatherAt; },
    prices: prices,
    changes: changes,
    get pricesAt() { return pricesAt; },
    activeCoins: activeCoins,
    brRows: brRows,
    usRows: usRows,
    get team() { return team; },
    hasKey: function () { return !!KEY; },
    recsError: function () { return recsError; },
    picks: now,
    showcase: all,
    image: function (path, size) { return path ? 'https://image.tmdb.org/t/p/' + (size || 'w1280') + path : ''; },

    /** Night at the location: from sunset to sunrise (the last forecast; without one, 6:00 and 18:00). */
    isNight: function (at) {
      var theme = Prefs.theme();
      if (theme === 'dark') return true;
      if (theme === 'light') return false;
      var d = new Date(at), mins = d.getHours() * 60 + d.getMinutes();
      function hm(t, fallback) { if (!t) return fallback; var x = new Date(t); return x.getHours() * 60 + x.getMinutes(); }
      var rise = hm(weather && weather.sunrise, 360), set = hm(weather && weather.sunset, 1080);
      return mins < rise || mins >= set;
    },

    compact: function (v) {
      if (isNaN(v)) return '—';
      if (v >= 1000000) return fmt(v / 1000000, 2) + 'M';
      if (v >= 10000) return fmt(v / 1000, 1) + 'k';
      if (v >= 1000) return fmt(v / 1000, 2) + 'k';
      if (v >= 100) return fmt(v, 0);
      return fmt(v, 2);
    },
    money: function (v, i) {
      if (isNaN(v)) return i === 0 ? '—' : 'R$ —';
      if (i === 0) return fmt(v, 0);
      return 'R$ ' + fmt(v, 2);
    },
    change: function (v) { return isNaN(v) ? '' : (v >= 0 ? '+' : '−') + fmt(Math.abs(v), 1) + '%'; },
    degrees: function (v) {
      if (v === undefined || v === null || isNaN(v)) return '—';
      var unit = Prefs.temperature();
      var f = unit === 'F' || (unit === 'auto' && Place.fahrenheit);
      return Math.round(f ? v * 9 / 5 + 32 : v) + '°';
    },
    /** "3 PM", "15:00", "15 Uhr": the hourly forecast. */
    hour: function (at) { return formatDate('format|h a', at); },
    /** "5:21 AM", "05:21": the clock, sunrise and sunset. */
    time: function (at) { return formatDate('format|h:mm a', at); },
    /** "12 min ago" when the data is old (no internet), or empty. */
    staleness: function (at, every) {
      if (!at) return '';
      var age = Date.now() - at;
      if (age < every * 2) return '';
      var m = Math.floor(age / 60000), h = Math.floor(m / 60);
      return m < 60 ? trf('{n} min ago', {n: m}) : trf('{n} h ago', {n: h});
    },
    condition: function (code, day) {
      if (code === undefined || code === null || code < 0) return '';
      if (code === 0) return day ? tr('Clear') : tr('night|Clear');
      if (code === 1) return day ? tr('Mostly Sunny') : tr('Mostly Clear');
      if (code === 2) return tr('Partly Cloudy');
      if (code === 3) return tr('Cloudy');
      if (code === 45 || code === 48) return tr('Fog');
      if (code >= 51 && code <= 57) return tr('Drizzle');
      if (code === 65 || code === 67 || code === 82) return tr('Heavy Rain');
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) return tr('Snow');
      if (code >= 95) return tr('Thunderstorms');
      return tr('Rain');
    },
    symbol: function (code, day) {
      if (code <= 1) return day ? 'sunny' : 'clear_night';
      if (code === 2) return day ? 'partly_cloudy_day' : 'partly_cloudy_night';
      if (code === 3) return 'cloud';
      if (code === 45 || code === 48) return 'foggy';
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snowflake';
      if (code >= 95) return 'thunderstorm';
      return 'rainy';
    },
    coinName: function (i) { return NAMES[i]; },
    coinLabel: function (i) { return LABELS[i]; }
  };
})();
