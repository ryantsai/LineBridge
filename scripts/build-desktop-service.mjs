import {join} from 'node:path';
import {root} from './packaging.mjs';
import {bundleApp} from './bundle-app.mjs';

await bundleApp(join(root,'runtime/app'),['server/desktop.mjs','protocol/worker.mjs','bin/linebridge.mjs']);
console.log('Desktop service and private LINE worker bundled with dependency notices.');
