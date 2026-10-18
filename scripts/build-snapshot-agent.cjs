const path = require('node:path')
const fs = require('node:fs/promises')
const root = path.resolve(__dirname, '..')
require('esbuild').build({
  entryPoints: [path.resolve(__dirname, 'capture-diary-snapshot.ts')],
  outfile: path.join(root, 'local-tools/diary-snapshot-agent.cjs'),
  write: false,
  platform: 'node', format: 'cjs', bundle: true, external: ['electron', 'koffi']
}).then(async result => {
  for (const directory of ['local-tools', 'dist-electron']) {
    const destination = path.join(root, directory)
    await fs.mkdir(destination, { recursive: true })
    await fs.writeFile(path.join(destination, directory === 'local-tools' ? 'diary-snapshot-agent.cjs' : 'diary-agent.cjs'), result.outputFiles[0].contents)
    await fs.copyFile(path.join(__dirname, 'Read-WorkflowOcr.ps1'), path.join(destination, 'diary-workflow-ocr.ps1'))
  }
  await fs.copyFile(path.join(root, 'electron/bootstrap.cjs'), path.join(root, 'dist-electron/bootstrap.cjs'))
})
  .catch(error => { console.error(error.message); process.exitCode = 1 })
