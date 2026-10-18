export function snapshotLaunchArguments(packaged: boolean, agentFile: string, root: string, mode: 'watch' | 'manual', ownerPid?: number) {
  const args = packaged ? ['--diary-agent'] : [agentFile]
  args.push('--root', root, mode === 'watch' ? '--watch' : '--manual')
  if (mode === 'watch' && ownerPid !== undefined) args.push('--owner-pid', String(ownerPid))
  return args
}
