import { readdir, readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { BoardStore } from './store.mjs';
import { BoardContext, BOARD_INSTRUCTIONS } from './context.mjs';

export const name = 'dsh-board';
export const inject = ['connection', 'tools', 'systemPrompt'];
const jsonSafe = value => JSON.parse(JSON.stringify(value));
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const output = { schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

export async function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const store = new BoardStore(config.dataDir ?? join(home, 'dsh-board'));
  await store.ready;
  const boardContext = new BoardContext(join(store.directory, 'plugin-state.json'));
  await boardContext.ready;
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const register = route => ctx.effect(() => ctx.connection.fetch.register(route));
  const options = () => ({ ...boardContext.options, version, draftName: store.bundle.file.board.name, fileName: store.fileName });
  register({ path: '/api/dsh-board/options', methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      try {
        if (request.method === 'POST') {
          const previous = boardContext.options;
          await boardContext.configure(await request.json());
          if (previous.enabled !== boardContext.options.enabled) reconcile();
        }
        return json(options());
      } catch (error) { return json({ error: { message: error.message } }, 400); }
    } });
  register({ path: '/api/dsh-board/association', methods: ['POST', 'DELETE'], requestBody: 'buffered',
    fetch: async request => {
      try {
        const value = await request.json();
        if (request.method === 'DELETE') await boardContext.discard(value.sessionId, value.requestId);
        else await boardContext.stage(value.sessionId, value.requestId, boardContext.options.enabled && boardContext.options.associateSelection ? value.selection : null);
        return json({ ok: true });
      } catch (error) { return json({ error: { message: error.message } }, 400); }
    } });
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (boardContext.claim(agent.id, message)) void boardContext.save().catch(() => ctx.logger.warn('DSH-board association persistence failed'));
  });
  register({ path: '/api/dsh-board/state', methods: ['GET'], requestBody: 'buffered',
    fetch: async request => json(await store.snapshot(new URL(request.url).searchParams.get('revision'))) });
  register({ path: '/api/dsh-board/sync', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      try { return json(await store.sync(await request.json(), request.signal)); }
      catch (error) { return json({ error: { code: error.code ?? 'E_SCHEMA', message: error.message } }, error.code === 'E_SYNC_CONFLICT' ? 409 : 400); }
    } });

  const directory = join(dirname(fileURLToPath(import.meta.url)), '../lib/board-ui');
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
  async function mountFiles(relative = '') {
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await mountFiles(path);
      else if (item.isFile()) {
        const bytes = await readFile(join(directory, path));
        register({ path: '/api/dsh-board/ui/' + path, methods: ['GET', 'HEAD'], requestBody: 'buffered',
          fetch: async request => new Response(request.method === 'HEAD' ? null : bytes, {
            headers: { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' },
          }) });
      }
    }
  }
  await mountFiles();
  let releases = [];
  function reconcile() {
    for (const release of releases) release();
    releases = [];
    if (!boardContext.options.enabled) return;
    const requireEnabled = () => { if (!boardContext.options.enabled) throw new Error('DSH-board is disabled'); };
    releases.push(ctx.tools.register({ name: 'draft_board_read',
    description: 'Read the current shared whiteboard before maintaining it. Returns card identities, content, relations and contentVersion. Runtime card associations identify objects, not supplied card contents.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
    isConcurrencySafe: () => true,
    execute: async () => { requireEnabled(); return jsonSafe(await store.read()); } }));
    releases.push(ctx.tools.register({ name: 'draft_board_apply',
    description: 'Actively maintain the current shared whiteboard with one validated, undoable Draft Board batch. Read first, then send batchVersion=1.0, boardId, baseContentVersion, actor=agent, label and ops. Identity/version conflicts require reading again.',
    parameters: { type: 'object', properties: { batch: { type: 'string', description: 'JSON-encoded AgentBatch. Existing Draft Board operations only.' } }, required: ['batch'], additionalProperties: false }, output,
    execute: async (args, exec) => { requireEnabled(); return jsonSafe(await store.apply(JSON.parse(args.batch), exec.signal)); } }));
    releases.push(ctx.systemPrompt.section({ name: 'dsh-board', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 100,
      text: BOARD_INSTRUCTIONS }));
    releases.push(ctx.systemPrompt.context({ name: 'dsh-board', order: 1_000_000,
      text: assembly => assembly.agent ? boardContext.render(assembly.agent.id, store.bundle.file.board.id) : '' }));
  }
  reconcile();
  ctx.effect(() => () => { for (const release of releases) release(); });
}
