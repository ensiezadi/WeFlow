// Repair the archived Windows x64 component's fixed 2026-09-30 expiry.
// Keep the InitProtection UTC cutoff and wcdb_init calendar cutoff in sync.
// Only the known binary and the two date constants are accepted.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')
const originalHash = '6397760da70de8062829fbe6a2ec01cf0616d6f2b334e6fe54873898f38f7ad7'
const patches = [
  { offset: 0x80dbf, original: '483d7fa2bd6a', repaired: '483d7fcd6e7f', previous: '483dffffff7f' },
  { offset: 0xe8589, original: 'c744246c7e000000', repaired: 'c744246c89000000' }
].map(patch => ({ ...patch,
  original: Buffer.from(patch.original, 'hex'),
  repaired: Buffer.from(patch.repaired, 'hex'),
  previous: patch.previous && Buffer.from(patch.previous, 'hex')
}))
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

function repair(file) {
  const data = fs.readFileSync(file)
  const restored = Buffer.from(data)
  let alreadyRepaired = true
  for (const patch of patches) {
    const instruction = data.subarray(patch.offset, patch.offset + patch.original.length)
    if (!instruction.equals(patch.original) && !instruction.equals(patch.repaired) &&
        !(patch.previous && instruction.equals(patch.previous))) {
      throw new Error(`Unexpected WCDB date instruction: ${file}`)
    }
    alreadyRepaired &&= instruction.equals(patch.repaired)
    patch.original.copy(restored, patch.offset)
  }
  if (sha256(restored) !== originalHash) {
    throw new Error(`Unrecognized WCDB component; refusing to modify: ${file}`)
  }
  if (alreadyRepaired) {
    console.log(`WCDB date repair already applied: ${file}`)
    return
  }
  const backupDir = path.join(root, 'logs', 'native-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const backup = path.join(backupDir, `wcdb_api-${originalHash}.dll`)
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, restored, { flag: 'wx' })
  if (sha256(fs.readFileSync(backup)) !== originalHash) throw new Error('WCDB backup checksum mismatch')
  for (const patch of patches) patch.repaired.copy(data, patch.offset)
  fs.writeFileSync(file, data)
  console.log(`WCDB date cutoffs extended to 2037-09-30: ${file}`)
  console.log(`Original component backup: ${backup}`)
}

const targets = [
  path.join(root, 'resources', 'wcdb', 'win32', 'x64', 'wcdb_api.dll'),
  path.join(root, 'release', 'win-unpacked', 'resources', 'resources', 'wcdb', 'win32', 'x64', 'wcdb_api.dll')
]
const selectedTargets = process.argv.includes('--packaged-only') ? targets.slice(1) : process.argv.includes('--source-only') ? targets.slice(0, 1) : targets
for (const file of selectedTargets) {
  if (fs.existsSync(file)) repair(file)
}
