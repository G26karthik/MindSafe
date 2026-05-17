import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider'
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { submitCallTx } from '@midnight-ntwrk/midnight-js/contracts'
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js/types'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { CostModel, Transaction } from '@midnight-ntwrk/ledger-v8'
import { Contract } from '../../contracts/managed/mindsafe/contract'
import { clearScreeningInput, setScreeningInput, witnesses } from '../../contracts/witnesses'
import { firstValueFrom, timeout, tap, filter, catchError, of } from 'rxjs'

type ScreeningInput = {
  score: number
}

type MintResult = {
  resultCategory: string
  recommendation: string
  proofHash: string
  timestamp: string
  txId?: string
}

export async function mintProof(input: ScreeningInput): Promise<MintResult> {
  // Call this before anything else
  const networkId = import.meta.env.VITE_MIDNIGHT_NETWORK || 'preview'
  setNetworkId(networkId)

  // Pre-flight check for the local proof server
  try {
    const health = await fetch('http://127.0.0.1:6300/health')
    if (!health.ok) throw new Error()
  } catch (e) {
    throw new Error('Proof server not running. Start it with: docker run -p 6300:6300 midnightntwrk/proof-server:latest')
  }

  const contractAddress = import.meta.env.VITE_CONTRACT_ADDRESS
  if (!contractAddress) {
    throw new Error('Missing VITE_CONTRACT_ADDRESS')
  }

  const api = await connectWallet()
  const config = await api.getConfiguration()
  const shielded = await api.getShieldedAddresses()

  const zkBase = import.meta.env.VITE_ZK_ASSET_BASE || '/zk/mindsafe'
  const zkConfigProvider = new FetchZkConfigProvider(
    new URL(zkBase, window.location.origin).toString(),
    window.fetch.bind(window),
  )

  const provingServerUrl = import.meta.env.VITE_PROOF_SERVER_URL || 'http://127.0.0.1:6300'
  const proofProvider = httpClientProofProvider(provingServerUrl, zkConfigProvider)

  const walletProvider: WalletProvider = {
    getCoinPublicKey: () => shielded.shieldedCoinPublicKey ?? '',
    getEncryptionPublicKey: () => shielded.shieldedEncryptionPublicKey ?? '',
    balanceTx: async (tx: any) => {
      const txHex = toHex(tx.serialize())
      const balanced = await api.balanceUnsealedTransaction(txHex)
      if (!balanced?.tx) throw new Error('balanceUnsealedTransaction failed')
      return Transaction.deserialize('signature', 'proof', 'binding', fromHex(balanced.tx))
    },
  }

  const midnightProvider: MidnightProvider = {
    submitTx: async (tx: any) => {
      const txHex = toHex(tx.serialize())
      const result = await api.submitTransaction(txHex)
      if (typeof result === 'string' && result) return result
      if (result?.transactionId) return result.transactionId
      if (result?.id) return result.id
      return txHex.slice(0, 64)
    },
  }

  const providers = {
    privateStateProvider: createPrivateStateProvider(),
    publicDataProvider: indexerPublicDataProvider(config.indexerUri, config.indexerWsUri),
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
  }

  providers.privateStateProvider.setContractAddress(contractAddress)

  const compiledContract = CompiledContract.make('mindsafe', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    // FetchZkConfigProvider handles ZK asset fetching via the browser fetch API.
    // withCompiledFileAssets() expects a Node.js filesystem path — do not pass
    // a URL string like '/zk/mindsafe' here.
  )

  const normalizedScore = normalizeScore(input.score)
  const timestamp = BigInt(Date.now())

  // Set witness BEFORE the try block so clearScreeningInput() in finally
  // always fires even if submitCallTx internal setup throws.
  setScreeningInput({
    severityScore: BigInt(normalizedScore), // explicit bigint — required by the ZK circuit
  })

  console.log(
    '[MindSafe] witness set — severityScore:',
    BigInt(normalizedScore).toString(),
    '| timestamp:',
    timestamp.toString(),
  )

  // Contract instance bound with witnesses (matches compiled contract constructor)
  const transactionContext = new Contract(witnesses)

  try {
    // Run to natural completion without timeout
    const callResult: any = await submitCallTx(providers as any, {
      compiledContract,
      contractAddress,
      circuitId: 'submitScreening',
      args: [timestamp],
    }, transactionContext)

    // Await transaction confirmation to prevent UI hang, with 60s timeout
    if (callResult?.tx$) {
      console.log('[MindSafe] Subscribing to transaction status observable...')
      await firstValueFrom(
        callResult.tx$.pipe(
          tap((status: any) => console.log('[MindSafe] Tx status:', status?.status ?? status)),
          filter((status: any) => {
            const s = status?.status || status
            return s === 'confirmed' || s === 'included' || s === 'failed' || s === 'rejected'
          }),
          timeout(60_000),
          catchError((err) => {
            console.warn('[MindSafe] Transaction status timeout or error, proceeding with immediate data:', err)
            return of(null)
          })
        )
      )
    }

    const extracted = extractProofOutput(callResult)

    // Immediate fallback: build the proof object from what we already know
    return {
      resultCategory: extracted?.resultCategory ?? mapCategory(Number(normalizedScore)),
      recommendation: extracted?.recommendation ?? mapRecommendation(Number(normalizedScore)),
      proofHash: extracted?.proofHash ?? 'pending',
      timestamp: extracted?.timestamp ?? timestamp.toString(),
      txId: callResult?.public?.txId ?? callResult?.public?.txHash ?? callResult?.txId ?? callResult?.txHash ?? 'pending',
    }
  } finally {
    clearScreeningInput()
  }
}

function normalizeScore(score: number): bigint {
  const rounded = Math.round(score)
  const clamped = Math.max(0, Math.min(100, rounded))
  return BigInt(clamped)
}

function mapCategory(score: number) {
  if (score < 7) return 'mild'
  if (score < 14) return 'moderate'
  return 'severe'
}

function mapRecommendation(score: number) {
  if (score < 7) return 'Self-guided care and regular check-ins.'
  if (score < 14) return 'Consider talking with a licensed professional.'
  return 'Seek urgent support or reach out to a crisis service now.'
}

type ProofOutput = {
  resultCategory?: string
  recommendation?: string
  timestamp?: string
  proofHash?: string
}

function extractProofOutput(callResult: any): ProofOutput | null {
  const value = callResult?.public?.returnValue ?? callResult?.public?.output ?? null
  if (!value) return null

  if (Array.isArray(value)) {
    const [categoryRaw, recommendationRaw, timestampRaw, proofRaw] = value
    return {
      resultCategory: mapCategoryFromEnum(categoryRaw),
      recommendation: mapRecommendationFromEnum(recommendationRaw),
      timestamp: normalizeTimestamp(timestampRaw),
      proofHash: toHexOrString(proofRaw),
    }
  }

  return {
    resultCategory: mapCategoryFromEnum(value?.resultCategory ?? value?.category),
    recommendation: mapRecommendationFromEnum(value?.recommendation),
    timestamp: normalizeTimestamp(value?.timestamp),
    proofHash: value?.proofHash ? toHexOrString(value.proofHash) : toHexOrString(value),
  }
}

function mapCategoryFromEnum(value: any): string | undefined {
  const index = normalizeEnumIndex(value, ['MILD', 'MODERATE', 'SEVERE'])
  if (index === null) return undefined
  return ['mild', 'moderate', 'severe'][index]
}

function mapRecommendationFromEnum(value: any): string | undefined {
  const index = normalizeEnumIndex(value, ['SELF_CARE', 'TALK_TO_PRO', 'URGENT'])
  if (index === null) return undefined
  return [
    'Self-guided care and regular check-ins.',
    'Consider talking with a licensed professional.',
    'Seek urgent support or reach out to a crisis service now.',
  ][index]
}

function normalizeEnumIndex(value: any, labels: string[]): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 && value < labels.length ? value : null
  }
  if (typeof value === 'bigint') {
    const index = Number(value)
    return index >= 0 && index < labels.length ? index : null
  }
  if (typeof value === 'string') {
    const upper = value.toUpperCase()
    const match = labels.findIndex((label) => upper.includes(label))
    if (match >= 0) return match
    const parsed = Number(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  if (typeof value === 'object' && value && 'variant' in value) {
    const index = Number((value as { variant: unknown }).variant)
    if (!Number.isNaN(index)) return index
  }
  return null
}

function normalizeTimestamp(value: any): string | undefined {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value).toString()
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return toHex(value)
  return value?.toString ? value.toString() : undefined
}

async function connectWallet(): Promise<any> {
  const wallet = await detectWallet()
  if (!wallet) {
    throw new Error('1AM wallet not detected')
  }
  const network = import.meta.env.VITE_MIDNIGHT_NETWORK || 'preview'
  return wallet.connect(network)
}

export async function connectToWallet(): Promise<{ api: any; config: any; shielded: any }> {
  const api = await connectWallet()
  const config = await api.getConfiguration()

  // Wait for shielded addresses to be available (wallet may be syncing)
  const maxAttempts = 60 // ~30s with 500ms interval
  const intervalMs = 500
  let attempts = 0
  let shielded: any = null
  while (attempts < maxAttempts) {
    try {
      // Some wallet implementations throw until synced; guard with try/catch
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      shielded = await api.getShieldedAddresses()
      if (shielded && (shielded.shieldedCoinPublicKey || shielded.shieldedEncryptionPublicKey)) {
        break
      }
    } catch (e) {
      // ignore and retry
    }
    // wait
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs))
    attempts++
  }

  if (!shielded || (!shielded.shieldedCoinPublicKey && !shielded.shieldedEncryptionPublicKey)) {
    throw new Error('Wallet is syncing — shielded address not yet available')
  }

  return { api, config, shielded }
}

async function detectWallet(): Promise<any | null> {
  return new Promise((resolve) => {
    let attempts = 0
    const check = () => {
      const found = (window as any).midnight?.['1am'] ?? (window as any).midnight?.mnLace
      if (found) {
        resolve(found)
        return
      }
      if (++attempts > 60) {
        resolve(null)
        return
      }
      setTimeout(check, 100)
    }
    check()
  })
}

function createPrivateStateProvider() {
  let scope = ''
  const stateStore = new Map<string, unknown>()
  const signingKeyStore = new Map<string, unknown>()
  const key = (id: string) => `${scope}:${id}`

  return {
    setContractAddress(address: string) {
      scope = address
    },
    async set(id: string, state: unknown) {
      stateStore.set(key(id), state)
    },
    async get(id: string) {
      return stateStore.get(key(id)) ?? null
    },
    async remove(id: string) {
      stateStore.delete(key(id))
    },
    async clear() {
      stateStore.clear()
    },
    async setSigningKey(addr: string, k: unknown) {
      signingKeyStore.set(addr, k)
    },
    async getSigningKey(addr: string) {
      return signingKeyStore.get(addr) ?? null
    },
    async removeSigningKey(addr: string) {
      signingKeyStore.delete(addr)
    },
    async clearSigningKeys() {
      signingKeyStore.clear()
    },
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex
  if (normalized.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(normalized.length / 2)
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = parseInt(normalized.slice(i, i + 2), 16)
  }
  return bytes
}

function toHexOrString(value: any): string {
  if (!value) return 'pending'
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return toHex(value)
  if (Array.isArray(value)) return value.map(toHexOrString).join('')
  return String(value)
}
