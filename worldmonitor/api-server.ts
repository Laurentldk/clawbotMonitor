/**
 * Standalone API server for WorldMonitor handlers.
 * Runs via: tsx worldmonitor/api-server.ts
 *
 * Exposes all /api/{domain}/v1/* routes on PORT_API (default 3002).
 * This is an internal service — no CORS origin validation, no API-key check.
 * The Express proxy in server.js strips the Origin header before forwarding here.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mapErrorToResponse } from './server/error-mapper';
import { createRouter } from './server/router';

// ── Generated service route factories ────────────────────────────────────────
import { createSeismologyServiceRoutes } from './src/generated/server/worldmonitor/seismology/v1/service_server';
import { createWildfireServiceRoutes } from './src/generated/server/worldmonitor/wildfire/v1/service_server';
import { createClimateServiceRoutes } from './src/generated/server/worldmonitor/climate/v1/service_server';
import { createPredictionServiceRoutes } from './src/generated/server/worldmonitor/prediction/v1/service_server';
import { createDisplacementServiceRoutes } from './src/generated/server/worldmonitor/displacement/v1/service_server';
import { createAviationServiceRoutes } from './src/generated/server/worldmonitor/aviation/v1/service_server';
import { createResearchServiceRoutes } from './src/generated/server/worldmonitor/research/v1/service_server';
import { createUnrestServiceRoutes } from './src/generated/server/worldmonitor/unrest/v1/service_server';
import { createConflictServiceRoutes } from './src/generated/server/worldmonitor/conflict/v1/service_server';
import { createMaritimeServiceRoutes } from './src/generated/server/worldmonitor/maritime/v1/service_server';
import { createCyberServiceRoutes } from './src/generated/server/worldmonitor/cyber/v1/service_server';
import { createEconomicServiceRoutes } from './src/generated/server/worldmonitor/economic/v1/service_server';
import { createInfrastructureServiceRoutes } from './src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { createMarketServiceRoutes } from './src/generated/server/worldmonitor/market/v1/service_server';
import { createNewsServiceRoutes } from './src/generated/server/worldmonitor/news/v1/service_server';
import { createIntelligenceServiceRoutes } from './src/generated/server/worldmonitor/intelligence/v1/service_server';
import { createMilitaryServiceRoutes } from './src/generated/server/worldmonitor/military/v1/service_server';
import { createPositiveEventsServiceRoutes } from './src/generated/server/worldmonitor/positive_events/v1/service_server';
import { createGivingServiceRoutes } from './src/generated/server/worldmonitor/giving/v1/service_server';
import { createTradeServiceRoutes } from './src/generated/server/worldmonitor/trade/v1/service_server';
import { createSupplyChainServiceRoutes } from './src/generated/server/worldmonitor/supply_chain/v1/service_server';
import { createNaturalServiceRoutes } from './src/generated/server/worldmonitor/natural/v1/service_server';
import { createImageryServiceRoutes } from './src/generated/server/worldmonitor/imagery/v1/service_server';

// ── Handler implementations ───────────────────────────────────────────────────
import { seismologyHandler } from './server/worldmonitor/seismology/v1/handler';
import { wildfireHandler } from './server/worldmonitor/wildfire/v1/handler';
import { climateHandler } from './server/worldmonitor/climate/v1/handler';
import { predictionHandler } from './server/worldmonitor/prediction/v1/handler';
import { displacementHandler } from './server/worldmonitor/displacement/v1/handler';
import { aviationHandler } from './server/worldmonitor/aviation/v1/handler';
import { researchHandler } from './server/worldmonitor/research/v1/handler';
import { unrestHandler } from './server/worldmonitor/unrest/v1/handler';
import { conflictHandler } from './server/worldmonitor/conflict/v1/handler';
import { maritimeHandler } from './server/worldmonitor/maritime/v1/handler';
import { cyberHandler } from './server/worldmonitor/cyber/v1/handler';
import { economicHandler } from './server/worldmonitor/economic/v1/handler';
import { infrastructureHandler } from './server/worldmonitor/infrastructure/v1/handler';
import { marketHandler } from './server/worldmonitor/market/v1/handler';
import { newsHandler } from './server/worldmonitor/news/v1/handler';
import { intelligenceHandler } from './server/worldmonitor/intelligence/v1/handler';
import { militaryHandler } from './server/worldmonitor/military/v1/handler';
import { positiveEventsHandler } from './server/worldmonitor/positive-events/v1/handler';
import { givingHandler } from './server/worldmonitor/giving/v1/handler';
import { tradeHandler } from './server/worldmonitor/trade/v1/handler';
import { supplyChainHandler } from './server/worldmonitor/supply-chain/v1/handler';
import { naturalHandler } from './server/worldmonitor/natural/v1/handler';
import { imageryHandler } from './server/worldmonitor/imagery/v1/handler';

// ── Build router ──────────────────────────────────────────────────────────────
const serverOptions = { onError: mapErrorToResponse };

const allRoutes = [
  ...createSeismologyServiceRoutes(seismologyHandler, serverOptions),
  ...createWildfireServiceRoutes(wildfireHandler, serverOptions),
  ...createClimateServiceRoutes(climateHandler, serverOptions),
  ...createPredictionServiceRoutes(predictionHandler, serverOptions),
  ...createDisplacementServiceRoutes(displacementHandler, serverOptions),
  ...createAviationServiceRoutes(aviationHandler, serverOptions),
  ...createResearchServiceRoutes(researchHandler, serverOptions),
  ...createUnrestServiceRoutes(unrestHandler, serverOptions),
  ...createConflictServiceRoutes(conflictHandler, serverOptions),
  ...createMaritimeServiceRoutes(maritimeHandler, serverOptions),
  ...createCyberServiceRoutes(cyberHandler, serverOptions),
  ...createEconomicServiceRoutes(economicHandler, serverOptions),
  ...createInfrastructureServiceRoutes(infrastructureHandler, serverOptions),
  ...createMarketServiceRoutes(marketHandler, serverOptions),
  ...createNewsServiceRoutes(newsHandler, serverOptions),
  ...createIntelligenceServiceRoutes(intelligenceHandler, serverOptions),
  ...createMilitaryServiceRoutes(militaryHandler, serverOptions),
  ...createPositiveEventsServiceRoutes(positiveEventsHandler, serverOptions),
  ...createGivingServiceRoutes(givingHandler, serverOptions),
  ...createTradeServiceRoutes(tradeHandler, serverOptions),
  ...createSupplyChainServiceRoutes(supplyChainHandler, serverOptions),
  ...createNaturalServiceRoutes(naturalHandler, serverOptions),
  ...createImageryServiceRoutes(imageryHandler, serverOptions),
];

const router = createRouter(allRoutes);

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.API_SERVER_PORT ?? '3002', 10);

async function nodeRequestToWebRequest(req: IncomingMessage, body: Buffer): Promise<Request> {
  const host = req.headers['host'] ?? `localhost:${PORT}`;
  const url = `http://${host}${req.url ?? '/'}`;
  return new Request(url, {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(
      Object.entries(req.headers).flatMap(([k, v]) =>
        v == null ? [] : Array.isArray(v) ? v.map((val) => [k, val]) : [[k, v]],
      ),
    ) as Record<string, string>,
    body: body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Collect body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  try {
    const webReq = await nodeRequestToWebRequest(req, body);
    const handler = router.match(webReq);

    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const webRes = await handler(webReq);
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    const resBody = webRes.body ? Buffer.from(await webRes.arrayBuffer()) : Buffer.alloc(0);
    res.end(resBody);
  } catch (err) {
    console.error('[api-server] Unhandled error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`  🔌 WorldMonitor API server → http://127.0.0.1:${PORT}`);
});
