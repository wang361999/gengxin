// Service Worker：网络优先策略，版本联动缓存清理
const CACHE_NAME = 'gitd-v14';
const STATIC_ASSETS = [
  '/style.css',
  '/dashboard.html',
  '/login.html',
  '/index.html',
  '/register.html',
  '/admin.html',
  '/legal.html',
  '/api-docs.html',
  '/manifest.json',
  '/error-tracker.js'
];

// 安装：跳过预缓存，立即激活（避免用旧资源填充缓存）
self.addEventListener('install', event => {
  self.skipWaiting();
});

// 激活：清理所有旧缓存，立即接管
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => {
      // 预缓存最新静态资源
      return caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}));
    })
  );
  self.clients.claim();
});

// 接收来自页面的消息（版本更新时强制清理缓存）
self.addEventListener('message', event => {
  if (event.data === 'CLEAR_CACHE') {
    caches.keys().then(keys => {
      keys.forEach(key => caches.delete(key));
    });
  }
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 请求拦截：分层缓存策略
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. API 请求：永不缓存
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ ok: false, error: '网络连接失败，请检查网络' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // 2. 静态资源（CSS, JS, 图片）：stale-while-revalidate 策略
  const isStaticAsset = url.pathname.match(/\.(css|js|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/i)
    || url.pathname === '/manifest.json';

  if (isStaticAsset) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(response => {
            if (response.ok && url.origin === self.location.origin) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => cached);
          // 返回缓存（如果有），否则等待网络
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // 3. 导航请求：网络优先，离线回退缓存
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then(cached => {
          return cached || caches.match('/index.html');
        });
      })
  );
});
