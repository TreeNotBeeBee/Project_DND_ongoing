import { useContext } from 'react';
import type { Actor } from '../shared/model';
import type { GameClient } from './transport';
import { CharacterEditor } from './CharacterEditor';
import { ModalFeedbackContext } from './components';
import { WorldFeedback } from './WorldPrimitives';

/** This advanced builder receives only the authenticated catalog from the server. */
export default function WorldStandardWizard({ game, actor, onClose }: { game: GameClient; actor?: Actor; onClose: () => void }) {
  const feedback = useContext(WorldFeedback), snapshot = game.snapshot!;
  return <ModalFeedbackContext.Provider value={acknowledged => feedback?.(acknowledged)}><CharacterEditor actor={actor} actors={snapshot.state.actors} entries={game.entries} members={snapshot.members} member={snapshot.session.member} saveError={game.error} onClose={onClose} onSave={(data, draft) => {
    if (!actor) return game.command('character.create', undefined, { actor: { ...data, profile: 'srd2024', draft } }, [], '创建标准5e角色');
    const { ownerId: _owner, kind: _kind, inventory: _inventory, ...patch } = data;
    return game.command('character.patch', actor.id, { actorId: actor.id, patch: { ...patch, draft } }, [], '保存标准5e角色');
  }} /></ModalFeedbackContext.Provider>;
}
