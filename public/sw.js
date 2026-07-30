// Service Worker：网络优先策略，版本联动缓存清理
const CACHE_NAME = 'gitupload-v3';
const STATIC_ASSETS = [
  '/style.css',
  '/dashboard.html',
  '/login.html',
  '/index.html',
  '/register.html',
  '/admin.html',
  '/manifest.json'
];

// 安装：预缓存静态资源，立即激活
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// 激活：清理所有旧缓存，立即接管
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
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

// 请求拦截：智能策略
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. API 请求：永不缓存，始终网络优先
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

  // 2. 导航请求（HTML 页面）：网络优先，离线回退
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then(cached => {
            return cached || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // 3. 静态资源（CSS/JS/图片）：缓存优先，后台更新
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // 后台更新缓存
        fetch(event.request).then(response => {
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, response.clone());
          });
        }).catch(() => {});
        return cached;
      }
      // 没有缓存，网络获取
      return fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, clone);
        });
        return response;
      }).catch(() => {
        return new Response('离线状态', { status: 503 });
      });
    })
  );
});
