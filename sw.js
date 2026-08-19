// Minimal service worker — exists mainly so this site qualifies as an
// installable PWA (required for Trusted Web Activity / "Add to Home
// Screen" to work properly). Doesn't cache anything aggressively since
// this bot needs live data every time it loads.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // pass-through — always hit the network
