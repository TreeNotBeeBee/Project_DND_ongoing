import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor,createMonster} from '../src/engine/index.ts';
import {creatureSizeRank,canGrappleSize,canPushWithMastery,tokenFootprint} from '../src/engine/size.ts';
test('published monster size, rather than a default one-cell token, governs Grapple and Push',()=>{
  const hero=createActor({speciesId:'human'}),dragon=createMonster('ancient-red-dragon','gm'),ogre=createMonster('ogre','gm');
  assert.equal(creatureSizeRank(dragon),5);assert.equal(canGrappleSize(hero,dragon),false);assert.equal(canPushWithMastery(dragon),false);
  assert.equal(canGrappleSize(hero,ogre),true);assert.equal(canPushWithMastery(ogre),true);assert.equal(tokenFootprint(ogre),2);
});
test('Tiny and Small have distinct rule ranks even when UI tokens use a shared grid cell',()=>{
  const rat=createMonster('rat','gm'),gnome=createActor({speciesId:'gnome'}),human=createActor({speciesId:'human'});
  assert.equal(creatureSizeRank(rat),0);assert.equal(creatureSizeRank(gnome),1);assert.equal(creatureSizeRank(human),2);
  assert.equal(canGrappleSize(rat,gnome),true);assert.equal(canGrappleSize(rat,human),false);
});
test('size effects are clamped and repeated enlargement does not stack',()=>{
  const actor=createActor({speciesId:'human'});actor.effects=[{id:'a',name:'Enlarge',modifiers:{sizeDelta:1}},{id:'b',name:'Enlarge',modifiers:{sizeDelta:1}}];
  assert.equal(creatureSizeRank(actor),3);actor.effects.push({id:'c',name:'Reduce',modifiers:{sizeDelta:-1}});assert.equal(creatureSizeRank(actor),2);
});
