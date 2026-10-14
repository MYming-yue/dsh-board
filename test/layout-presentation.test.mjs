import test from 'node:test';
import assert from 'node:assert/strict';
import { isLayoutMessage, layoutTurnRequest } from '../src/layout-presentation.mjs';
import { LAYOUT_REQUEST, LEGACY_LAYOUT_REQUEST } from '../src/layout-submission.mjs';

const message = { source:{kind:'user',rpcId:'toolbar1'},content:[{type:'text',text:LAYOUT_REQUEST}] };
const node = (kind, turn, data) => ({kind,key:kind+turn,data,location:{kind:'turn',turn:{turn}}});
test('only exact native toolbar text is compacted', () => {
  assert.equal(isLayoutMessage(message),true);
  assert.equal(isLayoutMessage({...message,content:[{type:'text',text:LEGACY_LAYOUT_REQUEST}]}),true);
  assert.equal(isLayoutMessage({...message,source:{kind:'plugin'}}),false);
  assert.equal(isLayoutMessage({...message,content:[...message.content,{type:'image'}]}),false);
  assert.equal(isLayoutMessage({...message,content:[{type:'text',text:'讨论一下：'+LAYOUT_REQUEST}]}),false);
});
test('task output is folded by its own native turn and rehydrates from history', () => {
  const input=node('user',1,message),reply=node('assistant-step',1,{}),ordinary=node('user',2,{source:{kind:'user',rpcId:'normal'},content:[{type:'text',text:'你好'}]});
  const snapshot={nodes:new Map([['input',input],['reply',reply],['ordinary',ordinary]])};
  assert.equal(layoutTurnRequest(snapshot,reply),'toolbar1');
  assert.equal(layoutTurnRequest(snapshot,ordinary),null);
  assert.equal(layoutTurnRequest({nodes:new Map([['reply',reply]])},reply),null,'incomplete history fails open');
  snapshot.nodes.set('steer',node('steering',1,ordinary.data));
  assert.equal(layoutTurnRequest({...snapshot},reply),null,'ordinary steering in the same turn must stay visible');
});
