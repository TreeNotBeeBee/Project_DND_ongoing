import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor,createMonster,createGameState,resolveCommand} from '../src/engine/index.ts';
import {tokenSideCells,tokenCells,footprintsOverlap,actorDistance,tokenCentre} from '../src/engine/spatial.ts';
import {pathCost,validateTokenPosition} from '../src/engine/map.ts';
const large=()=>createMonster('brown-bear','gm');
test('source Large and Huge creatures occupy complete squares and distance uses their nearest occupied cells',()=>{
  const bear=large(),elephant=createMonster('elephant','gm'),hero=createActor({draft:false,position:{x:2,y:0}});bear.position={x:0,y:0};
  assert.equal(tokenSideCells(bear),2);assert.equal(tokenCells(bear).length,4);assert.equal(tokenSideCells(elephant),3);
  assert.equal(actorDistance(bear,hero),5);assert.deepEqual(tokenCentre(bear),{x:0.5,y:0.5});
  assert.equal(footprintsOverlap(bear,hero),false);hero.position={x:1,y:1};assert.equal(footprintsOverlap(bear,hero),true);
});
test('large movement cannot clip the map boundary or overlap a creature in a non-anchor cell',()=>{
  const bear=large(),other=createActor({draft:false,position:{x:2,y:1}}),scene=createGameState('Space').scene;bear.position={x:0,y:0};
  assert.throws(()=>pathCost(scene,bear,[{x:1,y:0}],[bear,other]),{code:'OCCUPIED'});
  assert.throws(()=>validateTokenPosition(scene,bear,{x:scene.width-1,y:0}),{code:'TOKEN_BOUNDS'});
  assert.equal(pathCost(scene,bear,[{x:0,y:1}],[bear]),5);
  other.draft=true;assert.equal(pathCost(scene,bear,[{x:1,y:0}],[bear,other]),5);
});
test('every occupied cell respects walls, doors and difficult terrain rather than only the anchor',()=>{
  const bear=large(),scene=createGameState('Walls').scene;bear.position={x:0,y:0};
  scene.walls=[{id:'door',a:{x:2,y:0},b:{x:2,y:2},door:true,open:false}];
  assert.throws(()=>pathCost(scene,bear,[{x:1,y:0}],[bear]),{code:'WALL'});
  scene.walls[0].open=true;scene.terrain=[{id:'rubble',x:2,y:1,width:1,height:1,type:'difficult'}];
  assert.equal(pathCost(scene,bear,[{x:1,y:0}],[bear]),10);
  assert.equal(pathCost(scene,bear,[{x:1,y:0}],[bear],{crawling:true}),15);
});
test('footprints convert feet to a custom grid without changing their source creature size',()=>{
  const bear=large();assert.equal(tokenSideCells(bear,10),1);assert.equal(tokenSideCells(bear,5),2);
});

test('scene edits cannot crop or divide an already deployed footprint, and rejection leaves the scene unchanged',()=>{
  const state=createGameState('Safe edits'),bear=large();bear.position={x:4,y:0};state.actors=[bear];const original=structuredClone(state);
  const command={operationId:'scene-footprint',expectedRev:0,type:'scene.update'};
  assert.throws(()=>resolveCommand(state,{...command,payload:{scene:{...state.scene,width:5}}},()=>1),{code:'TOKEN_BOUNDS'});
  assert.throws(()=>resolveCommand(state,{...command,payload:{scene:{...state.scene,walls:[{id:'through-bear',a:{x:5,y:0},b:{x:5,y:2}}]}}},()=>1),{code:'WALL'});
  assert.deepEqual(state,original);
});
