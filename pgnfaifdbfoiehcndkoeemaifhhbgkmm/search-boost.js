/*
 * search-boost.js — runs in the PAGE world on the LazyApply dashboard.
 *
 * The dashboard's job search pages through
 *   POST https://backend.lazyapply.com/lazyapplyv2/job-search-v3
 * (10 results per batch) and stops as soon as a batch comes back empty with
 * pagination.has_more_pages false. With a narrow "Date Posted" (e.g. past 24
 * hours) that happens after a handful of jobs, so a "Target 100 jobs" search
 * can end at 7.
 *
 * This keeps the search going until the dashboard's target is reached:
 *   1. includeWorkdayIcimsJobs is turned on (the extension applies on every
 *      Workday tenant and on iCIMS).
 *   2. When the current Date Posted window runs dry, the same request is
 *      retried with the next wider window — past 24 hours → past week →
 *      past month → past year — starting again from its first page. The
 *      dashboard already drops duplicate links, so the count keeps rising.
 * The dashboard's own batch numbers are mapped onto each window's pages
 * (state per searchSessionId), so nothing else about the search changes.
 */
(function () {
  'use strict';
  if (window.__lazyapplySearchBoost) return;
  window.__lazyapplySearchBoost = true;

  var ENDPOINT = '/lazyapplyv2/job-search-v3';
  var WINDOWS = ['qdr:d', 'qdr:w', 'qdr:m', 'qdr:y'];
  var sessions = {};   // searchSessionId -> { tier, pageOffset, first }

  function isSearch(url) {
    return String(url || '').toLowerCase().indexOf(ENDPOINT) !== -1;
  }

  /* Index into WINDOWS for the user's choice; -1 means "Anytime" (or a custom
     filter) — already as wide as it gets, so no widening. */
  function startTier(timeFilter) {
    if (timeFilter == null || timeFilter === '') return 0;
    return WINDOWS.indexOf(String(timeFilter));
  }

  async function runSearch(url, body, headers) {
    var sid = String(body.searchSessionId || 'default');
    var st = sessions[sid];
    var dashboardPage = Number(body.page) || 0;
    /* first = the dashboard's first batch number, so a wider window restarts there */
    if (!st) st = sessions[sid] = { tier: startTier(body.timeFilter), pageOffset: 0, first: firstPage(body) };
    var res, json;
    for (;;) {
      var payload = Object.assign({}, body, { includeWorkdayIcimsJobs: true });
      if (st.tier >= 0) {
        payload.timeFilter = WINDOWS[st.tier];
        payload.page = dashboardPage - st.pageOffset;
      }
      res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload), credentials: 'include' });
      var text = await res.text();
      try { json = JSON.parse(text); } catch (_) { return { res: res, text: text }; }
      var jobs = (json && json.jobs) || [];
      var more = !!(json && json.pagination && json.pagination.has_more_pages);
      var canWiden = res.ok && st.tier >= 0 && st.tier < WINDOWS.length - 1;
      if (jobs.length || more || !canWiden) return { res: res, text: text };
      /* This window is exhausted: continue with the next wider one, from
         its first page, on this same dashboard batch. */
      st.tier++;
      st.pageOffset = dashboardPage - st.first;
      try { console.info('[LazyApply search] widened Date Posted to ' + WINDOWS[st.tier] + ' at batch ' + dashboardPage); } catch (_) {}
    }
  }

  /* The backend's first page number, as the dashboard numbers its batches. */
  function firstPage(body) {
    return body && body.page === 0 ? 0 : 1;
  }

  /* Hand a finished response to an XMLHttpRequest the page is waiting on. */
  function deliver(xhr, status, statusText, text, headersText, responseURL) {
    var props = {
      readyState: 4, status: status, statusText: statusText || '',
      responseText: text, response: xhr.responseType === 'json' ? safeJson(text) : text,
      responseURL: responseURL || ''
    };
    Object.keys(props).forEach(function (k) {
      try { Object.defineProperty(xhr, k, { configurable: true, get: function () { return props[k]; } }); } catch (_) {}
    });
    xhr.getAllResponseHeaders = function () { return headersText; };
    xhr.getResponseHeader = function (name) {
      var m = new RegExp('^' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.*)$', 'im').exec(headersText);
      return m ? m[1].trim() : null;
    };
    ['readystatechange', 'load', 'loadend'].forEach(function (type) {
      try { xhr.dispatchEvent(new ProgressEvent(type)); } catch (_) {}
    });
  }
  function safeJson(t) { try { return JSON.parse(t); } catch (_) { return null; } }

  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  var setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lzUrl = url;
    this.__lzMethod = String(method || '').toUpperCase();
    this.__lzHeaders = {};
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__lzHeaders) this.__lzHeaders[name] = value;
    return setHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this, parsed = null;
    if (xhr.__lzMethod === 'POST' && isSearch(xhr.__lzUrl) && typeof body === 'string') {
      try { parsed = JSON.parse(body); } catch (_) {}
    }
    if (!parsed) return send.apply(this, arguments);

    var aborted = false;
    var origAbort = xhr.abort;
    xhr.abort = function () {
      aborted = true;
      try { xhr.dispatchEvent(new ProgressEvent('abort')); } catch (_) {}
      try { xhr.dispatchEvent(new ProgressEvent('loadend')); } catch (_) {}
      return origAbort && origAbort.apply(xhr, arguments);
    };
    runSearch(new URL(xhr.__lzUrl, location.href).href, parsed, xhr.__lzHeaders).then(function (out) {
      if (aborted) return;
      var headersText = '';
      try { out.res.headers.forEach(function (v, k) { headersText += k + ': ' + v + '\r\n'; }); } catch (_) {}
      deliver(xhr, out.res.status, out.res.statusText, out.text, headersText, out.res.url);
    }, function () {
      if (aborted) return;
      /* Network trouble in our path: fall back to the page's own request. */
      send.call(xhr, body);
    });
  };
})();
