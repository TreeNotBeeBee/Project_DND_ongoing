import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../src/server/app.ts';

test('real malformed account import changes no campaign, migration or operation rows',async()=>{
  const prefix=join(tmpdir(),'jige-import-atomic-'),directory=await mkdtemp(prefix);
  const runtime=await createApplication({dataDir:directory,hostToken:'isolated-test-only'});
  try{
    const address=await runtime.listen(0),origin='http://localhost:'+address.port;
    const headers={Origin:origin,'Content-Type':'application/json','X-Jige-Request':'1'};
    const opened=await fetch(origin+'/api/campaigns',{method:'POST',headers,body:JSON.stringify({name:'Atomic import',gmName:'Test GM',hostToken:'isolated-test-only'})});
    assert.equal(opened.status,201);const cookie=opened.headers.get('set-cookie')!.split(';')[0],before=await opened.json() as any;
    for(const payload of [{characters:{good:{name:'Valid'},bad:null}},{characters:{good:{name:'Valid',companions:[42]}}},{format:'jigerpg-raw-backup',rawStorage:{jigerpg_char_valid:'{"name":"Valid"}',jigerpg_char_bad:'{broken'}}]){
      const failed=await fetch(origin+'/api/migrate',{method:'POST',headers:{...headers,Cookie:cookie},body:JSON.stringify({payload})});
      assert.equal(failed.status,400);assert.equal((await failed.json() as any).code,'INVALID_IMPORT');
      const snapshot=await (await fetch(origin+'/api/state',{headers:{Cookie:cookie}})).json() as any;
      assert.deepEqual(snapshot.state,before.state);
      assert.equal((runtime.db.prepare('SELECT count(*) AS n FROM migrations').get() as any).n,0);
      assert.equal((runtime.db.prepare('SELECT count(*) AS n FROM operations').get() as any).n,0);
    }
  }finally{await runtime.close();assert.ok(directory.startsWith(prefix));await rm(directory,{recursive:true,force:true});}
});
