import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createVerify} from 'node:crypto';
import {appJWT,appToken,redact} from '../src/auth.mjs';
test('GitHub App JWT is signed and bounded to ten minutes',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwt=appJWT('123',privateKey,1000000),parts=jwt.split('.');
  const claims=JSON.parse(Buffer.from(parts[1],'base64url'));
  assert.equal(claims.iss,'123');assert.equal(claims.exp-claims.iat,600);
  assert.equal(createVerify('RSA-SHA256').update(parts.slice(0,2).join('.')).verify(publicKey,parts[2],'base64url'),true);
});
test('redaction removes raw and git HTTP encoded tokens',()=>{
  const token='gh-secret';const encoded=Buffer.from('x-access-token:'+token).toString('base64');
  assert.equal(redact(`${token} ${encoded}`,[token]),'[redacted] [redacted]');
});

test('workflow writes use existing App grants while attachment tokens remain read-only',async()=>{
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const previous=global.fetch;const bodies=[];
  try {
    global.fetch=async(url,options)=>url.endsWith('/installation')?Response.json({id:1,permissions:{contents:'write',workflows:'write'}}):(bodies.push(JSON.parse(options.body)),Response.json({token:'test'}));
    await appToken('https://api.github.com','org/repo','1',privateKey);
    assert.equal(bodies[0].permissions.workflows,'write');
    await appToken('https://api.github.com','org/assets','1',privateKey,{contents:'read'});
    assert.deepEqual(bodies[1].permissions,{contents:'read'});
    global.fetch=async(url,options)=>url.endsWith('/installation')?Response.json({id:1,permissions:{contents:'write'}}):(bodies.push(JSON.parse(options.body)),Response.json({token:'test'}));
    await appToken('https://api.github.com','org/repo','1',privateKey);
    assert.equal(bodies[2].permissions.workflows,undefined);
  }finally {global.fetch=previous;}
});
