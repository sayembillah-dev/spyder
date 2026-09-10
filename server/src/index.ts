import { createApp } from './app';
import { config } from './config';
import { flush as flushRegistry } from './discovery/registry';
import { startScheduler } from './discovery/scheduler';

if (config.allowPrivateTargets) {
  console.warn('⚠️  ALLOW_PRIVATE_TARGETS=true — SSRF guard disabled. Dev only, never deploy this.');
}
if (config.discovery.allowCrossSite) {
  console.warn(
    '⚠️  DISCOVERY_ALLOW_CROSS_SITE=true — discovery may follow links OUTSIDE the input domain. Dev only, never deploy this.',
  );
}

const server = createApp().listen(config.port, () =>
  console.log(`⚡ flash-deal api ready → http://localhost:${config.port}`),
);

/** D10: the autonomous refresh loop — OFF unless AUTO_REFRESH=true. Never
 *  in the request path; just a timer and the shared verify path. */
const scheduler = config.discovery.autoRefresh
  ? startScheduler({ onEvent: (m) => console.log(`[scheduler] ${m}`) })
  : null;
if (scheduler) {
  console.log(
    `🔁 AUTO_REFRESH=true — saved-list refresh every ${Math.round(
      config.discovery.refreshTickMs / 60_000,
    )}min, ≤${config.discovery.refreshPerTick} pages/tick`,
  );
}

/** Shutdown ordering matters: the scheduler stops FIRST (mid-tick unwind,
 *  no half-written checks), THEN debounced registry writes land. The
 *  atomic tmp→rename write itself already makes a mid-write kill safe. */
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void (async () => {
      await scheduler?.stop();
      flushRegistry();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2_000).unref();
    })();
  });
}
