#!/usr/bin/env node
/**
 * stdio ⇄ Streamable HTTP proxy, for MCP clients that only speak stdio.
 * Env: TELEOPS_MCP_URL (default http://127.0.0.1:8811/mcp), TELEOPS_API_KEY (tok_… API key), TELEOPS_LANG (en|it, default: OS language).
 * It never talks to Telegram itself: the server is the only reader of each bot's updates.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { VERSION } from './config.js'
import { osLang } from './i18n.js'

const url = process.env.TELEOPS_MCP_URL || 'http://127.0.0.1:8811/mcp'
const key = process.env.TELEOPS_API_KEY || ''

async function main() {
  const client = new Client({ name: 'teleops-stdio', version: VERSION })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'Accept-Language': osLang(), ...(key ? { Authorization: `Bearer ${key}` } : {}) } } }))
  const info = client.getServerVersion()
  const server = new Server(
    { name: info?.name ?? 'teleops', title: 'TeleOps', version: info?.version ?? VERSION },
    { capabilities: { tools: {} }, instructions: client.getInstructions() },
  )
  server.setRequestHandler(ListToolsRequestSchema, async (req) => client.listTools(req.params))
  server.setRequestHandler(CallToolRequestSchema, async (req) => client.callTool(req.params))
  await server.connect(new StdioServerTransport())
}

main().catch((e) => {
  process.stderr.write(`teleops-stdio: ${String(e?.message ?? e)}\n`)
  process.exit(1)
})
