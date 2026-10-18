// Route agent launches before normal app initialization or its single-instance lock.
if (require('../package.json').localBuild) process.env.AUTO_UPDATE_ENABLED = 'false'
if (process.argv.includes('--diary-agent')) require('./diary-agent.cjs')
else require('./main.js')
