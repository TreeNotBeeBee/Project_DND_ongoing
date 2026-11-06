# JigeRPG platform contract

New AI worlds use the independent AI display contract below. Native character and co-creation contracts remain available for their own modes and historical compatibility; they cannot calculate or mutate a display-v2 world.

## Accounts and world selection (beta.2, schema 3)

- `GET /api/account` returns `{account:{id,username,displayName,canCreateWorld}|null,legacySession?}`. `POST /api/account/register` / `login` accept `{username,password,displayName?,hostToken?}` and return `{account}`. Passwords use native Node 26 Argon2id. Host-token authorization persists creation permission on the account; remote player accounts can join invitations.
- `POST /api/account/logout` clears account and world sessions. `POST /api/account/link-current` binds an existing unlinked world identity after account login. `/api/recover` can bind an unlinked legacy identity using its recovery code; names never determine identity.
- `GET /api/worlds` returns only the account's authorized worlds as `{worlds:[{id,name,mode,phase,role,isOwner,updatedAt}]}`. `POST /api/worlds/enter {worldId}` returns `Snapshot`; `/api/worlds/leave {}` clears the world session and retains the account.
- Authenticated `POST /api/campaigns` accepts `{name,mode,governance?,freedom?:'A'|'B'|'C'}`. A new account-owned AI world defaults to display v2. Invitations remain `/api/join {inviteCode,name?}`; repeat joining uses the same member ID.
- Cookies `jige_account` and `jige_session` are HttpOnly/SameSite=Strict and Secure on the active public tunnel. A linked member requires its matching account cookie, including WSS handshakes. Changing account or world revokes the old world session.

## AI-authoritative display protocol v2

`Snapshot.world.ai.display` contains the projected independent state. `Snapshot.state.actors` is empty and no native Actor derivation or world-energy recovery runs. Technical JSON/type/reference/size checks, authorization, revision checks, transactional receipts and visibility filtering remain active. HP, abilities and other AI game values are never clamped or checked against game rules.

- Owner `POST /api/ai/export {kind}` returns `{packet,schema,prompt,template?}`; `kind` is `initialize`, `player_selection`, `turn_context` or `roll_results`. The initialization template contains the live campaign/exchange/revision envelope and five module groups. Display revision changes only when game context changes, so draft and portrait saves do not invalidate replies.
- Owner `POST /api/ai/preview {packet}` returns `{valid,errors,summary,missingGroups,pendingConfirmations,packet?}`. Invalid/unsupported JSON can be saved as a raw draft. See [v2 schema](reference/ai-display-reply-v2.schema.json) and [examples](examples/ai-v2/).
- `ai.display.initialize {packet}` / `ai.display.apply {packet}` accept fixed version-2 initialize/update replies. Updates upsert/delete complete entities or narratives by stable ID. The AI cannot write bindings, member authority or player profiles. Duplicate operation IDs and decision IDs do not apply twice.
- `ai.display.draft.save {raw}`, `ai.display.freedom.set {freedom}` (before initialization), `ai.display.field.confirm {id,accept}`, `ai.display.map.set {map|null}`, `ai.display.entity.position {id,position|null}` and `ai.display.roll {sides,count,purpose?}` are owner-only. Dice return faces only. `world.start {}` begins an initialized display world.
- `ai.display.select {actorId}` / `release {}` bind/release the calling member's PC without a second registration step. `ai.display.action {actorId,type?,text,targetIds?}` stores server-bound untrusted behavior; it never spends resources or moves a token.
- `ai.display.profile {image?,publicFieldIds?}` affects only the caller's bound PC. Other PCs receive no detailed fields by default; explicit publication cannot reveal GM-only fields. Image overrides persist independently from AI entity updates.
- Native commands, legacy `ai.apply`, governance and rule-engine migration are rejected in display worlds. Archives cannot silently switch protocols. Export/restore preserve display state, private data and bindings through the existing owner-only backup route.

Initialization editions are `5e2014` and `5e2024` metadata. Unknown editions are reported; no silent conversion occurs. Field source labels (`module`, `ai`, `unknown`) are declarations. Freedom A holds AI additions for individual acceptance or blank values; B/C require no individual acceptance. Schema limits reject forbidden control characters, excessive nesting/volume and invalid fields, not topic words or unreasonable game numbers.

## World contract (v2)

- POST `/api/campaigns` `{name,gmName,hostToken,mode:'gm'|'ai'|'co-create',governance?:{system:'democracy'|'dictatorship',ownerVeto:boolean}}`. Mode, owner and governance are fixed at creation. Omission of mode is reserved for legacy compatibility.
- `Snapshot` includes `world`, visible `tokens`, minimal `offers`, opted-in public `profiles`, and server-derived `actorViews` including effective `energyLimits`. Non-owners receive only their full registered hero / controlled companion cards. GM-only effects and choices remain filtered even on their own card.
- GET `/api/content` returns the owner's catalog or entries individually unlocked by the current member's actors; unauthenticated clients receive no entries. No complete hidden content catalog ships in the production JS bundle.
- Character commands: `character.create {actor?}`, `character.copyFree {actorId}`, `character.claim {actorId}`, `character.register {actorId,approved,memberId?}`, `character.release {actorId}`, `character.patch {actorId,patch}`, `profile.update {actorId,portrait?,publicGroups?}`, `knowledge.unlock {actorId,entryId}`. Sources remain unchanged on copy. Heroes use available/requested/registered states; one registered hero per member.
- World commands: `world.configure {rules?,lore?,secretLore?,items?,nodes?,npcBehaviors?}`, `world.start`, `intent.save {intent}`, `intent.delete {id}`, `turn.end`, `turn.withdraw`, `intent.review {intentId,approve}` (human GM), `round.settle` (human GM/co-create), `round.start`, `growth.spend {actorId,trackId,target,points}`. AI ordinary actions execute through owner-confirmed packet steps.
- Governance: `draft.save {draft:{id?,kind,title,payload}}`, `draft.delete {id}`, `proposal.submit {draftId}`, `vote.cast {proposalId,vote}`, `vote.preference {value}`, `proposal.decide {proposalId,approve}`, `governance.grant {memberId,capabilities}`. Drafts may be partial; publication is strict. Ballot electorate is frozen at opening; approved changes apply at the next round.
- POST `/api/assets` `{dataUrl}` -> `{id,url,mime,bytes}`. PNG/JPEG/WebP/GIF, maximum 4 MiB decoded. GET `/api/assets/:id` requires session and uploader/owner/currently-visible reference authorization. Full campaign exports contain image bytes with hashes; restore is transactional.
- POST `/api/ai/export` `{kind:'initialize'|'player_selection'|'turn_context'|'roll_results',exchangeId?}` -> `{packet,schema,prompt}`. Owner-only. Persisted exchange receipt increments state revision but not gameplay revision. `turn_context` waits for online frozen participants to finish.
- POST `/api/ai/preview` `{packet}` -> `{valid,errors,summary,packet?}`; pure validation without consuming random dice.
- `ai.configure {diceSource:'program'|'ai'}` and `ai.apply {packet}` run through `/api/command` with the standard operation ID/version envelope. Import is atomic and decision IDs are persistent and idempotent. See [AI protocol](docs/AI_PROTOCOL.md) and [world semantics](docs/WORLD_MODES.md).

All commands use `Command {operationId,expectedRev,type,actorId?,targetIds?,payload?}`. Repeating an operation ID requires byte-equivalent command content. Stale versions return `409 stale_revision` with a new snapshot; definite character-claim conflicts reject without trapping the client queue. Unknown ACK outcomes retain the original ID.

## Native/legacy contract

All API paths are same-origin. HttpOnly cookie sessions; mutations validate Origin and JSON. Browser sends `X-Jige-Request: 1`.

- GET `/api/health`: `{ok:true,version,serverId}`.
- POST `/api/campaigns` `{name,gmName,hostToken}` -> snapshot plus `{recoveryCode}`. Host token is generated by server, printed locally and passed to local UI via URL fragment. Never infer GM from loopback IP.
- POST `/api/join` `{inviteCode,name}` -> snapshot plus `{recoveryCode}`.
- POST `/api/recover` `{recoveryCode}` -> snapshot.
- POST `/api/logout` -> `{ok:true}`.
- GET `/api/state` -> `Snapshot` from shared/model.ts. GM sees inviteCode; player projection removes hidden actors, secret events and choices for other users.
- GET `/api/content` -> `{entries:ContentEntry[],source,coverage}` (locally bundled; no runtime external dependency).
- POST `/api/command` -> `{snapshot:Snapshot,events:ResultEvent[],duplicate?:boolean}`; body `Command`. Stale expectedRev returns 409 plus snapshot. Failed validation does not change state or spend resources.
- POST `/api/migrate` `{payload:unknown}` -> `{snapshot,report:MigrationReport}`. Copy-only and transactional.
- GET `/api/export` -> complete campaign backup for GM; own actor export for players.
- POST `/api/restore` `{backup}` -> GM-only validated transactional restore.
- GET `/api/host` -> local host-token-authenticated tunnel status. Launcher injects exact active public origin internally, never through a public management endpoint.
- `/ws` authenticated WebSocket sends `{type:'snapshot',snapshot}` on committed changes and `{type:'ping'}` heartbeat. Browser responds `{type:'pong'}`. Full snapshots are acceptable for this local 12-person system; event sequence remains persisted.

Commands: `actor.create` (payload actor draft/build fields), `actor.update` (payload patch), `actor.delete`, `actor.levelup`, `inventory.add`, `inventory.equip`, `inventory.consume`, `combat.start`, `combat.next`, `combat.end`, `action.use` (payload actionId,slotLevel,advantage,origin/options), `actor.move` (payload path array of grid positions), `actor.rest` (payload kind short/long,hitDice), `actor.deathSave`, `effect.add`, `effect.remove`, `gm.adjust` (payload hp/temp/resource/condition changes), `gm.pause`, `gm.undo`, `scene.update`, `choice.resolve`. GM-only commands and ownership checked server-side; engine does not authorize member roles.

Manual roll circumstances are GM-only. Player action/item commands may omit `advantage`/`saveAdvantage` or send numeric zero; nonzero claims in the payload or its `options` return 403. They cannot submit `saveAbility` to choose a victim's grapple/shove saving throw. The engine derives rule-based advantage and defender saves; the GM may execute a character command with a manual ruling. Rejected claims change no state and spend no resources.

GM source-statblock companions use `actor.create` payload `{kind:'companion',monsterId,choices:{parentActorId}}`. The parent must be an active Hero in the same campaign; its member and team determine companion control and allegiance. Ordinary `monster` actors remain GM-controlled. Only the GM can rematch an existing companion (including a migrated draft) with `actor.update` payload `{patch:{monsterId,choices:{parentActorId}}}` outside combat. Rematching activates the official statblock while preserving the actor ID, portrait, notes and migration provenance; it replaces legacy combat numbers. The engine never treats player-supplied `monsterId` as a build choice. Remove a dependent companion before deleting its parent Hero.

GM-only `inventory.component` uses `actorId` and payload `{spellId,quantity}` to record complete packets of the published priced or consumed materials actually acquired. It grants no arbitrary currency substitution and does not debit GP: the GM confirms the world acquisition. `componentFor` is server-owned and bound to the exact spell. Normal casts, including storing a spell in a Ring, use existing qualifying material inventory and atomically consume one packet when required. Releasing an item spell requires no materials. Bless accepts a reusable published Holy Symbol worth at least 5 GP, while an ordinary Component Pouch cannot replace this priced requirement. Optional `action.use` `options.componentItemId` selects an existing legal lot; invalid, missing or depleted materials spend no spell slot, action or inventory. Command retries never grant or consume twice.

`gm.poisonExposure` is GM-only: `actorId` identifies the actor holding a dose, `payload.itemId` selects that inventory dose and `targetIds` identifies the creature whose contact/ingestion/inhalation the GM confirms. Injury poisons used by players coat a real Piercing/Slashing weapon and trigger only on a subsequent damaging hit. Character-build `choices.startingEquipment` selects published class/background package A/B/C and optional nested equipment-category choices; inventory, gold, charge state, stored caster values and one-time grant markers remain server-owned.

`gm.itemTiming` is GM-only with `payload.occasion: 'dawn' | 'day' | 'midnight'`. Dawn recharges eligible items, day confirms a full 24-hour interval for poison progression and item/poison expiration, and midnight resolves latent poisons. This explicit world-timing input is logged, idempotent and undoable through the command ledger. An ordinary player Long Rest does not trigger dawn recharge.

`inventory.component` is GM-only with `actorId` and `payload: {spellId,quantity}`. It records the complete published priced/consumed materials that the GM confirms have actually been obtained; it does not purchase them or substitute coins. The inventory lot has `componentFor: 'spell:…'`. Casting validates that exact spell's requirement and consumes one lot unit when required. A real 5 GP Holy Symbol also satisfies Bless and is retained. Items cast without components; a normal spell cast into a Ring of Spell Storing pays its components when stored. Mixed reusable/consumed requirements without their own adapter remain blocked.

GM `actor.create` may use `{kind:'companion',monsterId,choices:{parentActorId}}` for a published stat block. Ownership and team come from an active hero in the current campaign. GM `actor.update` may rematch an existing companion outside combat with `{patch:{monsterId,choices:{parentActorId}}}`; actor ID, name, portrait, notes and migration provenance are retained. A player cannot submit a stat block to bypass character creation.

Migration version 3 rejects malformed character records, embedded companions or raw JSON as a whole batch. Canonically assigned IDs avoid long legacy-ID collisions; original input and old-to-new mapping remain in the report. A previously imported source fingerprint continues returning its existing report rather than producing duplicate cards.

Request limits are measured in UTF-8 bytes: 64 MiB for migration/restore, 12 MiB for commands and 16 KiB for identity endpoints. Large archive routes authenticate and check role, Origin and rate before parsing the archive. A repeated operation ID must carry the exact original command; it returns the committed result before revision validation, so retrying a lost acknowledgement cannot repeat dice or costs. Reaction continuations are JSON data in the authoritative state and survive restarts.

Engine exports from `src/engine/index.ts`: `createActor(input)`, `deriveActor(actor)`, `createGameState(name)`, `resolveCommand(state,command,dice)`, `validateActor(actor)`, `rollExpression(expression,dice,critical?)`, `migrateLegacy(payload,fingerprint)`, `projectState(state,member)`, `createMonster(contentId,ownerId)`. `src/content/index.ts` exports `entries`, `getEntry(id)`, `coverage`. If implementation needs to refine a signature, notify other workers before changing it.
