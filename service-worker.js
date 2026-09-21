// Deliberately minimal. A "real" service worker usually caches assets and
// serves them offline — but Cred's entire value is live, current
// credentialing status. A cached "✓ Verified" badge or a stale expiration
// date shown while offline would look identical to a real one and could
// genuinely mislead someone into thinking a license is current when the
// cached page just hasn't heard about a change yet. That's worse than the
// page simply failing to load without a connection.
//
// This file exists purely to satisfy the browser's installability
// requirement (Chrome and other browsers require a registered service
// worker with a fetch handler before offering "Install" at all) — it does
// not cache anything and does not intercept requests in any way that
// changes their result. Every request just passes straight through to
// the network, exactly as if this file didn't exist.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through only — no caching, no offline fallback, no interception
  // of the actual response. This handler exists only because its mere
  // presence is one of the installability checks; what it does with each
  // request is nothing at all.
  event.respondWith(fetch(event.request));
});
