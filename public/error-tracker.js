/**
 * 轻量级前端错误监控脚本 error-tracker.js
 * - 捕获 window.onerror 事件
 * - 捕获 unhandledrejection 事件
 * - 包装 fetch() 检测 API 错误（4xx/5xx）和网络失败
 * - 包装 XMLHttpRequest 检测错误
 * - 使用 sendBeacon 上报（回退到 fetch）
 * - 缓冲错误并批量上报（每批最多 10 条，每 5 秒刷新一次）
 * - 排除错误上报端点自身
 * - 截断 stack trace 到 2000 字符
 * - 尊重 prefers-reduced-motion
 * - 无需鉴权
 */
(function () {
  'use strict';

  if (window.__errorTrackerInstalled) return;
  window.__errorTrackerInstalled = true;

  // 错误上报端点（相对路径，排除自身监控）
  var ENDPOINT = '/api/errors';
  // 用于匹配排除规则的路径片段
  var EXCLUDE_PATTERN = /\/api\/errors(\?|$)/;

  // 批量缓冲配置
  var MAX_BATCH = 10;            // 每批最多 10 条
  var FLUSH_INTERVAL = 5000;     // 每 5 秒刷新一次缓冲
  var MAX_STACK_LENGTH = 2000;   // stack trace 截断长度

  var buffer = [];
  var flushTimer = null;

  // 尊重 prefers-reduced-motion：减少不必要的高频定时刷新
  var prefersReducedMotion = false;
  try {
    prefersReducedMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  // 尝试读取当前用户 ID（不强制）
  function getUserId() {
    try {
      return localStorage.getItem('user_id') ||
             localStorage.getItem('userId') || '';
    } catch (e) { return ''; }
  }

  function safeString(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return String(v); } catch (e) { return ''; }
  }

  function truncateStack(stack) {
    var s = safeString(stack);
    if (s.length > MAX_STACK_LENGTH) {
      return s.slice(0, MAX_STACK_LENGTH) + '...[truncated]';
    }
    return s;
  }

  function isExcludedUrl(url) {
    if (!url) return false;
    try {
      var u = safeString(url);
      return EXCLUDE_PATTERN.test(u);
    } catch (e) { return false; }
  }

  // 把错误对象标准化为上报数据
  function normalize(errorData) {
    var data = errorData || {};
    return {
      error_type: safeString(data.error_type || data.errorType || 'unknown'),
      error_message: safeString(data.error_message || data.errorMessage || data.message || ''),
      stack_trace: truncateStack(data.stack_trace || data.stackTrace || data.stack || ''),
      page_url: safeString(data.page_url || data.pageUrl || window.location.href),
      source_url: safeString(data.source_url || data.sourceUrl || ''),
      line_number: data.line_number != null ? data.line_number : (data.lineNumber != null ? data.lineNumber : null),
      column_number: data.column_number != null ? data.column_number : (data.columnNumber != null ? data.columnNumber : null),
      user_agent: safeString(data.user_agent || data.userAgent || navigator.userAgent),
      user_id: safeString(data.user_id || data.userId || getUserId()),
      status_code: data.status_code != null ? data.status_code : (data.statusCode != null ? data.statusCode : null),
      request_url: safeString(data.request_url || data.requestUrl || ''),
      request_method: safeString(data.request_method || data.requestMethod || '')
    };
  }

  function push(errorData) {
    try {
      var normalized = normalize(errorData);
      // 跳过空白错误
      if (!normalized.error_message && !normalized.stack_trace && normalized.error_type === 'unknown') {
        return;
      }
      buffer.push(normalized);
      // 达到单批上限立即刷新
      if (buffer.length >= MAX_BATCH) {
        flush();
      }
    } catch (e) {}
  }

  function flush() {
    if (buffer.length === 0) return;
    var batch = buffer.splice(0, MAX_BATCH);
    send(batch);
  }

  function send(batch) {
    var payload;
    try {
      payload = JSON.stringify(batch);
    } catch (e) { return; }

    try {
      // 优先使用 sendBeacon（页面卸载时也能可靠发送）
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        var ok = navigator.sendBeacon(ENDPOINT, blob);
        if (ok) return;
      }
    } catch (e) {}

    // 回退到 fetch（keepalive 以便卸载时也能发出）
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
        credentials: 'same-origin'
      }).catch(function () {});
    } catch (e) {}
  }

  function startFlushTimer() {
    if (flushTimer) return;
    // 尊重 prefers-reduced-motion：降低刷新频率以减少后台活动
    var interval = prefersReducedMotion ? FLUSH_INTERVAL * 2 : FLUSH_INTERVAL;
    flushTimer = setInterval(flush, interval);
  }

  // ===== 1. 捕获 window.onerror =====
  window.addEventListener('error', function (event) {
    try {
      // 排除错误上报端点自身引发的错误
      if (isExcludedUrl(event.filename) || isExcludedUrl(event.target && event.target.src)) {
        return;
      }
      push({
        error_type: 'JavaScript Error',
        error_message: safeString(event.message),
        stack_trace: event.error && event.error.stack ? event.error.stack : '',
        source_url: event.filename || '',
        line_number: event.lineno,
        column_number: event.colno
      });
    } catch (e) {}
  }, true);

  // ===== 2. 捕获 unhandledrejection =====
  window.addEventListener('unhandledrejection', function (event) {
    try {
      var reason = event.reason;
      var message = '';
      var stack = '';
      if (reason instanceof Error) {
        message = reason.message;
        stack = reason.stack || '';
      } else if (typeof reason === 'string') {
        message = reason;
      } else {
        try { message = JSON.stringify(reason); } catch (e) { message = safeString(reason); }
      }
      push({
        error_type: 'Unhandled Promise Rejection',
        error_message: message,
        stack_trace: stack
      });
    } catch (e) {}
  });

  // ===== 3. 包装 fetch() =====
  if (window.fetch) {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = '';
      var method = 'GET';
      try {
        if (typeof input === 'string') {
          url = input;
        } else if (input && input.url) {
          url = input.url;
          method = (input.method || 'GET').toUpperCase();
        }
        if (init && init.method) method = safeString(init.method).toUpperCase();
      } catch (e) {}

      // 排除错误上报端点
      if (isExcludedUrl(url)) {
        return originalFetch.apply(this, arguments);
      }

      return originalFetch.apply(this, arguments).then(
        function (response) {
          try {
            var status = response.status;
            if (status >= 400) {
              push({
                error_type: 'API Error',
                error_message: 'Fetch failed: HTTP ' + status,
                status_code: status,
                request_url: url,
                request_method: method
              });
            }
          } catch (e) {}
          return response;
        },
        function (err) {
          // 网络失败
          try {
            push({
              error_type: 'API Error',
              error_message: 'Fetch network error: ' + (err && err.message ? err.message : 'network'),
              status_code: 0,
              request_url: url,
              request_method: method,
              stack_trace: err && err.stack ? err.stack : ''
            });
          } catch (e) {}
          throw err;
        }
      );
    };
  }

  // ===== 4. 包装 XMLHttpRequest =====
  if (window.XMLHttpRequest) {
    var OriginalXHR = window.XMLHttpRequest;
    var xhrOpen = OriginalXHR.prototype.open;
    var xhrSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url) {
      try {
        this.__et_url = safeString(url);
        this.__et_method = safeString(method).toUpperCase();
      } catch (e) {}
      return xhrOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function () {
      var self = this;
      var url = self.__et_url || '';
      var method = self.__et_method || 'GET';

      // 排除错误上报端点
      if (isExcludedUrl(url)) {
        return xhrSend.apply(this, arguments);
      }

      var origOnerror = self.onerror;
      self.addEventListener('error', function () {
        try {
          push({
            error_type: 'API Error',
            error_message: 'XHR network error',
            status_code: 0,
            request_url: url,
            request_method: method
          });
        } catch (e) {}
      });

      self.addEventListener('loadend', function () {
        try {
          var status = self.status;
          if (status >= 400) {
            push({
              error_type: 'API Error',
              error_message: 'XHR failed: HTTP ' + status,
              status_code: status,
              request_url: url,
              request_method: method
            });
          }
        } catch (e) {}
      });

      return xhrSend.apply(this, arguments);
    };
  }

  // ===== 启动定时刷新 + 页面卸载时刷新 =====
  startFlushTimer();

  // 页面隐藏/卸载时尽力发送剩余缓冲
  if (document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        flush();
      }
    });
  }
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);

  // 暴露手动 API（可选）
  window.ErrorTracker = {
    push: push,
    flush: flush
  };
})();
