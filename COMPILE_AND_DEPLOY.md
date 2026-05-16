# Contract Compilation & Deployment Guide

## Compile Locally

Compact development is supported on Linux/macOS, and on Windows only through WSL. Native PowerShell installs are not supported.

### Step 1: Install Compact Compiler

The `npm run compact:compile` script requires the Compact toolchain CLI. Install it:

**macOS/Linux, or WSL on Windows:**
```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/download/compact-v0.4.0/compact-installer.sh | sh
```

If you already have Compact installed, update it with:

```bash
compact self update
```

## Step 2: Verify Installation

```bash
compact --version
```

Expected output: `compact-toolchain-vX.Y.Z`

## Step 3: Compile Contract

From the `mindsafe` directory:

```bash
npm run compact:compile
```

This generates:
- `contracts/managed/mindsafe/` — compiled contract artifacts
- `contracts/managed/mindsafe/keys/` — proving keys for ZK circuits
- `contracts/managed/mindsafe/zkir/` — zero-knowledge intermediate representation

## Step 4: Sync ZK Assets

```bash
npm run zk:sync
```

This copies ZK proving keys to `public/zk/mindsafe/` for the browser runtime.

## Step 5: Deploy Contract

Use the Midnight CLI or SDK to deploy:

```bash
# Deploy to preview network
midnight-cli deploy \
  --contract contracts/managed/mindsafe \
  --network preview \
  --signer <your_wallet_key>
```

After deployment, you'll receive a contract address. Update `.env`:

```
VITE_CONTRACT_ADDRESS=mindsafe0XXXXXXXXXX...
```

## Step 6: Start Dev Server

```bash
npm run dev
```

Visit http://localhost:5173

---

## Troubleshooting

**`compact: command not found`**
- Ensure Compact is installed and in your PATH

**`compact` resolves to Windows `compact.exe`**
- You are running native PowerShell instead of WSL.
- Open a WSL terminal and run the same commands there.

**`npx @midnight-ntwrk/midnight-mcp` returns 404**
- That package is not published on npm.
- Use the official Compact release installer or `compact self update` instead.

**ZK assets missing at runtime**
- Run: `npm run zk:sync`
- Check: `ls public/zk/mindsafe/`

**Contract address validation error**
- Use full address: `mindsafe0...` (42+ characters)
- Verify network matches deployment: `VITE_MIDNIGHT_NETWORK=preview`

---

## Files Generated

After successful compilation and sync:

```
contracts/
  ├── mindsafe.compact      (source)
  ├── witnesses.ts          (witness impls)
  └── managed/mindsafe/     (compiled output)
      ├── keys/             (proving keys - large!)
      ├── zkir/             (ZK circuits)
      └── contract/
          └── index.js      (contract runtime)

public/
  └── zk/mindsafe/          (copied by sync)
      ├── keys/
      └── zkir/
```

---

## Environment Variables

Required before running:

- `VITE_OPENAI_API_KEY` ✅ Already set
- `VITE_CONTRACT_ADDRESS` ⏳ Set after deployment
- `VITE_MIDNIGHT_NETWORK` ✅ Set to `preview`
- `VITE_ZK_ASSET_BASE` ✅ Set to `/zk/mindsafe`

---

## Summary Commands

```bash
# 1. Compile
npm run compact:compile

# 2. Sync ZK assets
npm run zk:sync

# 3. Deploy (via CLI or MCP)
midnight-cli deploy ...

# 4. Update .env with VITE_CONTRACT_ADDRESS

# 5. Start dev server
npm run dev
```
