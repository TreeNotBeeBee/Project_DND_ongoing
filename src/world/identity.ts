import type { GameState } from '../shared/model';
import { assert } from '../engine/dice';

/** Database operation receipts are scoped to a member; world entity identities are room-wide. */
export function assertWorldIdentities(state: GameState): void {
  const world = state.world;
  const indexes: [string, string[]][] = [['角色', state.actors.map(actor => actor.id)], ['规则选择', state.choices.map(choice => choice.id)]];
  if (world) indexes.push(['行动意图', world.round.intents.map(intent => intent.id)], ['草稿', world.drafts.map(draft => draft.id)], ['提案', world.proposals.map(proposal => proposal.id)], ['世界物品', world.items.map(item => item.id)], ['资源节点', world.nodes.map(node => node.id)], ['制作任务', world.jobs.map(job => job.id)], ['NPC行为', world.npcBehaviors.map(behavior => behavior.actorId)], ['AI交换', world.ai.exchanges.map(exchange => exchange.id)]);
  for (const [name, values] of indexes) assert(new Set(values).size === values.length, 'WORLD_DUPLICATE_ID', `${name}编号重复；为避免操作错绑，当前操作未执行，请恢复有效备份`);
}
