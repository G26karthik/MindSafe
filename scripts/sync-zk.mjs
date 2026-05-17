import { cp, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const source = join(process.cwd(), 'contracts', 'managed', 'mindsafe')
const target = join(process.cwd(), 'public', 'zk', 'mindsafe')

const ensureDir = async (path) => {
  await mkdir(path, { recursive: true })
}

const copyDir = async (from, to) => {
  await ensureDir(to)
  await cp(from, to, { recursive: true })
}

try {
  await stat(source)
} catch {
  throw new Error(
    'Missing compiled contract. Run: npm run compact:compile before syncing ZK assets.',
  )
}

await ensureDir(target)
await copyDir(join(source, 'keys'), join(target, 'keys'))
await copyDir(join(source, 'zkir'), join(target, 'zkir'))

console.log('ZK assets synced to public/zk/mindsafe')
