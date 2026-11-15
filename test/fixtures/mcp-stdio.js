// A tiny local MCP server (stdio) standing in for "a local database": one read-only tool, one that changes things.
const fs = require('fs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const marker = process.argv[2];
const server = new McpServer({ name: 'test-db', version: '1.0.0' });
server.registerTool('query_db', { description: 'Run a read-only query against the sales database.', inputSchema: { sql: z.string() }, annotations: { readOnlyHint: true } },
  async ({ sql }) => ({ content: [{ type: 'text', text: `rows for <${sql}>: [{"customer":"ACME","total":1234}] env=${process.env.MEMO_FIXTURE_ENV || ''}` }] }));
server.registerTool('delete_row', { description: 'Delete a row from the sales database.', inputSchema: { id: z.number() } },
  async ({ id }) => { fs.appendFileSync(marker, `deleted ${id}\n`); return { content: [{ type: 'text', text: `row ${id} deleted` }] }; });
server.connect(new StdioServerTransport());
