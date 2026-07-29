const CACHE_NAME = 'gitupload-v1';
const STATIC_ASSETS = [
  '/style.css',
  '/dashboard.html',
  '/login.html',
  '/index.html',
  '/manifest.json'
];

// 安装：预缓存静态资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
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

// 请求拦截：网络优先，离线回退缓存
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API 请求：网络优先，离线时从缓存读取（仅限历史记录）
  if (url.pathname.startsWith('/api/history')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // 成功获取后缓存响应克隆
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(() => {
          // 离线时尝试从缓存读取
          return caches.match(event.request).then(cached => {
            return cached || new Response(JSON.stringify({ error: '离线状态，无法加载' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          });
        })
    );
    return;
  }

  // 静态资源和其他页面：网络优先，离线回退缓存
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // 成功获取后缓存
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, clone);
        });
        return response;
      })
      .catch(() => {
        // 离线时从缓存读取
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // 如果是导航请求，回退到 index.html
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('离线状态', { status: 503 });
        });
      })
  );
});
