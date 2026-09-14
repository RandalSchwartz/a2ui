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
 * Tests for the payload, which is where this sample keeps its behaviour.
 *
 * The MCP server is mocked with responses copied from a real one, so these
 * cover what the sample actually ships: the payload validating against the
 * catalog, its JSONata turning server text into the data model, and the host
 * running the startup call the payload names.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {A2uiFilesystemApp, CATALOG_ID, SURFACE_ID} from './app';

/** A real `list_directory_with_sizes` response, including its totals block. */
const LISTING = [
  '[DIR] Documents                      ',
  '[FILE] .bash_profile                       568 B',
  '[FILE] notes with spaces.md               2.39 KB',
  '',
  'Total: 2 files, 1 directories',
  'Combined size: 2.94 KB',
].join('\n');

/** A real `read_text_file` response. */
const FILE_TEXT = 'line one\nline two\nline three';

/** A real `search_files` response. */
const MATCHES = '/Users/ada/a.md\n/Users/ada/notes/b.md';

let mockClient: {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  readResource: ReturnType<typeof vi.fn>;
};

/** Text the mocked server answers with, by tool name. */
let responses: Record<string, string>;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function () {
    return mockClient;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

/** Runs the connect-and-bootstrap lifecycle the way Lit would. */
const bootstrap = (app: A2uiFilesystemApp) => (app as any).firstUpdated();

/** Invokes a tool the way a button in the payload would. */
async function click(app: A2uiFilesystemApp, args: Record<string, unknown>, path = '/') {
  const surface = app.surface!;
  const {DataContext} = await import('@a2ui/web_core/v0_9');
  await surface.catalog.invoker('callMcpTool', args, new DataContext(surface, path));
}

describe('the filesystem payload', () => {
  let app: A2uiFilesystemApp;

  beforeEach(() => {
    vi.clearAllMocks();
    responses = {
      list_directory_with_sizes: LISTING,
      read_text_file: FILE_TEXT,
      search_files: MATCHES,
    };

    mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({tools: []}),
      readResource: vi.fn().mockResolvedValue({contents: []}),
      request: vi.fn().mockImplementation(async (request: any) => ({
        content: [{type: 'text', text: responses[request.params.name] ?? ''}],
      })),
    };

    app = new A2uiFilesystemApp();
  });

  it('validates against the catalog it names', async () => {
    await bootstrap(app);

    expect(app.processor.getClientCapabilities()['v0.9']?.supportedCatalogIds).toContain(
      CATALOG_ID,
    );
    expect(app.surface).toBeDefined();
    expect(app.surface!.componentsModel.get('entry_row')).toBeDefined();
    expect((app as any).error).toBe('');
  });

  it('runs the startup call the payload declares, listing the home directory', async () => {
    await bootstrap(app);

    expect(mockClient.request.mock.calls.map(call => call[0].params)).toEqual([
      {name: 'list_directory_with_sizes', arguments: {path: '~'}},
    ]);
  });

  it('turns a directory listing into rows the row template binds to', async () => {
    await bootstrap(app);

    expect(app.surface!.dataModel.get('/entries')).toEqual([
      {
        name: 'Documents',
        path: 'Documents',
        size: '',
        icon: 'folder',
        tool: 'list_directory_with_sizes',
        args: {path: 'Documents'},
        jsonata: {path: '/jsonata/list'},
      },
      {
        name: '.bash_profile',
        path: '.bash_profile',
        size: '568 B',
        icon: 'attachFile',
        tool: 'read_text_file',
        args: {path: '.bash_profile'},
        jsonata: {path: '/jsonata/read'},
      },
      {
        name: 'notes with spaces.md',
        path: 'notes with spaces.md',
        size: '2.39 KB',
        icon: 'attachFile',
        tool: 'read_text_file',
        args: {path: 'notes with spaces.md'},
        jsonata: {path: '/jsonata/read'},
      },
    ]);
    expect(app.surface!.dataModel.get('/entries_title')).toBe('3 entries');
  });

  it('counts a single entry in the singular', async () => {
    responses['list_directory_with_sizes'] = '[DIR] Documents                      ';

    await bootstrap(app);

    expect(app.surface!.dataModel.get('/entries_title')).toBe('1 entry');
  });

  it('sends a row to the tool the row carries, with the row arguments', async () => {
    await bootstrap(app);

    // The second entry is a file, so its row calls the read tool.
    await click(app, entryCall(app, 1), '/entries/1');

    expect(mockClient.request.mock.lastCall![0].params).toEqual({
      name: 'read_text_file',
      arguments: {path: '.bash_profile'},
    });
    expect(app.surface!.dataModel.get('/viewer_body')).toBe(
      '```\nline one\nline two\nline three\n```',
    );
    expect(app.surface!.dataModel.get('/args/open/path')).toBe('.bash_profile');
  });

  it('keeps the listing branch for a row that is a directory and supports nested navigation', async () => {
    await bootstrap(app);

    await click(app, entryCall(app, 0), '/entries/0');

    expect(mockClient.request.mock.lastCall![0].params).toEqual({
      name: 'list_directory_with_sizes',
      arguments: {path: 'Documents'},
    });
    expect(app.surface!.dataModel.get('/args/open/path')).toBe('Documents');
    expect(app.surface!.dataModel.get('/args/parent/path')).toBe('~');

    // Navigate a second level down
    await click(app, entryCall(app, 0), '/entries/0');

    expect(mockClient.request.mock.lastCall![0].params).toEqual({
      name: 'list_directory_with_sizes',
      arguments: {path: 'Documents/Documents'},
    });
    expect(app.surface!.dataModel.get('/args/open/path')).toBe('Documents/Documents');
    expect(app.surface!.dataModel.get('/args/parent/path')).toBe('Documents');
  });

  it('turns search output into a result list', async () => {
    await bootstrap(app);

    await click(app, searchCall(app));

    expect(mockClient.request.mock.lastCall![0].params.arguments).toEqual({
      path: '~',
      pattern: '**/*.md',
    });
    expect(app.surface!.dataModel.get('/search_results')).toEqual([
      {
        label: '/Users/ada/a.md',
        path: '/Users/ada/a.md',
        args: {path: '/Users/ada/a.md'},
        jsonata: {path: '/jsonata/read'},
      },
      {
        label: '/Users/ada/notes/b.md',
        path: '/Users/ada/notes/b.md',
        args: {path: '/Users/ada/notes/b.md'},
        jsonata: {path: '/jsonata/read'},
      },
    ]);
    expect(app.surface!.dataModel.get('/viewer_body')).toBe(
      'Found 2 matches for glob `**/*.md` in `~`',
    );
  });

  it('supports typing a directory path and listing it', async () => {
    await bootstrap(app);

    // User types in the Directory text field
    app.surface!.dataModel.set('/args/open/path', 'Documents/projects');

    // Click "List directory" button
    await click(app, {
      name: 'list_directory_with_sizes',
      arguments: {path: {path: '/args/open/path'}},
      dataModelUpdateJsonata: {path: '/jsonata/list'},
    });

    expect(mockClient.request.mock.lastCall![0].params).toEqual({
      name: 'list_directory_with_sizes',
      arguments: {path: 'Documents/projects'},
    });
    expect(app.surface!.dataModel.get('/args/open/path')).toBe('Documents/projects');
    expect(app.surface!.dataModel.get('/args/parent/path')).toBe('Documents');
    expect(app.surface!.dataModel.get('/args/search/path')).toBe('Documents/projects');
  });

  it('empties the result list when nothing matches', async () => {
    await bootstrap(app);
    responses['search_files'] = 'No matches found';

    await click(app, searchCall(app));

    expect(app.surface!.dataModel.get('/search_results')).toEqual([]);
  });

  it('reports a transport failure instead of rendering an empty surface', async () => {
    mockClient.connect.mockRejectedValue(new Error('Network error'));

    await bootstrap(app);

    expect(app.surface).toBeUndefined();
    expect((app as any).error).toBe('Network error');
  });
});

/**
 * Builds the call the row template makes for one entry.
 *
 * The row binds every part of the call to the entry: the tool name, the
 * arguments object, and the expression that reads the result.
 */
function entryCall(app: A2uiFilesystemApp, index: number): Record<string, unknown> {
  const entry = app.surface!.dataModel.get(`/entries/${index}`);
  return {
    name: entry.tool,
    arguments: entry.args,
    dataModelUpdateJsonata: entry.jsonata,
  };
}

/** Builds the call the search button makes. */
function searchCall(app: A2uiFilesystemApp): Record<string, unknown> {
  return {
    name: 'search_files',
    arguments: {
      path: app.surface!.dataModel.get('/args/search/path'),
      pattern: app.surface!.dataModel.get('/args/search/pattern'),
    },
    dataModelUpdateJsonata: app.surface!.dataModel.get('/jsonata/search'),
  };
}
