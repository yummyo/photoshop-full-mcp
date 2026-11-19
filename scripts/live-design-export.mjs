import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

// Explicit invocation only: does not install, update MCP config or drive app UI.
const usage = `Validate a matching runtime/panel and export a design bundle.
Node >=20.19.0 required. The original PSD stays read-only.
  node scripts/live-design-export.mjs --runtime <absolute index.js> --export-root <absolute output root> --layers 9126,4951 [--mode isolated_composite] [--document-id 59] [--pixel-tolerance 1]
Load the matching panel and settle/stop an older runtime owner before switching.
The isolated_composite mode edits an owned temporary duplicate only.
`;
if (process.argv.includes('--help')) { process.stdout.write(usage); process.exit(0); }
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i], value = process.argv[i + 1];
  if (!['--runtime', '--export-root', '--layers', '--mode', '--document-id', '--pixel-tolerance'].includes(name) || value === undefined || args[name] !== undefined) throw new Error(usage);
  args[name] = value;
}
assert(isAbsolute(args['--runtime'] || '') && isAbsolute(args['--export-root'] || ''), usage);
const mode = args['--mode'] || 'isolated_composite';
assert(['layer_pixels', 'isolated_composite'].includes(mode), 'Unknown render mode');
const layerIds = (args['--layers'] || '').split(',').filter(Boolean).map(Number);
assert(layerIds.length > 0 && layerIds.length <= 32 && layerIds.every(id => Number.isSafeInteger(id) && id > 0) && new Set(layerIds).size === layerIds.length, 'Supply 1-32 unique positive layer IDs');
const documentId = args['--document-id'] === undefined ? undefined : Number(args['--document-id']);
assert(documentId === undefined || (Number.isSafeInteger(documentId) && documentId > 0), 'Invalid document ID');
const tolerance = Number(args['--pixel-tolerance'] || '1');
assert(Number.isInteger(tolerance) && tolerance >= 0 && tolerance <= 8, 'Invalid pixel tolerance');
const client = new Client({ name: 'photoshop-design-export-live-validation', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [args['--runtime']], env: { ...process.env, PS_MCP_DESIGN_EXPORT_DIR: args['--export-root'] }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4000); });
const call = async (name, input = {}) => {
  const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 600000, maxTotalTimeout: 610000 });
  const data = response.structuredContent || JSON.parse(response.content.find(item => item.type === 'text').text);
  if (response.isError) throw Object.assign(new Error(data.error?.message || data.summary || 'MCP request failed'), { code: data.error?.code, details: data.error?.details });
  return data;
};
try {
  await client.connect(transport);
  const definitions = (await client.listTools()).tools;
  const tool = definitions.find(tool => tool.name === 'photoshop_design_export');
  assert(tool?.inputSchema?.properties?.render_mode?.enum?.includes(mode), 'Runtime tool schema does not expose this rendering mode');
  const host = await call('photoshop_host_describe');
  assert.equal(host.bridge?.connected, true, 'Open the matching Photoshop Bridge panel first');
  assert.equal(host.runtime?.protocol, 'ps-mcp-bridge/4');
  assert(host.runtime?.designExport?.pixelModes?.includes(mode), 'Panel is an older build: reload the matching candidate before creating a temporary document');
  await call('photoshop_capability_list', { summary_only: true });
  const before = await call('photoshop_state_get');
  assert(before.activeDocument, 'An open PSD is required');
  const selectedDocumentId = documentId ?? before.activeDocument.id;
  process.stdout.write(JSON.stringify({ stage: 'preflight-passed', toolCount: definitions.length, appVersion: host.runtime.appVersion, documentId: selectedDocumentId, layerIds, renderMode: mode }) + '\n');
  const result = await call('photoshop_design_export', { document_id: selectedDocumentId, layer_ids: layerIds, render_mode: mode, pixel_tolerance: tolerance, include_reference: true, include_styles: true });
  const after = await call('photoshop_state_get');
  assert.deepEqual(after, before, 'Photoshop state changed across the export');
  process.stdout.write(JSON.stringify({ stage: 'export-complete', ...result, sourceStateUnchanged: true }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error.message, code: error.code, details: error.details, stderr, retry: 'Do not blindly repeat an unknown/pending export. Check its manifest and owned temporary document first.' }) + '\n');
  process.exitCode = 1;
} finally { await client.close(); }
