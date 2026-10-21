import fs from 'node:fs';

fs.writeFileSync('dist-cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
