import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Resolver} from 'node:dns/promises';
import assert from 'node:assert/strict';
export function nativeFetch(request,hostname,options={}){
  return async(input,init={})=>{
    const original=input instanceof Request?input:null,url=new URL(original?original.url:input);assert.equal(url.hostname,hostname);
    const headers=Object.fromEntries(new Headers(init.headers??original?.headers));if(options.hostHeader)headers.host=options.hostHeader;
    const body=init.body??(original?.body?await original.arrayBuffer():null);
    return new Promise((resolve,reject)=>{const req=request(url,{method:init.method??original?.method??'GET',headers,signal:init.signal??original?.signal,...(options.lookup?{lookup:options.lookup}:{})},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('error',reject);res.on('end',()=>resolve(new Response([204,205,304].includes(res.statusCode)?null:Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);if(body)req.write(typeof body==='string'?body:Buffer.from(body));req.end();});
  };
}
export const forwardFetch=port=>nativeFetch(httpRequest,'127.0.0.1',{hostHeader:`127.0.0.1:${port}`});
export async function publicFetch(hostname){
  const resolver=new Resolver();resolver.setServers(['1.1.1.1']);const [address]=await resolver.resolve4(hostname);assert.ok(address);
  return nativeFetch(httpsRequest,hostname,{lookup:(_host,opts,cb)=>cb(null,opts.all?[{address,family:4}]:address,4)});
}
