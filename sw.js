// Cache app assets only. Database/auth requests never enter this cache.
const CACHE='lavanya-oms-v6.15.0-rc4';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const k of await caches.keys())if(k.startsWith('lavanya-oms-')&&k!==CACHE)await caches.delete(k);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/src/')||url.pathname.startsWith('/@'))return;
 if(req.mode!=='navigate'&&!/\.(js|css|png|jpg|jpeg|webp|svg|woff2?)$/.test(url.pathname))return;
 event.respondWith((async()=>{const cache=await caches.open(CACHE);try{const response=await fetch(req);if(response.ok)await cache.put(req.mode==='navigate'?'/index.html':req,response.clone());return response;}catch(e){const cached=await cache.match(req.mode==='navigate'?'/index.html':req);return cached||new Response('Offline: reconnect to load this resource.',{status:503});}})());
});
