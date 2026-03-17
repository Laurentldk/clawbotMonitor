/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: { url: string; revision: string | null }[];
};

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// ── Push notification handler ──────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload: {
    title?: string;
    body?: string;
    tag?: string;
    url?: string;
    urgent?: boolean;
  };

  try {
    payload = event.data.json() as typeof payload;
  } catch {
    payload = { title: 'WorldMonitor Alert', body: event.data.text() };
  }

  const options: NotificationOptions = {
    body: payload.body ?? '',
    icon: '/favico/android-chrome-192x192.png',
    badge: '/favico/favicon-32x32.png',
    tag: payload.tag ?? 'wm-alert',
    data: { url: payload.url ?? '/' },
    requireInteraction: payload.urgent ?? false,
  };

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'WorldMonitor Alert', options)
  );
});

// ── Notification click: focus existing tab or open new one ─────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl: string =
    (event.notification.data as { url?: string } | null)?.url ?? '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) return client.focus();
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
