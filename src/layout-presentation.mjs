import { LAYOUT_REQUEST, LEGACY_LAYOUT_REQUEST } from './layout-submission.mjs';

// Only an exact toolbar admission qualifies; quoted text, attachments and
// ordinary steering keep their native presentation.
export function isLayoutMessage(data) {
  return data?.source?.kind === 'user' && data.content?.length === 1 &&
    data.content[0]?.type === 'text' && [LAYOUT_REQUEST, LEGACY_LAYOUT_REQUEST].includes(data.content[0].text);
}
export function nodeTurn(node) {
  const location = node?.location;
  return ['turn', 'step'].includes(location?.kind) ? location.turn : undefined;
}
// Native Chat snapshots are immutable publications. Classify each once rather
// than walking all history for every seat on each streamed frame.
const classified = new WeakMap();
export function layoutTurnRequest(snapshot, node) {
  const turn = nodeTurn(node);
  if (!turn || !snapshot?.nodes?.values) return null;
  let turns = classified.get(snapshot);
  if (!turns) {
    turns = new Map();
    for (const candidate of snapshot.nodes.values()) {
      const id = nodeTurn(candidate)?.turn;
      if (id === undefined || !['user', 'steering'].includes(candidate.kind)) continue;
      if (!isLayoutMessage(candidate.data)) turns.set(id, null); // Mixed turns stay visible.
      else if (!turns.has(id)) turns.set(id, candidate.data.source.rpcId ?? null);
    }
    classified.set(snapshot, turns);
  }
  return turns.get(turn.turn) ?? null;
}
