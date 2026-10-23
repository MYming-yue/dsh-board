import { readdir, readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { BoardStore } from './store.mjs';
import { BoardContext, BOARD_INSTRUCTIONS } from './context.mjs';
import { LayoutTasks, LAYOUT_INSTRUCTIONS } from './layout.mjs';
import { BoardGuide } from './guide.mjs';
import { QualityReview } from './quality.mjs';

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
  const quality = new QualityReview();
  const store = new BoardStore(config.dataDir ?? join(home, 'dsh-board'), quality);
  await store.ready;
  const boardContext = new BoardContext(join(store.directory, 'plugin-state.json'));
  await boardContext.ready;
  const guide = new BoardGuide(store.directory);
  await guide.ready;
  const layouts = new LayoutTasks(store);
  const layoutRestrictions = new Map();
  const releaseLayout = agent => { layoutRestrictions.get(agent.id)?.(); layoutRestrictions.delete(agent.id); };
  ctx.effect(() => ctx.tools.guard(exec => layouts.forAgent(exec.agent) && !['draft_board_layout_read','draft_board_layout_apply','run_code'].includes(exec.name)
    ? '本轮仅允许白板布局读取与坐标提交；内容、结构及其他工具已暂停。' : undefined));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const register = route => ctx.effect(() => ctx.connection.fetch.register(route));
  register({path:'/api/dsh-board/quality',methods:['GET','POST'],requestBody:'buffered',fetch:async request=>{
    try { return json(request.method==='POST' ? quality.report(await request.json()) : {job:quality.pending()}); }
    catch(cause){return json({error:{code:'E_QUALITY_MEASUREMENT',message:cause.message}},400);}
  }});
  ctx.effect(()=>()=>quality.setEnabled(false));
  const options = () => ({ ...boardContext.options, version, draftName: store.bundle.file.board.name, fileName: store.fileName });
  register({ path: '/api/dsh-board/guide', methods: ['GET','POST'], requestBody: 'buffered',
    fetch: async request => {
      try { return json(request.method === 'POST' ? await guide.save(await request.json()) : await guide.read()); }
      catch(error) { return json({error:{code:error.code ?? 'E_GUIDE_INVALID',message:error.message}},error.code === 'E_GUIDE_CONFLICT' ? 409 : 400); }
    } });
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
        else { await guide.read(); await boardContext.stage(value.sessionId, value.requestId, boardContext.options.enabled && boardContext.options.associateSelection ? value.selection : null); }
        return json({ ok: true });
      } catch (error) { return json({ error: { message: error.message } }, 400); }
    } });
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message.source?.kind === 'user') {
      releaseLayout(agent); layouts.settle(agent); layouts.claim(agent, message);
      if (layouts.forAgent(agent)) layoutRestrictions.set(agent.id, agent.ctx.tools.restrict({ allow: ['draft_board_layout_read','draft_board_layout_apply'] }));
    }
    if (boardContext.claim(agent.id, message)) void boardContext.save().catch(() => ctx.logger.warn('DSH-board association persistence failed'));
  });
  ctx.on('agent/status', ({agent,status}) => { if(status === 'idle') { layouts.settle(agent); releaseLayout(agent); } });
  ctx.effect(() => () => { for(const release of layoutRestrictions.values()) release(); });
  register({ path: '/api/dsh-board/layout', methods: ['GET','POST','DELETE'], requestBody: 'buffered',
    fetch: async request => {
      try {
        if (!boardContext.options.enabled) throw new Error('DSH-board is disabled');
        if (request.method === 'POST') { await guide.read(); return json(await layouts.create(await request.json())); }
        const id = new URL(request.url).searchParams.get('id');
        if(request.method==='GET' && !id) return json({task:[...layouts.tasks.values()].filter(t=>['pending','running'].includes(t.status)).map(t=>layouts.public(t))[0] ?? null});
        return json(request.method === 'DELETE' ? layouts.cancel(id) : layouts.public(layouts.get(id)));
      } catch(error) { return json({error:{message:error.message}},400); }
    } });
  register({path:'/api/dsh-board/layout/geometry',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    try { return json(layouts.observe(await request.json())); } catch(error) { return json({error:{message:error.message}},400); }
  }});
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
  let guideRelease = null;
  function updateGuideSection() {
    guideRelease?.(); guideRelease = null;
    if (boardContext.options.enabled && guide.text.trim()) guideRelease = ctx.systemPrompt.section({name:'dsh-board-guide',
      order:ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')+101,text:guide.text});
  }
  function reconcile() {
    quality.setEnabled(boardContext.options.enabled);
    for (const release of releases) release();
    releases = [];
    updateGuideSection();
    if (!boardContext.options.enabled) {
      for(const task of layouts.tasks.values())if(['pending','running'].includes(task.status))layouts.cancel(task.id);
      layouts.active.clear();for(const release of layoutRestrictions.values())release();layoutRestrictions.clear();
      return;
    }
    const requireEnabled = () => { if (!boardContext.options.enabled) throw new Error('DSH-board is disabled'); };
    releases.push(ctx.tools.register({ name: 'draft_board_read',
    description: 'Read the current shared whiteboard before maintaining it. Returns card identities, content, relations and contentVersion. Runtime card associations identify objects, not supplied card contents.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
    isConcurrencySafe: () => true,
    execute: async () => { requireEnabled(); await guide.read(); return jsonSafe(await store.read()); } }));
    releases.push(ctx.tools.register({ name: 'draft_board_apply',
    description: 'Maintain the shared whiteboard with one atomic undoable batch. Read first; send batchVersion=1.0, boardId, baseContentVersion, actor=agent, label and ops. Before writing, the browser renders a read-only candidate and checks actual card/caption bounds, collection separation, paths and labels. E_EDIT_GEOMETRY leaves the board unchanged and returns candidate dimensions and conflicts: correct the complete batch, keeping the original baseContentVersion. Version conflicts require reading again; unavailable measurements never bypass checks.',
    parameters: { type: 'object', properties: { batch: { type: 'string', description: 'JSON-encoded AgentBatch. Existing Draft Board operations only.' } }, required: ['batch'], additionalProperties: false }, output,
    execute: async (args, exec) => { requireEnabled(); return jsonSafe(await store.apply(JSON.parse(args.batch), exec.signal)); } }));
    releases.push(ctx.tools.register({name:'draft_board_layout_read',description:'Read the active layout task: existing content, relationships, allowed card IDs, actual visible card sizes and viewport. Only available for a layout task admitted through the whiteboard button.',
      parameters:{type:'object',properties:{},additionalProperties:false},output,isConcurrencySafe:()=>true,
      execute:async(_args,exec)=>{requireEnabled();return jsonSafe(await layouts.read(exec.agent));}}));
    releases.push(ctx.tools.register({name:'draft_board_layout_apply',description:'Submit only candidate positions for the active layout task. Checks identity/version, scope, card/collection spacing and automatically routed edges before committing one undoable batch. A rejected candidate never changes the board. Empty positions finishes without history.',
      parameters:{type:'object',properties:{taskId:{type:'string'},boardId:{type:'string'},baseContentVersion:{type:'integer',minimum:0},positions:{type:'array',items:{type:'object',properties:{nodeId:{type:'string'},x:{type:'number'},y:{type:'number'}},required:['nodeId','x','y'],additionalProperties:false}}},required:['taskId','boardId','baseContentVersion','positions'],additionalProperties:false},output,
      execute:async(args,exec)=>{requireEnabled();return jsonSafe(await layouts.apply(args,exec));}}));
    releases.push(ctx.systemPrompt.section({ name: 'dsh-board', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 100,
      text: BOARD_INSTRUCTIONS }));
    releases.push(ctx.systemPrompt.context({ name: 'dsh-board', order: 1_000_000,
      text: assembly => assembly.agent ? boardContext.render(assembly.agent.id, store.bundle.file.board.id) + (layouts.forAgent(assembly.agent) ? '\n' + LAYOUT_INSTRUCTIONS : '\nCurrent operation: ordinary whiteboard editing. Layout-task restrictions from earlier turns have ended.') : '' }));
  }
  reconcile();
  ctx.effect(() => guide.subscribe(updateGuideSection));
  ctx.effect(() => {
    const timer = setInterval(() => { void guide.read().catch(() => ctx.logger.warn('DSH-board guide refresh failed')); },1500);
    timer.unref?.(); return () => clearInterval(timer);
  });
  ctx.effect(() => () => { guideRelease?.(); for (const release of releases) release(); });
}
