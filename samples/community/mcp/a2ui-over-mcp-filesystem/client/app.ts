/*
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A file browser with no agent, no A2UI server, and no code that knows
 * anything about files.
 *
 * The host below is the entire client. It connects to an MCP server, hands
 * `fs_browser_a2ui.json` to the renderer, and runs the call the payload names
 * as its first. Everything after that — which tool each control calls, and how
 * each response becomes data — is JSONata inside the payload.
 */

import {Context, basicCatalog} from '@a2ui/lit/v0_9';
import '@a2ui/lit/v0_9'; // Registers <a2ui-surface>.
import {renderMarkdown} from '@a2ui/markdown-it';
import {createCallMcpToolImplementation} from '@a2ui/mcp-catalog';
import {Catalog, DataContext, MessageProcessor, type A2uiMessage} from '@a2ui/web_core/v0_9';
import {provide} from '@lit/context';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';

import surfaceMessages from '../a2ui_filesystem.json';

/** The surface `fs_browser_a2ui.json` creates. */
export const SURFACE_ID = 'fs-browser';

/** Basic components and functions, plus `callMcpTool`. */
export const CATALOG_ID =
  'https://a2ui.org/specification/v0_9/catalogs/basic_with_mcp/catalog.json';

/** Endpoint Vite proxies to the MCP server. See `vite.config.ts`. */
export const MCP_ENDPOINT = '/mcp';

@customElement('a2ui-filesystem-app')
export class A2uiFilesystemApp extends LitElement {
  /** File contents arrive as fenced code, so the viewer needs Markdown. */
  @provide({context: Context.markdown})
  markdownRenderer = (value: string, options?: unknown) =>
    Promise.resolve(renderMarkdown(value, options as never));

  readonly processor: MessageProcessor<any>;

  /** The one connected server, which serves every tool the payload names. */
  private mcpClient?: Client;

  @state() private accessor error = '';

  constructor() {
    super();
    // `MessageProcessor` reads its catalog array lazily, so the processor can
    // exist before the catalog whose function reports back to it.
    const catalogs: Array<Catalog<any>> = [];
    this.processor = new MessageProcessor<any>(catalogs);
    catalogs.push(
      new Catalog<any>(CATALOG_ID, Array.from(basicCatalog.components.values()), [
        ...Array.from(basicCatalog.functions.values()),
        createCallMcpToolImplementation(() => this.mcpClient!, this.processor),
      ]),
    );

    this.processor.onSurfaceCreated(surface => {
      this.requestUpdate();
      surface.onError.subscribe(event => {
        this.error = event.message ?? String(event.code);
      });
    });
  }

  /** Returns the live surface, once the payload has been processed. */
  get surface() {
    return this.processor.model.getSurface(SURFACE_ID);
  }

  protected async firstUpdated() {
    try {
      this.mcpClient = new Client(
        {name: 'a2ui-filesystem-browser', version: '1.0.0'},
        {capabilities: {a2ui: {clientCapabilities: this.processor.getClientCapabilities()}} as any},
      );
      await this.mcpClient.connect(
        new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT, window.location.origin)),
      );

      this.processor.processMessages(surfaceMessages as unknown as A2uiMessage[]);

      // The payload declares the call that fills the first screen, the same
      // way its buttons declare theirs.
      const surface = this.surface!;
      const context = new DataContext(surface, '/');
      for (const call of surface.dataModel.get('/startup') ?? []) {
        await surface.catalog.invoker('callMcpTool', call, context);
      }
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  static styles = css`
    :host {
      display: block;
      padding: 24px;
    }

    .error {
      margin-bottom: 16px;
      padding: 12px 16px;
      border-radius: 8px;
      background: #fff1f0;
      border: 1px solid #f3aba4;
      color: #8b1a10;
      font-size: 14px;
    }
  `;

  render() {
    return html`
      ${this.error ? html`<p class="error">${this.error}</p>` : ''}
      ${this.surface ? html`<a2ui-surface .surface=${this.surface}></a2ui-surface>` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'a2ui-filesystem-app': A2uiFilesystemApp;
  }
}
