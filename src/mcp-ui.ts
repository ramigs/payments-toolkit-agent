import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * The `ui-resource` payload this agent forwards to the frontend on an AG-UI
 * `CUSTOM` event. `@tanstack/ai`'s client reconciles an event of this shape
 * into a `ui-resource` message part (MCP Apps), correlated to the tool call
 * by `toolCallId` — see payments-toolkit-frontend's `McpAppView.vue`.
 */
export interface UiResourcePayload {
  resource: { uri: string; mimeType: string; text: string };
  toolName: string;
}

/**
 * Reads `_meta.ui.resourceUri` off a tool (the MCP Apps link between a tool
 * and its widget), tolerating both the nested form and the deprecated flat
 * `_meta["ui/resourceUri"]`. Inlined rather than pulling in
 * `@modelcontextprotocol/ext-apps` just for this one helper — that package
 * is browser-oriented (its entry drags in `window`).
 */
function getToolUiResourceUri(tool: {
  _meta?: Record<string, unknown>;
}): string | undefined {
  const meta = tool._meta ?? {};
  const nested = (meta.ui as { resourceUri?: unknown } | undefined)
    ?.resourceUri;
  const flat = meta['ui/resourceUri'];
  const uri =
    typeof nested === 'string'
      ? nested
      : typeof flat === 'string'
        ? flat
        : undefined;
  if (uri && !uri.startsWith('ui://')) return undefined;
  return uri;
}

/**
 * Owns a dedicated MCP client connection used only to resolve the `ui://`
 * widget resources that MCP Apps tools reference via `_meta.ui.resourceUri`.
 *
 * Kept separate from the ADK toolset's own MCP connection: that one is
 * driven by the model and doesn't surface tool `_meta` or expose
 * `resources/read` to us. This is a third short stdio child (alongside the
 * ADK toolset and the one-shot boot sanity check in `discoverMcpServer`),
 * held open for the life of the HTTP server.
 */
export class McpUiResources {
  private client: Client | undefined;
  private readonly uriByTool = new Map<string, string>();
  private readonly contentByUri = new Map<
    string,
    { mimeType: string; text: string }
  >();

  async connect(mcpServerPath: string): Promise<void> {
    const client = new Client({
      name: 'payments-toolkit-agent-mcp-ui',
      version: '0.1.0',
    });
    await client.connect(
      new StdioClientTransport({ command: 'node', args: [mcpServerPath] }),
    );
    this.client = client;

    const { tools } = await client.listTools();
    for (const tool of tools) {
      const uri = getToolUiResourceUri(tool);
      if (uri) this.uriByTool.set(tool.name, uri);
    }

    const summary = [...this.uriByTool]
      .map(([name, uri]) => `${name} -> ${uri}`)
      .join(', ');
    console.error(
      `[boot] MCP Apps UI resources: ${summary || '(none advertised)'}`,
    );
  }

  /**
   * The widget resource for a completed tool call, or `undefined` if that
   * tool advertises no UI. Resource bodies are cached — they're static for
   * the life of the server.
   */
  async forTool(toolName: string): Promise<UiResourcePayload | undefined> {
    const uri = this.uriByTool.get(toolName);
    if (!uri || !this.client) return undefined;

    let content = this.contentByUri.get(uri);
    if (!content) {
      const read = await this.client.readResource({ uri });
      const item = read.contents.find(
        (c): c is { uri: string; mimeType?: string; text: string } =>
          typeof (c as { text?: unknown }).text === 'string',
      );
      if (!item) {
        console.error(`[mcp-ui] resource ${uri} has no text content; skipping`);
        return undefined;
      }
      content = { mimeType: item.mimeType ?? 'text/html', text: item.text };
      this.contentByUri.set(uri, content);
    }

    return {
      resource: { uri, mimeType: content.mimeType, text: content.text },
      toolName,
    };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}
