# npm distribution

LineBridge 0.3 has one distribution: the headless `line-bridge` npm package with executable `linebridge`. Runtime requirement: Node.js 24+. SQLite uses `node:sqlite`; all application dependencies are portable JavaScript/WASM. There are no application native build steps, desktop installers or bundled Node/cloudflared binaries. The browser dashboard is included.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:smoke
npm run package
```

`release/npm/` receives `line-bridge-0.3.0.tgz`, `SHA256SUMS.txt` and `package-info.json`. Packaging validates the npm file list before and after packing. The archive includes only the CLI, server, private protocol worker, dashboard/assets, examples and documentation. It excludes account data, SQLite databases, vault keys, provider configuration, generated desktop files, build trees, developer tests and logs.

Install the archive using `npm install -g ./line-bridge-0.3.0.tgz`, then `linebridge serve --data-dir DIR`. Node and npm must already be installed. A user-owned prefix can avoid root access. Package installation performs no download/build/start lifecycle script. Runtime data is placed outside the installation directory.

The archive has **not been published to the npm registry**. Registry name `line-bridge` differs from the unrelated existing `linebridge` package; executable and product name remain LineBridge. Publication requires registry ownership, access and a separate release decision. Do not install an unrelated registry package by guessing its name.

CI validates Node 24/26 on Linux and Windows, runs the synthetic gateway smoke test and uploads the npm archive/checksum. The CI definition is provided; remote CI execution requires a repository remote. Local Linux checks use a checksum-verified official Node 24 runtime under Ubuntu WSL. An optional live Quick Tunnel test (`npm run test:tunnel`) requires separately installed cloudflared and uses synthetic accounts only.
