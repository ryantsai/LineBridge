import test from 'node:test';
import assert from 'node:assert/strict';
import {directLocalRequest} from '../server/local-access.mjs';

const req=(headers={},remoteAddress='127.0.0.1')=>({socket:{remoteAddress},headers:{host:'127.0.0.1:3211',...headers}});
test('local trust needs a direct loopback peer, local Host and direct-local configuration',()=>{
  assert.equal(directLocalRequest(req(),3211,'local'),true);
  assert.equal(directLocalRequest(req({'sec-fetch-mode':'cors'}),3211,'local'),true);
  assert.equal(directLocalRequest(req({host:'localhost:3211'},'::ffff:127.0.0.1'),3211,'local'),true);
  for(const peer of ['203.0.113.9','10.0.0.2',undefined])assert.equal(directLocalRequest(req({},peer===undefined?null:peer),3211,'local'),false);
  for(const host of ['attacker.example','line.example.com','localhost:3210'])assert.equal(directLocalRequest(req({host}),3211,'local'),false);
  for(const provider of ['cloudflare','cloudflare_quick','tailscale',undefined])assert.equal(directLocalRequest(req(),3211,provider),false);
  assert.equal(directLocalRequest(req(),3211,'local',true),false);
});
test('browser and proxy metadata never receives local trust, even with a localhost Host',()=>{
  for(const name of ['origin','referer','sec-fetch-site','sec-fetch-mode','sec-fetch-dest','forwarded','via','true-client-ip','x-real-ip','x-original-host','x-original-url','x-forwarded-for','x-forwarded-host','x-forwarded-proto','cf-connecting-ip','cf-access-jwt-assertion','cf-ray']){
    assert.equal(directLocalRequest(req({[name]:'untrusted'}),3211,'local'),false,name);
  }
});
