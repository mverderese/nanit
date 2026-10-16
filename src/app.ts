import express, { type Express } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadSettings, type Settings } from './config.js';
import { StatelessOAuthProvider, SCOPE, infoPage } from './oauth.js';
import { createMcpServer } from './mcp.js';

export function buildApp(settings: Settings): Express {
  const app = express();
  app.disable('x-powered-by');
  const provider = new StatelessOAuthProvider(settings);
  const issuerUrl = new URL(settings.baseUrl);
  const resourceServerUrl = new URL(settings.mcpUrl);

  app.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: [SCOPE],
    resourceName: 'Nanit',
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  app.use(provider.loginRouter());

  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  // Stateless: a fresh server + transport per request (serverless platforms don't keep either)
  app.post('/mcp', auth, express.json({ limit: '1mb' }), async (req, res) => {
    const server = createMcpServer(settings.defaultTimezone);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] error:', (err as Error).message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  app.get('/', (_req, res) => infoPage(res, settings));
  return app;
}

export const createApp = () => buildApp(loadSettings());
