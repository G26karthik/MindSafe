#!/usr/bin/env node

/**
 * MindSafe — Headless Contract Deployment Script
 *
 * Deploys the compiled MindSafe Compact contract to the Midnight preview testnet
 * using a headless HD wallet. No browser or 1AM extension required.
 *
 * Prerequisites:
 *   1. Compile the contract:  npm run compact:compile
 *   2. Fund your wallet with tNight from the faucet:
 *      https://faucet.preview.midnight.network/
 *   3. (Optional) Set WALLET_SEED in .env to restore an existing wallet.
 *      If not set, a fresh seed is generated and printed once.
 *
 * Usage:
 *   npm run deploy
 *
 * Environment variables (read from .env):
 *   WALLET_SEED           — hex-encoded HD wallet seed (optional; generated if missing)
 *   PROOF_SERVER_URL      — proof server URL (default: http://127.0.0.1:6300)
 *   VITE_MIDNIGHT_NETWORK — network ID (default: preview)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer } from 'buffer';

// ── Polyfill WebSocket for Node.js (required for GraphQL subscriptions) ─────
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

// ── Midnight SDK imports ────────────────────────────────────────────────────
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js/contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import * as Rx from 'rxjs';

// ── Resolve paths ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');

// ── Load .env (lightweight, no dotenv dependency) ───────────────────────────
function loadEnv() {
  const envPath = resolve(PROJECT_ROOT, '.env');
  const env = {};
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      env[key] = value;
    }
  }
  return env;
}

// ── Console helpers ─────────────────────────────────────────────────────────
const DIV = '──────────────────────────────────────────────────────────────';

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

async function withStatus(message, fn) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${message}`);
  }, 80);
  try {
    const result = await fn();
    clearInterval(interval);
    process.stdout.write(`\r  ✓ ${message}\n`);
    return result;
  } catch (e) {
    clearInterval(interval);
    process.stdout.write(`\r  ✗ ${message}\n`);
    throw e;
  }
}

// ── Network configuration ───────────────────────────────────────────────────
const NETWORKS = {
  preview: {
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'wss://rpc.preview.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
  },
  preprod: {
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
  },
};

// ── Main deploy flow ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${DIV}`);
  console.log('  MindSafe — Contract Deployment');
  console.log(DIV);

  // ── 1. Load configuration ──────────────────────────────────────────────
  const env = loadEnv();
  const networkId = env.VITE_MIDNIGHT_NETWORK || 'preview';
  const networkConfig = NETWORKS[networkId];
  if (!networkConfig) {
    throw new Error(`Unsupported network: ${networkId}. Use 'preview' or 'preprod'.`);
  }
  const proofServerUrl = env.PROOF_SERVER_URL || networkConfig.proofServer;

  setNetworkId(networkId);
  console.log(`  Network:      ${networkId}`);
  console.log(`  Indexer:      ${networkConfig.indexer}`);
  console.log(`  Node:         ${networkConfig.node}`);
  console.log(`  Proof Server: ${proofServerUrl}`);

  // ── 2. Verify compiled contract exists ─────────────────────────────────
  const contractPath = resolve(PROJECT_ROOT, 'contracts', 'managed', 'mindsafe');
  if (!existsSync(contractPath)) {
    console.error('\n  ✗ Compiled contract not found at:', contractPath);
    console.error('    Run: npm run compact:compile\n');
    process.exit(1);
  }

  // ── 3. Load compiled contract ──────────────────────────────────────────
  const { Contract } = await import(
    pathToFileURL(resolve(contractPath, 'contract', 'index.js')).href
  );

  // Witnesses inlined — Node.js cannot dynamically import .ts files.
  // This mirrors contracts/witnesses.ts but in plain JS.
  let pendingInput = null;
  const setScreeningInput = (input) => { pendingInput = input; };
  const clearScreeningInput = () => { pendingInput = null; };
  const witnesses = {
    severityScore() {
      return pendingInput?.severityScore ?? 0n;
    },
  };

  const compiledContract = CompiledContract.make('mindsafe', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(contractPath),
  );
  console.log('  ✓ Compiled contract loaded');

  // ── 4. Build HD wallet ─────────────────────────────────────────────────
  let seedHex = env.WALLET_SEED || '';
  if (!seedHex) {
    const seed = generateRandomSeed();
    seedHex = toHex(seed);
    console.log(`\n${DIV}`);
    console.log('  ⚠  New Wallet Seed — SAVE THIS before continuing!');
    console.log(DIV);
    console.log(`  ${seedHex}`);
    console.log(DIV);
  } else {
    console.log('  ✓ Restoring wallet from WALLET_SEED');
  }

  const { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore } =
    await withStatus('Building wallet', async () => {
      const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
      if (hdWallet.type !== 'seedOk') {
        throw new Error('Invalid WALLET_SEED — could not initialize HD wallet');
      }

      const derivationResult = hdWallet.hdWallet
        .selectAccount(0)
        .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
        .deriveKeysAt(0);

      if (derivationResult.type !== 'keysDerived') {
        throw new Error('HD key derivation failed');
      }

      hdWallet.hdWallet.clear();
      const keys = derivationResult.keys;

      const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
      const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
      const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

      const walletConfig = {
        networkId: getNetworkId(),
        indexerClientConnection: {
          indexerHttpUrl: networkConfig.indexer,
          indexerWsUrl: networkConfig.indexerWS,
        },
        provingServerUrl: new URL(proofServerUrl),
        relayURL: new URL(networkConfig.node),

        costParameters: {
          additionalFeeOverhead: 300_000_000_000_000n,
          feeBlocksMargin: 5,
        },
      };

      const wallet = await WalletFacade.init({
        configuration: walletConfig,
        shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
        unshielded: (cfg) =>
          UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
        dust: (cfg) =>
          DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
      });

      await wallet.start(shieldedSecretKeys, dustSecretKey);
      return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
    });

  // ── 5. Wait for wallet sync ────────────────────────────────────────────
  const syncedState = await withStatus('Syncing with network', () =>
    Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((state) => state.isSynced),
      ),
    ),
  );

  const unshieldedAddr = unshieldedKeystore.getBech32Address();
  const balance = syncedState.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`\n  Unshielded address: ${unshieldedAddr}`);
  console.log(`  Balance: ${balance.toLocaleString()} tNight`);

  // ── 6. Wait for funds if balance is zero ───────────────────────────────
  if (balance === 0n) {
    console.log(`\n  Fund your wallet with tNight from the faucet:`);
    console.log(`  https://faucet.${networkId}.midnight.network/\n`);

    const fundedBalance = await withStatus('Waiting for incoming tokens', () =>
      Rx.firstValueFrom(
        wallet.state().pipe(
          Rx.throttleTime(10_000),
          Rx.filter((s) => s.isSynced),
          Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
          Rx.filter((b) => b > 0n),
        ),
      ),
    );
    console.log(`  Balance: ${fundedBalance.toLocaleString()} tNight`);
  }

  // ── 7. Register for DUST generation ────────────────────────────────────
  const dustState = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  if (dustState.dust.availableCoins.length === 0) {
    const nightUtxos = dustState.unshielded.availableCoins.filter(
      (coin) => coin.meta?.registeredForDustGeneration !== true,
    );

    if (nightUtxos.length > 0) {
      await withStatus(`Registering ${nightUtxos.length} NIGHT UTXO(s) for DUST generation`, async () => {
        const recipe = await wallet.registerNightUtxosForDustGeneration(
          nightUtxos,
          unshieldedKeystore.getPublicKey(),
          (payload) => unshieldedKeystore.signData(payload),
        );
        const finalized = await wallet.finalizeRecipe(recipe);
        await wallet.submitTransaction(finalized);
      });
    }

    await withStatus('Waiting for DUST tokens to generate', () =>
      Rx.firstValueFrom(
        wallet.state().pipe(
          Rx.throttleTime(5_000),
          Rx.filter((s) => s.isSynced),
          Rx.filter((s) => s.dust.balance(new Date()) > 0n),
        ),
      ),
    );
  } else {
    const dustBal = dustState.dust.balance(new Date());
    console.log(`  ✓ DUST already available (${dustBal.toLocaleString()} DUST)`);
  }

  // ── 8. Build providers ─────────────────────────────────────────────────
  const walletAndMidnightProvider = await withStatus('Configuring providers', async () => {
    const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

    // Work around wallet SDK bug: signRecipe uses hardcoded 'pre-proof'
    // marker when cloning intents, but proven intents use 'proof' data.
    const signTransactionIntents = (tx, signFn, proofMarker) => {
      if (!tx.intents || tx.intents.size === 0) return;
      for (const segment of tx.intents.keys()) {
        const intent = tx.intents.get(segment);
        if (!intent) continue;
        const cloned = ledger.Intent.deserialize(
          'signature', proofMarker, 'pre-binding', intent.serialize(),
        );
        const signature = signFn(cloned.signatureData(segment));
        if (cloned.fallibleUnshieldedOffer) {
          const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
            (_, i) => cloned.fallibleUnshieldedOffer.signatures.at(i) ?? signature,
          );
          cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs);
        }
        if (cloned.guaranteedUnshieldedOffer) {
          const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
            (_, i) => cloned.guaranteedUnshieldedOffer.signatures.at(i) ?? signature,
          );
          cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
        }
        tx.intents.set(segment, cloned);
      }
    };

    return {
      getCoinPublicKey() {
        return state.shielded.coinPublicKey.toHexString();
      },
      getEncryptionPublicKey() {
        return state.shielded.encryptionPublicKey.toHexString();
      },
      async balanceTx(tx, ttl) {
        const recipe = await wallet.balanceUnboundTransaction(
          tx,
          { shieldedSecretKeys, dustSecretKey },
          { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
        );
        const signFn = (payload) => unshieldedKeystore.signData(payload);
        signTransactionIntents(recipe.baseTransaction, signFn, 'proof');
        if (recipe.balancingTransaction) {
          signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof');
        }
        return wallet.finalizeRecipe(recipe);
      },
      submitTx(tx) {
        return wallet.submitTransaction(tx);
      },
    };
  });

  const zkConfigProvider = new NodeZkConfigProvider(contractPath);
  const accountId = walletAndMidnightProvider.getCoinPublicKey();
  const storagePassword = `${Buffer.from(accountId, 'hex').toString('base64')}!`;

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'mindsafe-private-state',
      accountId,
      privateStoragePasswordProvider: () => storagePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(proofServerUrl, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };

  // ── 9. Deploy! ─────────────────────────────────────────────────────────
  const deployed = await withStatus('Deploying MindSafe contract', () =>
    deployContract(providers, {
      compiledContract,
      privateStateId: 'mindsafePrivateState',
      initialPrivateState: {},
    }),
  );

  const contractAddress = deployed.deployTxData.public.contractAddress;

  console.log(`\n${DIV}`);
  console.log('  ✓ MindSafe Contract Deployed Successfully!');
  console.log(DIV);
  console.log(`  Contract Address: ${contractAddress}`);
  console.log(`  Block Height:     ${deployed.deployTxData.public.blockHeight}`);
  console.log(`  TX ID:            ${deployed.deployTxData.public.txId}`);
  console.log(DIV);

  // ── 10. Update .env with the deployed address ──────────────────────────
  const envPath = resolve(PROJECT_ROOT, '.env');
  if (existsSync(envPath)) {
    let envContent = readFileSync(envPath, 'utf-8');
    // Replace the VITE_CONTRACT_ADDRESS line
    if (envContent.includes('VITE_CONTRACT_ADDRESS=')) {
      envContent = envContent.replace(
        /VITE_CONTRACT_ADDRESS=.*/,
        `VITE_CONTRACT_ADDRESS=${contractAddress}`,
      );
    } else {
      envContent += `\nVITE_CONTRACT_ADDRESS=${contractAddress}\n`;
    }
    writeFileSync(envPath, envContent, 'utf-8');
    console.log(`  ✓ Updated .env with VITE_CONTRACT_ADDRESS`);
  }

  console.log(`\n  Next steps:`);
  console.log(`    1. npm run zk:sync`);
  console.log(`    2. npm run dev`);
  console.log(`    3. Open http://localhost:5173\n`);

  // ── Cleanup ────────────────────────────────────────────────────────────
  await wallet.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n  ✗ Deployment failed:', err.message || err);
  if (err.stack) {
    console.error('\n  Stack trace:');
    console.error(err.stack);
  }
  process.exit(1);
});
