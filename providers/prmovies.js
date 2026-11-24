/**
 * prmovies - streams via vidsrc.sh (same embeds prmovies.style uses)
 * Chain: embed -> vs_src.php -> wrapper CFG -> player CONFIG -> metaApi (pool host)
 *        -> stream_urls (encrypted) -> WASM decrypt -> generate.php token -> /pli/ playlists
 * Generated: 2026-11-23
 */
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

var VIDSRC = "https://vidsrc.sh";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function log(msg) {
  console.log("[PRMovies] " + msg);
}
function err(msg) {
  console.error("[PRMovies] " + msg);
}

function get(url, referer, timeout) {
  return __async(this, null, function* () {
    timeout = timeout || 15e3;
    try {
      var sig = null;
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout)
        sig = AbortSignal.timeout(timeout);
      var headers = { "User-Agent": UA, "Accept": "*/*" };
      if (referer) headers["Referer"] = referer;
      return yield fetch(url, { headers, redirect: "follow", signal: sig });
    } catch (e) {
      err("fetch: " + url.substring(0, 80) + " -> " + (e.message || e.name));
      return null;
    }
  });
}
function getText(url, referer, timeout) {
  return __async(this, null, function* () {
    var r = yield get(url, referer, timeout);
    if (!r || !r.ok) {
      err("text: " + (r ? r.status : "null") + " for " + url.substring(0, 80));
      return null;
    }
    return yield r.text();
  });
}
function getJson(url, referer, timeout) {
  return __async(this, null, function* () {
    var t = yield getText(url, referer, timeout);
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      err("json: parse failed for " + url.substring(0, 80));
      return null;
    }
  });
}

// fetch the wasm decryptor; export names vary between instances — probe at runtime
function loadDecryptor(wasmUrl, w) {
  return __async(this, null, function* () {
    var r = yield get(wasmUrl, VIDSRC + "/");
    if (!r || !r.ok) return null;
    var bytes = new Uint8Array(yield r.arrayBuffer());
    var ex = (yield WebAssembly.instantiate(bytes, {})).instance.exports;
    // init: one of stat/hash/seed/sync with w, then always meta(w)
    var init = ex.stat || ex.hash || ex.seed || ex.sync;
    if (init) init(w);
    if (ex.meta) ex.meta(w);
    return ex;
  });
}

// decrypt ChaCha20-encrypted stream_urls: nonce||ciphertext, ~16-byte garbage prefix before URLs
function decryptStreamUrls(dec, cipherB64) {
  var cipher = Buffer.from(cipherB64, "base64");
  var ptr = dec.alloc(cipher.length);
  var mem = new Uint8Array(dec.memory.buffer);
  mem.set(cipher, ptr);
  var outLen = dec.decrypt(ptr, cipher.length, 0);
  var plain = Buffer.from(dec.memory.buffer.slice(ptr, ptr + outLen));
  var m = plain.toString("utf8").match(/https?:\/\/[^\s]+/g);
  return m || [];
}

function getVidsrcStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    var embedUrl = mediaType === "tv"
      ? VIDSRC + "/embed/tv?tmdb=" + tmdbId + "&season=" + season + "&episode=" + episode
      : VIDSRC + "/embed/movie?tmdb=" + tmdbId;
    // 1. embed page -> data-api path (HTML-escaped)
    var embedHtml = yield getText(embedUrl);
    if (!embedHtml) return [];
    var am = embedHtml.match(/data-api="([^"]+)"/);
    if (!am) {
      err("no data-api attr on embed page");
      return [];
    }
    var apiPath = am[1].replace(/&amp;/g, "&");
    // 2. vs_src.php -> {"src": "<player host>/embed/...?vs=<token>"}
    var srcData = yield getJson(VIDSRC + apiPath, embedUrl);
    if (!srcData || !srcData.src) {
      err("vs_src returned no src");
      return [];
    }
    var srcUrl = srcData.src;
    // 3. wrapper page -> window.CFG.playerUrl (JSON with \u0026 escapes — parse, don't regex)
    var wrapperHtml = yield getText(srcUrl, VIDSRC + "/");
    if (!wrapperHtml) return [];
    var cm = wrapperHtml.match(/window\.CFG\s*=\s*(\{[\s\S]*?\});/);
    if (!cm) {
      err("no window.CFG on wrapper");
      return [];
    }
    var cfg;
    try {
      cfg = JSON.parse(cm[1]);
    } catch (e) {
      err("CFG parse failed");
      return [];
    }
    var playerUrl = new URL(cfg.playerUrl, srcUrl).href;
    // 4. player page -> window.CONFIG (streamBase, apiToken)
    var playerHtml = yield getText(playerUrl, srcUrl);
    if (!playerHtml) return [];
    var pm2 = playerHtml.match(/window\.CONFIG\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!pm2) {
      err("no window.CONFIG on player page");
      return [];
    }
    var config;
    try {
      config = JSON.parse(pm2[1]);
    } catch (e) {
      err("CONFIG parse failed");
      return [];
    }
    if (!config.apiToken) {
      err("CONFIG missing apiToken");
      return [];
    }
    // movie players expose the api base as `api`, tv players as `streamBase`
    var streamBase = config.streamBase || config.api;
    // 5. metaApi -> data.stream_urls_api_host (pool host, changes per request)
    var meta = yield getJson(config.metaApi, playerUrl);
    var poolHost = meta && meta.data && meta.data.stream_urls_api_host;
    if (!poolHost) {
      err("no stream_urls_api_host");
      return [];
    }
    // 6. stream_urls (encrypted) — swap origin to pool host; apiToken is single-use, consumed here
    var streamApi = streamBase.replace(/^https?:\/\/[^\/]+/, "https://" + poolHost) + "&stream_urls&api_token=" + config.apiToken;
    var streamData = yield getJson(streamApi, playerUrl);
    var enc = streamData && streamData.data && streamData.data.stream_urls;
    var vs = streamData && streamData.vs;
    if (!enc || !vs || !vs.wasm_url) {
      err("no encrypted stream_urls");
      return [];
    }
    // 7. WASM decrypt
    var dec = yield loadDecryptor(vs.wasm_url, vs.w);
    if (!dec || !dec.alloc || !dec.decrypt) {
      err("wasm decryptor unavailable");
      return [];
    }
    var plUrls = decryptStreamUrls(dec, enc);
    if (plUrls.length === 0) {
      err("decrypt yielded no urls");
      return [];
    }
    // 8. generate.php -> raw JWT token (~4h, ip-bound)
    var plOrigin = new URL(plUrls[0]).origin;
    var tokenResp = yield get(plOrigin + "/generate.php?api_token=" + config.apiToken, playerUrl);
    if (!tokenResp || !tokenResp.ok) {
      err("generate.php failed: " + (tokenResp ? tokenResp.status : "null"));
      return [];
    }
    var token = (yield tokenResp.text()).trim();
    if (token.indexOf("eyJ") !== 0) {
      err("generate.php returned no JWT");
      return [];
    }
    // 9. /pli/ iOS variant playlists carry token-stamped segments — playable as-is
    var streams = [];
    for (var i = 0; i < plUrls.length; i++) {
      var pliUrl = plUrls[i].replace(/\/pl\//, "/pli/") + "?token=" + token;
      var label = plUrls.length > 1 ? "Server " + (i + 1) : "Vidsrc";
      streams.push({
        name: "PR | " + label,
        title: label,
        url: pliUrl,
        quality: "Auto",
        headers: { "Referer": playerUrl, "User-Agent": UA }
      });
    }
    return streams;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      log("request: id=" + tmdbId + " type=" + mediaType + " s=" + season + " e=" + episode);
      var streams = yield getVidsrcStreams(tmdbId, mediaType, season, episode);
      log("returning " + streams.length + " streams");
      return streams;
    } catch (e) {
      err("getStreams: " + e.message);
      return [];
    }
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
