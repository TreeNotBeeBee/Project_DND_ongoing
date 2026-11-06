import type { Command, GameState, Member, Resolution } from '../shared/model';
import { CAPABILITIES, type Capability, type TimeoutVote, type WorldContext, type WorldDraft, type WorldProposal, type WorldState } from '../shared/world';
import { assert } from '../engine/dice';
import { HOUR_MS } from './fixed';
import { draftPayload, id, object, text } from './validation';

type Log = Resolution['events'];
const votes: TimeoutVote[] = ['approve', 'reject', 'abstain'];
export function requireWorld(state: GameState): WorldState { assert(state.world?.version === 1, 'WORLD_REQUIRED', '此战役尚未建立世界配置'); return state.world; }
export function hasCapability(world: WorldState, memberId: string, capability: Capability): boolean {
  return memberId === world.ownerId || world.governance.system === 'dictatorship' && Boolean(world.governance.delegations[memberId]?.includes(capability));
}
export function requireCapability(world: WorldState, member: Member, capability: Capability): void { assert(hasCapability(world, member.id, capability), 'WORLD_PERMISSION', '此操作需要房主或该事项的明确授权；主持人身份不能替代授权'); }
export function requireOwner(world: WorldState, member: Member): void { assert(world.ownerId === member.id, 'WORLD_OWNER', '此操作仅限房主，授权成员不能再次转授权'); }
export function note(log: Log, type: string, message: string, actorId?: string): void { log.push({ type, message, ...(actorId ? { actorId } : {}) }); }
export function reviewCapability(kind: WorldDraft['kind']): Capability {
  return ({ scene: 'review.map', rules: 'review.rules', actor: 'review.creatures', story: 'review.story', items: 'review.rules', nodes: 'review.map' } as const)[kind];
}
function reject(proposal: WorldProposal, log: Log, reason: string): void { proposal.status = 'rejected'; proposal.result = reason; delete proposal.effectiveRound; note(log, 'proposal-rejected', `提案「${proposal.title}」未采用：${reason}`); }
function approve(world: WorldState, proposal: WorldProposal, log: Log): void { proposal.status = 'approved'; proposal.effectiveRound = world.round.number + 1; proposal.result = `已通过，将于第${proposal.effectiveRound}回合生效`; note(log, 'proposal-approved', `提案「${proposal.title}」已通过，将于下一回合生效`); }

/** Final tallies exclude abstentions, never absent electorate members before their timeout policy is applied. */
export function closeProposal(world: WorldState, proposal: WorldProposal, now: number, log: Log): void {
  if (proposal.status !== 'open') return;
  if (world.governance.system === 'dictatorship') { if (now >= proposal.closesAt) reject(proposal, log, '审批期限已到，尚未批准'); return; }
  const deadline = now >= proposal.closesAt;
  if (!deadline && !proposal.electorate.every(memberId => proposal.ballots[memberId])) return;
  for (const memberId of proposal.electorate) if (!proposal.ballots[memberId]) proposal.ballots[memberId] = { vote: world.timeoutVotes[memberId] || 'abstain', source: 'timeout' };
  const selected = proposal.electorate.map(memberId => proposal.ballots[memberId].vote), yes = selected.filter(vote => vote === 'approve').length, no = selected.filter(vote => vote === 'reject').length;
  if (!yes && !no) { reject(proposal, log, '全部弃权，未产生有效票'); return; }
  if (yes < no) { reject(proposal, log, `反对${no}票，赞成${yes}票`); return; }
  if (yes === no) {
    proposal.status = 'owner-review'; proposal.result = `有效票平票（赞成${yes}、反对${no}），等待房主裁定`;
    note(log, 'proposal-tied', `提案「${proposal.title}」平票，等待房主裁定`); return;
  }
  if (world.governance.ownerVeto && proposal.ownerDecision !== true) {
    proposal.status = 'owner-review'; proposal.result = '多数通过，等待房主显式批准'; note(log, 'proposal-owner-review', `提案「${proposal.title}」多数通过，等待房主批准`); return;
  }
  approve(world, proposal, log);
}
export function closeDueProposals(world: WorldState, now: number, log: Log): void {
  for (const proposal of world.proposals) if (proposal.status === 'open' && now >= proposal.closesAt) closeProposal(world, proposal, now, log);
}
export function registeredMembers(state: GameState, ctx: WorldContext): string[] {
  return ctx.members.filter(member => state.actors.some(actor => actor.ownerId === member.id && actor.kind === 'hero' && actor.registration === 'registered')).map(member => member.id);
}
export function openProposal(state: GameState, draft: WorldDraft, command: Command, ctx: WorldContext, log: Log): WorldProposal {
  const world = requireWorld(state), electorate = [...new Set(registeredMembers(state, ctx))];
  assert(electorate.length <= 12, 'WORLD_ELECTORATE', '投票名单不能超过本房间12位成员');
  const proposal: WorldProposal = {
    id: `proposal:${command.operationId}`, draftId: draft.id, authorId: draft.ownerId, title: draft.title, kind: draft.kind, payload: structuredClone(draft.payload),
    electorate, ballots: {}, opensAt: ctx.now, closesAt: ctx.now + Math.ceil((world.rules.proposalHours ?? 24) * HOUR_MS), status: world.mode === 'co-create' ? 'open' : 'owner-review',
  };
  assert(!world.proposals.some(entry => entry.id === proposal.id), 'WORLD_DUPLICATE', '此提案已经提交');
  assert(world.proposals.length < 2000, 'WORLD_LIMIT', '提案数量已达上限，请归档世界后继续');
  world.proposals.push(proposal); note(log, 'proposal-opened', `提案「${proposal.title}」已结算费用并进入${world.governance.system === 'democracy' ? '投票' : '授权审批'}`); return proposal;
}
export function handleGovernance(state: GameState, command: Command, member: Member, ctx: WorldContext, log: Log): boolean {
  const world = requireWorld(state), p = object(command.payload || {});
  switch (command.type) {
    case 'draft.save': {
      const input = object(p.draft, '草稿'), current = input.id === undefined ? undefined : world.drafts.find(draft => draft.id === input.id);
      if (input.id !== undefined) assert(current && current.ownerId === member.id, 'WORLD_DRAFT_OWNER', '只能编辑自己的现有草稿');
      const kind = input.kind as WorldDraft['kind'], draft: WorldDraft = { id: current?.id || `draft:${command.operationId}`, ownerId: member.id, kind, title: text(input.title, '草稿标题', 256), payload: draftPayload(kind, input.payload), updatedAt: ctx.now };
      if (current) world.drafts[world.drafts.indexOf(current)] = draft;
      else { assert(world.drafts.length < 2000, 'WORLD_LIMIT', '草稿数量已达上限'); world.drafts.push(draft); }
      note(log, 'draft-saved', '个人草稿已保存，不消耗行动力'); return true;
    }
    case 'draft.delete': {
      const draft = world.drafts.find(draft => draft.id === p.id); assert(draft && draft.ownerId === member.id, 'WORLD_DRAFT_OWNER', '只能删除自己的草稿');
      world.drafts = world.drafts.filter(entry => entry !== draft); note(log, 'draft-deleted', '个人草稿已删除'); return true;
    }
    case 'governance.grant': {
      requireOwner(world, member); assert(world.mode === 'co-create' && world.governance.system === 'dictatorship', 'WORLD_GOVERNANCE', '只有独裁治理允许授权审批事项');
      const memberId = id(p.memberId); assert(memberId !== world.ownerId && ctx.members.some(entry => entry.id === memberId), 'WORLD_MEMBER', '请选择本房间的其他成员');
      assert(Array.isArray(p.capabilities) && p.capabilities.length <= CAPABILITIES.length && p.capabilities.every((capability: Capability) => CAPABILITIES.includes(capability)) && new Set(p.capabilities).size === p.capabilities.length, 'WORLD_CAPABILITY', '授权必须为明确且不重复的已有权限');
      if (p.capabilities.length) world.governance.delegations[memberId] = [...p.capabilities]; else delete world.governance.delegations[memberId];
      note(log, 'governance-delegation', `${ctx.members.find(entry => entry.id === memberId)!.name}的具体授权已由房主更新`); return true;
    }
    case 'vote.preference': {
      assert(votes.includes(p.value), 'WORLD_VOTE', '超时处理必须为赞成、反对或弃权'); world.timeoutVotes[member.id] = p.value; note(log, 'vote-preference', '个人投票超时偏好已更新'); return true;
    }
    case 'vote.cast': {
      assert(world.mode === 'co-create' && world.governance.system === 'democracy', 'WORLD_GOVERNANCE', '当前房间不是民主共创模式');
      const proposal = world.proposals.find(proposal => proposal.id === p.proposalId);
      assert(proposal?.status === 'open' && ctx.now < proposal.closesAt, 'WORLD_VOTE_CLOSED', '此提案已结束投票');
      assert(proposal.electorate.includes(member.id), 'WORLD_ELECTORATE', '你不在此提案开票时固定的投票名单中'); assert(votes.includes(p.vote), 'WORLD_VOTE', '请选择赞成、反对或弃权');
      proposal.ballots[member.id] = { vote: p.vote, source: 'manual' }; note(log, 'vote-cast', `${member.name}已提交提案投票`); closeProposal(world, proposal, ctx.now, log); return true;
    }
    case 'proposal.decide': {
      const proposal = world.proposals.find(proposal => proposal.id === p.proposalId);
      assert(proposal && ['open', 'owner-review'].includes(proposal.status), 'WORLD_PROPOSAL', '此提案不再等待裁定'); assert(typeof p.approve === 'boolean', 'WORLD_VOTE', '请明确批准或否决');
      if (world.mode !== 'co-create') {
        requireOwner(world, member); proposal.ownerDecision = p.approve;
        if (p.approve) approve(world, proposal, log); else reject(proposal, log, '主持人否决');
      } else if (world.governance.system === 'dictatorship') {
        requireCapability(world, member, reviewCapability(proposal.kind)); proposal.ownerDecision = p.approve;
        if (p.approve) approve(world, proposal, log); else reject(proposal, log, '授权审批人否决');
      } else {
        requireOwner(world, member);
        assert(proposal.status === 'owner-review' || world.governance.ownerVeto, 'WORLD_GOVERNANCE', '未启用房主否决，房主只能裁定有效票平票');
        proposal.ownerDecision = p.approve;
        if (!p.approve) reject(proposal, log, '房主明确否决');
        else if (proposal.status === 'owner-review') approve(world, proposal, log);
        else note(log, 'proposal-owner-approval', '房主已显式批准，仍需等待民主投票产生通过结果');
      }
      return true;
    }
    default: return false;
  }
}
