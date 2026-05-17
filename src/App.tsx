import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { sendChat, tryParseFinal } from './lib/ai'
import { mintProof, connectToWallet } from './lib/midnight'

type Screen = 'landing' | 'chat' | 'result'

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type AiResult = {
  condition: string
  severity: 'mild' | 'moderate' | 'severe'
  score: number
  recommendation: string
  confidence: number
}

type ProofOutput = {
  resultCategory: string
  recommendation: string
  proofHash: string
  timestamp: string
  txId?: string
}

const SYSTEM_PROMPT =
  [
    '<role>',
    'You are MindSafe Clinician, a concise clinical mental health screener.',
    '</role>',
    '<purpose>',
    'Run an adaptive, privacy-first screening conversation. Ask one short question at a time and adapt the next question to the user\'s responses.',
    '</purpose>',
    '<guidelines>',
    '1. Prioritize brevity and clarity; do not ask unnecessary follow-ups.',
    '2. Continue asking adaptive questions until you have enough information to produce a reliable screening result (no hard question cap).',
    '3. If the user explicitly requests to skip ahead, you may continue the screening but ensure the final assessment is grounded in the information provided.',
    '</guidelines>',
    '<output_format>',
    'When ready to finish, output ONLY a single JSON object (no markdown, no extra text) with the schema: {"condition": string, "severity": "mild"|"moderate"|"severe", "score": number, "recommendation": string, "confidence": number }',
    '</output_format>',
    '<example>',
    'Example output: {"condition":"anxiety","severity":"moderate","score":12,"recommendation":"Consider talking with a licensed professional.","confidence":0.84}',
    '</example>',
  ].join('\n')

function App() {
  const [screen, setScreen] = useState<Screen>('landing')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [result, setResult] = useState<AiResult | null>(null)
  const [proof, setProof] = useState<ProofOutput | null>(null)
  const [walletAddr, setWalletAddr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connectionLog, setConnectionLog] = useState<string[]>([])
  const [devMockEnabled, setDevMockEnabled] = useState(false)
  const [userApiKey, setUserApiKey] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const visibleMessages = useMemo(
    () => messages.filter((msg) => msg.role !== 'system'),
    [messages],
  )

  const proofPayload = useMemo(() => {
    if (!proof) return null
    return {
      result_category: proof.resultCategory,
      recommendation: proof.recommendation,
      timestamp: proof.timestamp,
      proof_hash: proof.proofHash,
      tx_id: proof.txId ?? null,
    }
  }, [proof])

  const proofJson = useMemo(() => {
    if (!proofPayload) {
      return '{\n  result_category: null,\n  recommendation: null,\n  timestamp: null,\n  proof_hash: null,\n  tx_id: null\n}'
    }
    return JSON.stringify(proofPayload, null, 2)
  }, [proofPayload])

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [visibleMessages, isThinking])

  const startSession = async () => {
    setError(null)
    setResult(null)
    setProof(null)
    const seedMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Begin screening.' },
    ]
    setMessages(seedMessages)
    setScreen('chat')
    await runAssistant(seedMessages)
  }

  const quickDemo = async () => {
    // Create a realistic demo result so the user can immediately mint
    const demo: AiResult = {
      condition: 'anxiety',
      severity: 'moderate',
      score: 12,
      recommendation: 'Consider talking with a licensed professional.',
      confidence: 0.85,
    }
    setResult(demo)
    setScreen('result')
  }

  const handleConnect = async () => {
    setError(null)
    setConnectionLog((l) => [...l, 'Starting connect flow...'])
    try {
      setConnectionLog((l) => [...l, 'Calling connectToWallet()'])
      const r = await connectToWallet()
      setConnectionLog((l) => [...l, 'connectToWallet() resolved'])
      const addr = r?.shielded?.shieldedCoinPublicKey ?? r?.config?.contractAddress ?? 'connected'
      setWalletAddr(String(addr))
      setConnectionLog((l) => [...l, `Connected: ${String(addr)}`])
      console.debug('connect result', r)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setConnectionLog((l) => [...l, `Connect error: ${message}`])
      console.error('connect error', err)
    }
  }

  const enableDevMock = () => {
    // Inject a simple mock 1AM wallet into window.midnight for local testing
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    window.midnight = window.midnight || {}
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    window.midnight['1am'] = {
      rdns: 'dev.mock.1am',
      name: 'Dev Mock 1AM',
      apiVersion: '0.0.0',
      connect: async (_network: string) => {
        return {
          getConfiguration: async () => ({ indexerUri: '', indexerWsUri: '' }),
          getShieldedAddresses: async () => ({ shieldedCoinPublicKey: 'dev-shielded-pk', shieldedEncryptionPublicKey: 'dev-enckey' }),
          submitTransaction: async (txHex: string) => `dev-tx-${txHex.slice(0, 16)}`,
          balanceUnsealedTransaction: async (txHex: string) => ({ tx: txHex }),
        }
      },
    }
    setDevMockEnabled(true)
    setConnectionLog((l) => [...l, `Dev mock wallet injected into window.midnight["1am"]`])
  }

  const runAssistant = async (nextMessages: ChatMessage[]) => {
    setIsThinking(true)
    try {
      const reply = await sendChat(nextMessages, userApiKey)
      const parsed = tryParseFinal(reply)
      if (parsed) {
        setResult(parsed)
        setScreen('result')
      } else {
        setMessages((prev) => [...prev, { role: 'assistant' as const, content: reply }])
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI request failed'
      setError(message)
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant' as const,
          content: 'I hit an error. You can retry or end the session.',
        },
      ])
    } finally {
      setIsThinking(false)
    }
  }

  const handleSend = async () => {
    if (!input.trim() || isThinking) return
    const next: ChatMessage[] = [...messages, { role: 'user' as const, content: input.trim() }]
    setMessages(next)
    setInput('')
    await runAssistant(next)
  }

  const handleMint = async () => {
    if (!result || isThinking) return

    if (!window.confirm("You will see 2-3 approval prompts from 1AM wallet. Please approve ALL of them. Do not close the wallet popup.")) {
      return
    }

    setIsThinking(true)
    setError(null)
    try {
      const proofOutput = await mintProof({
        score: result.score,
      })
      setProof({
        resultCategory: proofOutput.resultCategory,
        recommendation: proofOutput.recommendation,
        proofHash: proofOutput.proofHash,
        timestamp: proofOutput.timestamp,
        txId: proofOutput.txId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Proof mint failed'
      setError(message)
      setConnectionLog((l) => [...l, `mint error: ${String(message)}`])
      // Provide actionable guidance for known address/hex decoding errors
      if (String(message).toLowerCase().includes('last byte of input string') || String(message).toLowerCase().includes('invalid hex')) {
        setConnectionLog((l) => [
          ...l,
          'Detected address/hex decoding error. Likely causes: wrong `VITE_CONTRACT_ADDRESS` format, or wallet/contract address encoding mismatch.',
          'Suggested actions: enable Dev Mock (top bar) to simulate a mint, or set `VITE_CONTRACT_ADDRESS` to the correct address encoding and restart the dev server.',
        ])
      }
    } finally {
      setIsThinking(false)
    }
  }

  const endSession = () => {
    setMessages([])
    setInput('')
    setResult(null)
    setProof(null)
    setError(null)
    setScreen('landing')
  }

  const handleCopyProof = async () => {
    if (!proofPayload) return
    try {
      await navigator.clipboard.writeText(proofJson)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Copy failed'
      setError(message)
    }
  }

  const handleDownloadProof = () => {
    if (!proofPayload) return
    const blob = new Blob([proofJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'mindsafe-proof.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div>
            <div>MindSafe</div>
            <div className="status-text">Private screening on Midnight</div>
          </div>
        </div>
        <div className="nav-meta">
          {walletAddr ? (
            <span className="nav-chip">Connected</span>
          ) : (
            <button className="secondary-btn" onClick={handleConnect}>
              Connect Wallet
            </button>
          )}
            <button className="secondary-btn" onClick={enableDevMock} disabled={devMockEnabled}>
              {devMockEnabled ? 'Dev Mock Enabled' : 'Enable Dev Mock'}
            </button>
            <span className="nav-chip">No storage</span>
            <span className="nav-chip">No identity</span>
        </div>
      </header>

      {screen === 'landing' && (
        <section className="screen hero">
          <div>
            <h1>Private AI mental health screening, verified by ZK.</h1>
            <p>
              MindSafe runs a clinician-style screening with adaptive questions.
              Your conversation never leaves this session. Only a zero-knowledge
              proof of the outcome is minted on Midnight.
            </p>
            <div className="api-key-container" style={{ marginTop: '20px', marginBottom: '20px' }}>
              <input
                type="password"
                placeholder="Enter Gemini API Key (optional if configured in .env)"
                value={userApiKey}
                onChange={(e) => setUserApiKey(e.target.value)}
                style={{ width: '100%', maxWidth: '400px', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-light)', background: 'var(--surface-bg)', color: 'var(--text)' }}
              />
              <p style={{ fontSize: '12px', color: 'var(--text-light)', marginTop: '8px' }}>Your key is securely used strictly for this session and never stored.</p>
            </div>
            <div className="footer-actions">
              <button className="primary-btn" onClick={startSession}>
                Start Private Session
              </button>
              <button className="secondary-btn" onClick={startSession}>
                View Live Demo
              </button>
                <button className="secondary-btn" onClick={quickDemo}>
                  Quick Demo (generate result)
                </button>
            </div>
            <p className="disclaimer">
              No account. No storage. No trace. This is a screening tool, not a
              medical diagnosis.
            </p>
          </div>
          <div className="hero-card">
            <h3>What gets recorded on-chain</h3>
            <div className="hero-grid">
              <div>Commitment hash only</div>
              <div>Result category</div>
              <div>Recommendation</div>
              <div>Timestamp</div>
            </div>
            <div className="notice-bar">
              <span className="notice-dot" />
              Identity remains null. Conversation data never touches the chain.
            </div>
          </div>
        </section>
      )}

      {screen === 'chat' && (
        <section className="screen chat-shell">
          <div className="chat-panel">
            <div className="chat-header">
              <div>
                <strong>MindSafe Clinician</strong>
                <div className="status-text">Adaptive screening · Max 12 questions</div>
              </div>
              <div className="lock-badge">Private • Encrypted</div>
            </div>
            <div className="chat-messages" ref={scrollRef}>
              {visibleMessages.length === 0 && (
                <div className="message system">Start a session to begin.</div>
              )}
              {visibleMessages.map((msg, index) => (
                <div key={`${msg.role}-${index}`} className={`message ${msg.role}`}>
                  {msg.content}
                </div>
              ))}
              {isThinking && <div className="message assistant">Thinking...</div>}
            </div>
            <div className="chat-input">
              <textarea
                rows={2}
                placeholder="Type your answer..."
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
              <button className="primary-btn" onClick={handleSend}>
                Send
              </button>
            </div>
          </div>
          <aside className="side-panel">
            <div className="info-card">
              <h4>Privacy guardrails</h4>
              <p className="status-text">
                Everything you type stays in memory only. When the session ends,
                MindSafe wipes all state.
              </p>
            </div>
            <div className="progress-card">
              <h4>Session flow</h4>
              <div className="progress-steps">
                <span>Adaptive questioning</span>
                <span>Local scoring</span>
                <span>Mint ZK proof</span>
              </div>
            </div>
            <button className="secondary-btn" onClick={endSession}>
              End Session
            </button>
            {error && <p className="status-text">{error}</p>}
            <details style={{ marginTop: 12 }}>
              <summary>Connection debug</summary>
              <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                <strong>walletAddr:</strong> {String(walletAddr)}
                <br />
                <strong>devMockEnabled:</strong> {String(devMockEnabled)}
                <br />
                <strong>connectionLog:</strong>
                <br />
                {connectionLog.map((l, i) => (
                  <div key={i}>- {l}</div>
                ))}
              </div>
            </details>
          </aside>
        </section>
      )}

      {screen === 'result' && result && (
        <section className="screen result-layout">
          <div className="result-card">
            <h2>Your private screening summary</h2>
            <p>
              Condition focus: <strong>{result.condition}</strong>
            </p>
            <div className="result-meta">
              <span className="result-pill">Severity: {result.severity}</span>
              <span className="result-pill">Score: {result.score}</span>
              <span className="result-pill">
                Confidence: {(result.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <p style={{ marginTop: '16px' }}>{result.recommendation}</p>
            <div className="footer-actions" style={{ marginTop: '20px' }}>
              <button className="primary-btn" onClick={handleMint} disabled={isThinking}>
                {isThinking ? 'Minting...' : 'Mint Proof'}
              </button>
              <button className="secondary-btn" onClick={endSession} disabled={isThinking}>
                End Session
              </button>
            </div>
            {isThinking && (
              <p className="status-text" style={{ color: 'var(--primary)', marginTop: '12px', fontWeight: 600 }}>
                Generating ZK proof... this takes 60-90 seconds, please wait and approve all 1AM prompts
              </p>
            )}
            {error && <p className="status-text">{error}</p>}
            <details style={{ marginTop: 12 }}>
              <summary>Connection debug</summary>
              <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                <strong>walletAddr:</strong> {String(walletAddr)}
                <br />
                <strong>devMockEnabled:</strong> {String(devMockEnabled)}
                <br />
                <strong>connectionLog:</strong>
                <br />
                {connectionLog.map((l, i) => (
                  <div key={i}>- {l}</div>
                ))}
              </div>
            </details>
          </div>
          <div className="proof-card">
            <h4>Proof output</h4>
            <div className="proof-json">
                {proofJson}
            </div>
            <p className="status-text" style={{ marginTop: '12px' }}>
              Copy or download the on-chain submission payload.
            </p>
              <div className="proof-actions">
                <button
                  className="secondary-btn"
                  onClick={handleCopyProof}
                  disabled={!proofPayload}
                >
                  Copy
                </button>
                <button
                  className="secondary-btn"
                  onClick={handleDownloadProof}
                  disabled={!proofPayload}
                >
                  Download
                </button>
              </div>
          </div>
        </section>
      )}
    </div>
  )
}

export default App
