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
 * `callMcpTool`: the A2UI catalog function that calls a Model Context Protocol
 * tool and renders the A2UI messages the tool returns.
 *
 * ## Wiring
 *
 * ```ts
 * const catalogs: Catalog<any>[] = [];
 * const processor = new MessageProcessor(catalogs);
 * const callMcpTool = createCallMcpToolImplementation(getMcpClientForTool, processor);
 * catalogs.push(new Catalog(MCP_CATALOG_ID, [], [callMcpTool]));
 * ```
 *
 * The host supplies one hook, `getMcpClientForTool`. This module calls the
 * tool, reads any UI resource, and decodes the messages.
 *
 * ## MCP responses
 *
 * This module handles multiple MCP responses to render A2UI.
 *
 * ### 1. A UI resource the tool declares
 *
 * A descriptor in `tools/list` names the resource holding the layout that
 * every call of that tool renders:
 *
 * ```json
 * {
 *   "name": "get_recipe",
 *   "description": "Fetch a recipe",
 *   "_meta": {"ui": {"resourceUri": "a2ui://recipe-card"}}
 * }
 * ```
 *
 * This module reads the resourceUri through `resources/read` and decodes every
 * `application/a2ui+json` block of the response into messages:
 *
 * ```json
 * {
 *   "result": {
 *     "contents": [
 *       {
 *         "uri": "a2ui://path/to/resource",
 *         "mimeType": "application/a2ui+json",
 *         "text": "[{\"version\": \"v0.9\", \"updateDataModel\": {\"key\": \"value\"}}]"
 *       }
 *     ]
 *   }
 * }
 * ```
 *
 * Discovery runs once per client. Resource contents are static, so messages
 * are cached by URI, and a resource that would recreate a live surface is
 * skipped rather than processed twice.
 *
 * ### 2. A UI resource the result names
 *
 * The same `_meta.ui.resourceUri` field can be used on the tool result itself:
 *
 * ```json
 * {
 *   "content": [{"type": "text", "text": "Generated a Baked Salmon recipe."}],
 *   "_meta": {"ui": {"resourceUri": "a2ui://recipe-card"}}
 * }
 * ```
 *
 * URIs on the result replace the declared ones rather than adding to them.
 *
 * ### 3. A2UI resources inline in the result content
 *
 * An embedded resource block declaring mime type `application/a2ui+json`:
 *
 * ```json
 * {
 *   "content": [
 *     {"type": "text", "text": "Generated a Baked Salmon recipe."},
 *     {
 *       "type": "resource",
 *       "resource": {
 *         "uri": "a2ui://recipe-card/data",
 *         "mimeType": "application/a2ui+json",
 *         "text": "[{\"version\": \"v0.9\", \"updateDataModel\": {…}}]"
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * ### 4. Plain tool data
 *
 * ```json
 * {"content": [{"type": "text", "text": "Prep time is 15 minutes."}]}
 * ```
 *
 * No resource URI and no A2UI block, so nothing renders on its own. A payload
 * can still bring such a server to the screen with `dataModelUpdateJsonata`,
 * described below.
 *
 * ## JSONata
 *
 * A server that knows nothing about A2UI answers in its own shape. One
 * optional expression lets the payload translate that shape itself, with no
 * client code:
 *
 * ```json
 * {
 *   "call": "callMcpTool",
 *   "args": {
 *     "name": "list_directory",
 *     "arguments": {"path": {"path": "/current_path"}},
 *     "dataModelUpdateJsonata": "{'/entries': $split(content[0].text, '\\n')}"
 *   }
 * }
 * ```
 *
 * `dataModelUpdateJsonata` reads the MCP result and produces an object of data
 * model paths, each applied to the calling surface as an `updateDataModel`
 * message once the call completes. `$args` and `$root` carry the arguments the
 * tool ran with and the whole data model.
 *
 * ## Failures
 *
 * Every failure raises an `A2uiExpressionError` naming the tool: no client for
 * the tool, a transport error, a result flagged `isError`, a payload that
 * declares the A2UI MIME type but holds invalid JSON, or an expression that
 * does not compile, evaluate, or produce an object. A resource that holds no
 * A2UI at all is not a failure: it contributes nothing and the call proceeds.
 */

import {
  createFunctionImplementation,
  type DataContext,
  type FunctionImplementation,
  type MessageProcessor,
  A2uiExpressionError,
} from '@a2ui/web_core/v0_9';
import type {A2uiMessage, CreateSurfaceMessage} from '@a2ui/web_core/v0_9';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import type {CallToolResult, ReadResourceResult} from '@modelcontextprotocol/sdk/types.js';
import jsonata, {type Expression} from 'jsonata';
import {resolveDynamicRecord} from '../dynamic-values.js';
import {CallMcpToolApi} from './callMcpToolApi.js';

export {CallMcpToolApi};

/**
 * MIME type identifying an A2UI payload.
 */
export const A2UI_MIME_TYPE = 'application/a2ui+json';

/**
 * The slice of the MCP `Client` this catalog uses.
 */
export type McpToolClient = Pick<Client, 'request' | 'readResource' | 'listTools'>;

/**
 * Resolves the connected MCP client that serves a named tool.
 */
export type McpClientResolver = (toolName: string) => McpToolClient | Promise<McpToolClient>;

/**
 * Creates the `callMcpTool` function implementation.
 *
 * @param getMcpClientForTool Supplies the client to call a given tool on.
 * @param processor Receives the A2UI messages decoded from tool results.
 */
export function createCallMcpToolImplementation(
  getMcpClientForTool: McpClientResolver,
  processor: MessageProcessor<any>,
): FunctionImplementation {
  /** Messages already decoded, keyed by resource URI. A resource never changes. */
  const a2uiMessagesByResourceUri = new Map<string, A2uiMessage[]>();

  /** Declared URIs by tool name, discovered once per client. */
  const declaredUiResourceUris = new WeakMap<McpToolClient, Promise<Map<string, string[]>>>();

  async function readA2uiResource(client: McpToolClient, uri: string): Promise<A2uiMessage[]> {
    let messages = a2uiMessagesByResourceUri.get(uri);
    if (!messages) {
      messages = parseA2uiMessages(await client.readResource({uri}), uri);
      a2uiMessagesByResourceUri.set(uri, messages);
    }
    return messages;
  }

  /**
   * Returns the UI resource URIs each tool declares, reading `tools/list` once
   * per client.
   */
  function getDeclaredUiResourceUris(client: McpToolClient): Promise<Map<string, string[]>> {
    const cached = declaredUiResourceUris.get(client);
    if (cached) {
      return cached;
    }

    const discovery = (async () => {
      const uris = new Map<string, string[]>();
      try {
        const {tools} = await client.listTools();
        for (const tool of tools ?? []) {
          const declared = readUiResourceUris(tool);
          if (declared.length > 0) {
            uris.set(tool.name, declared);
          }
        }
      } catch (err) {
        console.warn('Could not query MCP tool UI resources:', err);
      }
      return uris;
    })();
    declaredUiResourceUris.set(client, discovery);
    return discovery;
  }

  return createFunctionImplementation(CallMcpToolApi, async (args, context) => {
    const toolName = context.resolveDynamicValue<string>(args.name);
    const updateJsonata =
      args.dataModelUpdateJsonata === undefined
        ? undefined
        : context.resolveDynamicValue<string>(args.dataModelUpdateJsonata as never);

    try {
      const resolvedArguments = resolveDynamicRecord(args.arguments ?? {}, context);

      const client = await getMcpClientForTool(toolName);
      const result: CallToolResult = await client.request(
        {method: 'tools/call', params: {name: toolName, arguments: resolvedArguments}},
        CallToolResultSchema,
        // Progress notifications reset the request timeout, so a server can
        // hold a slow or interactive tool call open past the default.
        {onprogress: () => {}, resetTimeoutOnProgress: true},
      );

      if (!result) {
        throw new Error(`MCP tool '${toolName}' did not return a result.`);
      }
      if (result.isError) {
        throw new Error(`MCP tool '${toolName}' execution failed: ${JSON.stringify(result)}`);
      }

      // The URIs the result names, falling back to the ones the tool declares.
      const named = readUiResourceUris(result);
      const uris =
        named.length > 0 ? named : ((await getDeclaredUiResourceUris(client)).get(toolName) ?? []);
      for (const uri of uris) {
        const resourceMessages = await readA2uiResource(client, uri);
        // Creating a surface twice throws A2uiStateError. On a repeat call,
        // keep the existing surface and apply only the inline messages below.
        if (!createsExistingSurface(resourceMessages, processor)) {
          processor.processMessages(resourceMessages);
        }
      }

      const messages = extractA2uiMessages(result.content);
      if (messages.length > 0) {
        processor.processMessages(messages);
      }

      // Updates the payload derived from the result itself, applied last so a
      // payload can restate anything the server sent inline.
      const updates = await buildJsonataUpdates(
        updateJsonata,
        toolName,
        resolvedArguments,
        result,
        context,
      );
      if (updates.length > 0) {
        processor.processMessages(updates);
      }

      return result;
    } catch (error: unknown) {
      if (error instanceof A2uiExpressionError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new A2uiExpressionError(
        `Failed to execute MCP tool '${toolName}': ${message}`,
        'callMcpTool',
        error,
      );
    }
  });
}

/**
 * Compiled JSONata expressions, keyed by source.
 *
 * A payload runs the same expression on every click, and compiling is the
 * expensive half of JSONata.
 */
const compiledExpressions = new Map<string, Expression>();

/**
 * Evaluates `dataModelUpdateJsonata` and returns the `updateDataModel`
 * messages it describes.
 *
 * The expression reads the MCP result itself, so `content[0].text` is the
 * common first step. Two variables carry the surrounding context: `$args` is
 * the arguments the tool ran with, and `$root` is the whole data model.
 *
 * The result must be an object whose keys are data model paths. Each key
 * becomes its own message, so one tool call can fill several parts of the
 * model and leave the rest alone. A relative key resolves against the data
 * context the call ran in, which is the item's own scope when the call came
 * from a row of a template list.
 */
async function buildJsonataUpdates(
  expression: string | undefined,
  toolName: string,
  toolArguments: Record<string, unknown>,
  result: CallToolResult,
  context: DataContext,
): Promise<A2uiMessage[]> {
  if (!expression) {
    return [];
  }

  let compiled = compiledExpressions.get(expression);
  if (!compiled) {
    try {
      compiled = jsonata(expression);
    } catch (error: unknown) {
      throw expressionError('Invalid JSONata', toolName, error);
    }
    compiledExpressions.set(expression, compiled);
  }

  let evaluated: unknown;
  try {
    evaluated = await compiled.evaluate(result, {
      args: toolArguments,
      root: context.dataModel.get('/'),
    });
  } catch (error: unknown) {
    throw expressionError('JSONata evaluation failed', toolName, error);
  }

  if (evaluated === undefined || evaluated === null) {
    return [];
  }
  if (typeof evaluated !== 'object' || Array.isArray(evaluated)) {
    throw new A2uiExpressionError(
      `dataModelUpdateJsonata for MCP tool '${toolName}' must produce an object of ` +
        `data model paths, got ${Array.isArray(evaluated) ? 'an array' : `a ${typeof evaluated}`}.`,
      'callMcpTool',
    );
  }

  return Object.entries(evaluated).map(([path, value]) => ({
    version: 'v0.9',
    updateDataModel: {
      surfaceId: context.surface.id,
      path: resolveDataPath(path, context.path),
      // JSONata answers with sequences, which are arrays carrying an extra
      // `sequence` property, and with objects built on a null prototype.
      // Neither belongs in a data model a renderer reads, and a structural
      // copy drops both.
      value: value === undefined ? value : JSON.parse(JSON.stringify(value)),
    },
  })) as A2uiMessage[];
}

/** Resolves a data model path against the path of the calling data context. */
function resolveDataPath(path: string, basePath: string): string {
  if (path.startsWith('/')) {
    return path;
  }
  if (path === '' || path === '.') {
    return basePath;
  }
  return `${basePath === '/' ? '' : basePath.replace(/\/$/, '')}/${path}`;
}

/** Names a JSONata failure after the tool the expression belongs to. */
function expressionError(what: string, toolName: string, error: unknown): A2uiExpressionError {
  const message = error instanceof Error ? error.message : String(error);
  return new A2uiExpressionError(
    `${what} for MCP tool '${toolName}': ${message}`,
    'callMcpTool',
    error,
  );
}

/**
 * Reads the `_meta.ui.resourceUri` URIs of a tool result or a tool descriptor.
 *
 * The field is a transport convention rather than a specified A2UI field, so
 * this checks each hop, accepts one URI or an array of them, and drops
 * anything that is not a string. Duplicates are removed, since reading the
 * same resource twice would apply its messages twice.
 */
export function readUiResourceUris(source: {_meta?: unknown} | undefined): string[] {
  const declared = (source?._meta as any)?.ui?.resourceUri;
  const uris = Array.isArray(declared) ? declared : [declared];
  return [...new Set(uris.filter((uri): uri is string => typeof uri === 'string' && uri !== ''))];
}

/**
 * Returns the A2UI messages that `CallToolResult.content` carries inline, in
 * content order.
 *
 * A block qualifies only as an embedded resource declaring the
 * `application/a2ui+json` MIME type. A tool result mixes UI with prose and
 * ordinary JSON, so nothing else is read as A2UI, not even a text block that
 * happens to hold a message.
 *
 * @throws when a block declares the A2UI MIME type but holds invalid JSON.
 */
export function extractA2uiMessages(content: CallToolResult['content'] | undefined): A2uiMessage[] {
  const messages: A2uiMessage[] = [];
  for (const item of content ?? []) {
    const block = item as {
      type?: string;
      resource?: {uri?: string; mimeType?: string; text?: unknown};
    };
    if (block?.type !== 'resource' || block.resource?.mimeType !== A2UI_MIME_TYPE) {
      continue;
    }

    const {text, uri} = block.resource;
    if (typeof text !== 'string') {
      continue;
    }

    let parsed: A2uiMessage | A2uiMessage[];
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Resource ${uri} declares ${A2UI_MIME_TYPE} but does not hold valid JSON.`);
    }
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  return messages;
}

/**
 * Decodes the A2UI messages of a `resources/read` response, reading every
 * content block that declares the A2UI MIME type.
 *
 * Returns nothing when no block declares it, leaving a resource that holds
 * something else alone.
 *
 * @throws when a block declares the A2UI MIME type but holds invalid JSON.
 */
export function parseA2uiMessages(
  resource: ReadResourceResult | undefined,
  uri: string,
): A2uiMessage[] {
  const texts = (resource?.contents ?? [])
    .filter(content => content.mimeType === A2UI_MIME_TYPE)
    .map(content => (content as {text?: unknown}).text)
    .filter((text): text is string => typeof text === 'string');
  return texts.flatMap(text => {
    let parsed: A2uiMessage | A2uiMessage[];
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Resource ${uri} declares ${A2UI_MIME_TYPE} but does not hold valid JSON.`);
    }
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

/**
 * Reports whether messages would create a surface that the model already
 * holds, which `MessageProcessor` rejects with an `A2uiStateError`.
 */
function createsExistingSurface(
  messages: A2uiMessage[],
  processor: MessageProcessor<any>,
): boolean {
  return messages.some(message => {
    if (!message || !('createSurface' in message)) {
      return false;
    }
    const surfaceId = (message as CreateSurfaceMessage).createSurface?.surfaceId;
    return !!surfaceId && !!processor.model.getSurface(surfaceId);
  });
}
