import {createSign} from 'node:crypto';
import {API} from './api.mjs';
export function appJWT(appId,privateKey,now=Date.now()) {
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const time=Math.floor(now/1000);
  const payload=`${encode({alg:'RS256',typ:'JWT'})}.${encode({iat:time-60,exp:time+540,iss:String(appId)})}`;
  return `${payload}.${createSign('RSA-SHA256').update(payload).sign(privateKey,'base64url')}`;
}
export async function appToken(apiUrl,repo,appId,privateKey) {
  const app=new API(apiUrl,appJWT(appId,privateKey));
  const installation=await app.json(`/repos/${repo}/installation`);
  return app.json(`/app/installations/${installation.id}/access_tokens`,{method:'POST',body:{repositories:[repo.split('/')[1]],permissions:{contents:'write',issues:'write',pull_requests:'write'}}});
}
export function redact(text,secrets) {
  let safe=String(text);
  for(const secret of secrets.filter(Boolean)) {
    safe=safe.split(secret).join('[redacted]');
    safe=safe.split(Buffer.from(`x-access-token:${secret}`).toString('base64')).join('[redacted]');
  }
  return safe;
}
