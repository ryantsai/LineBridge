import test from 'node:test';
import assert from 'node:assert/strict';
import {sendIntent} from '../public/send-intent.js';
test('a retry keeps its key; changing text, account or chat uses a new key',()=>{
  let counter=0;const key=()=>`key-${++counter}`;
  const first=sendIntent(null,'account','chat','first',key);
  assert.equal(sendIntent(first,'account','chat','first',key),first);
  const changed=sendIntent(first,'account','chat','second',key);assert.notEqual(changed.key,first.key);
  assert.notEqual(sendIntent(changed,'account','other-chat','second',key).key,changed.key);
  assert.notEqual(sendIntent(changed,'other-account','chat','second',key).key,changed.key);
});
