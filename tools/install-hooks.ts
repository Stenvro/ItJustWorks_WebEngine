// Points git at the repository's hooks (.githooks: the game-file check before every commit).
// Run by `npm install`; outside a git checkout (a downloaded archive) there is nothing to do.

import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
if (result.status !== 0) console.log('Not a git checkout: the git hooks are not installed.');
