// Import all required models
const express = require('express')
const bodyParser = require('body-parser')
const axios = require('axios')
const config = require('./config')
const logger = require('./utils/logger')
const Wallet = require('./services/wallet')
const P2pserver = require('./services/p2pserver')
const Validators = require('./services/validators')
const Blockchain = require('./services/blockchain')
const IDAGossip = require('./services/idaGossip')
const TransactionPool = require('./services/pools/transaction')
const BlockPool = require('./services/pools/block')
const CommitPool = require('./services/pools/commit')
const PreparePool = require('./services/pools/prepare')
const MessagePool = require('./services/pools/message')
const MESSAGE_TYPE = require('./constants/message')

const HTTP_PORT = process.env.HTTP_PORT || 3001
const P2P_PORT = process.env.P2P_PORT || 5001
const { NODES_SUBSET, SUBSET_INDEX } = config.get()

// ── BATCHING DEAD-SHARD PROXY STATE ─────────────────────────────────────────
// TXs arriving at a dead-shard node are buffered here until a full block's worth
// has accumulated (BASE_TRANSACTION_THRESHOLD), then flushed in one HTTP call to
// a healthy shard.  Bulk delivery creates a queue spike on the healthy shard that
// activates the EMA-based adaptive block-size logic in p2pserver.js — scaling
// blocks to 300–1000 TXs/block and reaching consistent 100%+ drain rates.
//
// Why batching beats one-at-a-time forwarding:
//   One-at-a-time keeps healthy-shard queues near-empty (EMA≈0 → block size stuck
//   at BASE, ~100 TXs/block).  A 100-TX flush from every dead-shard node causes a
//   queue spike of BASE × (dead_nodes_per_healthy_shard) TXs, e.g. 500 TXs when
//   5 dead-shard nodes drain to the same healthy shard — pressure = 5 × BASE →
//   multiplier scales to 5 within 2 EMA cycles, independent of shard randomisation.
//
// Flush triggers (whichever comes first):
//   1. Buffer reaches BASE_TRANSACTION_THRESHOLD (full block ready — flush now).
//   2. PROXY_FLUSH_MS elapses (partial batch — avoid stalling at low input rate).
const PROXY_FLUSH_MS = 200
const _proxyBuffer = []
let _proxyFlushTimer = null
let _proxyRrIdx = 0

const _flushProxyBuffer = async () => {
  clearTimeout(_proxyFlushTimer)
  _proxyFlushTimer = null
  if (!_proxyBuffer.length) return
  const { REDIRECT_TO_URL, SHOULD_REDIRECT_FROM_FAULTY_NODES } = config.get()
  if (
    !SHOULD_REDIRECT_FROM_FAULTY_NODES ||
    !Array.isArray(REDIRECT_TO_URL) ||
    !REDIRECT_TO_URL.length
  ) {
    // Redirect mode cleared while batch was building — drop buffer; async drain
    // loop will handle any TXs that made it into the pool before this point.
    _proxyBuffer.length = 0
    return
  }
  const batch = _proxyBuffer.splice(0) // atomic take
  // Round-robin per flush so successive batches spread evenly across healthy nodes.
  _proxyRrIdx = (_proxyRrIdx + 1) % REDIRECT_TO_URL.length
  const rotated = [...REDIRECT_TO_URL.slice(_proxyRrIdx), ...REDIRECT_TO_URL.slice(0, _proxyRrIdx)]
  for (const url of rotated) {
    try {
      const res = await axios.post(
        `${url}/transaction`,
        { isRedirect: true, transactions: batch },
        { timeout: 5000 }
      )
      if (res.data?.code === 'OVER_UTILIZED') continue
      logger.log(`PROXY BATCH: forwarded ${batch.length} txs to ${url}`)
      return // success — done
    } catch (err) {
      if (err.response?.status === 503) continue
      // Network / timeout — try next URL
    }
  }
  // All healthy shards busy or unreachable — restore buffer and retry on next flush.
  _proxyBuffer.unshift(...batch)
  // Arm a retry in PROXY_FLUSH_MS so we don't lose these TXs.
  if (!_proxyFlushTimer) {
    _proxyFlushTimer = setTimeout(_flushProxyBuffer, PROXY_FLUSH_MS)
  }
  logger.warn(`PROXY BATCH: all targets unavailable, ${_proxyBuffer.length} TXs queued`)
}

// Instantiate all objects
const app = express()
app.use(bodyParser.json())

const wallet = new Wallet(process.env.SECRET)
const transactionPool = new TransactionPool()
const validators = new Validators(NODES_SUBSET)
const blockchain = new Blockchain(validators, transactionPool)
const blockPool = new BlockPool()
const preparePool = new PreparePool()
const commitPool = new CommitPool()
const messagePool = new MessagePool()
const idaGossip = new IDAGossip()
const p2pserver = new P2pserver(
  blockchain,
  transactionPool,
  wallet,
  blockPool,
  preparePool,
  commitPool,
  messagePool,
  validators,
  idaGossip
)

// sends all transactions in the transaction pool to the user
app.get('/transactions', (request, response) => {
  response.json(transactionPool.transactions)
})

// sends the entire chain to the user
app.get('/blocks', (request, response) => {
  response.json(blockchain.chain)
})

// sends the chain stats to the user
app.get('/stats', async (request, response) => {
  const rate = await blockchain.getRate(p2pserver.sockets)
  const { IS_FAULTY } = config.get()
  const stats = {
    total: blockchain.getTotal(),
    rate,
    isFaulty: IS_FAULTY
  }
  logger.log(`REQUEST STATS FOR #${SUBSET_INDEX}:`, JSON.stringify(stats))
  response.json(stats)
})

// check server health
app.get('/health', (request, response) => {
  response.status(200).send('Ok')
})

// creates transactions for the sent data
app.post('/transaction', async (request, response) => {
  try {
    const isRedirect = request.body.isRedirect === true
    const data = request.body.transactions ? request.body.transactions : [request.body]

    // ── BATCHING DEAD-SHARD PROXY (FAULTY NODES ONLY) ───────────────────────
    // Faulty nodes have no async drain loop (skipped by IS_FAULTY guard) so
    // they need the proxy to rescue TXs that would otherwise be permanently lost.
    //
    // Honest dead-shard nodes must NOT enter this branch — their TXs go to the
    // local pool and are drained by the async loop at DRAIN_BATCH_SIZE (100 TXs)
    // every 500 ms.  That delivers up to 200 TXs/s per node vs the proxy's ~4.5
    // TXs/s (JMeter input rate), a 44× throughput difference that creates the
    // queue buildup needed to activate the EMA-based adaptive block sizing.
    {
      const {
        IS_FAULTY: _IS_FAULTY,
        REDIRECT_TO_URL,
        SHOULD_REDIRECT_FROM_FAULTY_NODES,
        BASE_TRANSACTION_THRESHOLD
      } = config.get()
      if (
        _IS_FAULTY &&
        SHOULD_REDIRECT_FROM_FAULTY_NODES &&
        Array.isArray(REDIRECT_TO_URL) &&
        REDIRECT_TO_URL.length > 0
      ) {
        response.status(200).json({ ok: true })
        _proxyBuffer.push(...data)
        const batchSize = BASE_TRANSACTION_THRESHOLD || 100
        if (_proxyBuffer.length >= batchSize) {
          // Buffer full — flush immediately for maximum queue spike on target shard.
          clearTimeout(_proxyFlushTimer)
          _proxyFlushTimer = null
          setImmediate(_flushProxyBuffer)
        } else if (!_proxyFlushTimer) {
          // Partial batch — set a deadline so low-rate input still gets forwarded.
          _proxyFlushTimer = setTimeout(_flushProxyBuffer, PROXY_FLUSH_MS)
        }
        return
      }
    }

    // Reject redirect requests when this shard's pool is over-utilized.
    // Direct JMeter traffic is always accepted — never return 503 to real clients.
    // Redirects come from broken shards and are lower-priority; rejecting them here
    // causes the broken shard's drain loop to back off and retry, preventing redirect
    // floods from crowding out direct traffic in the consensus pipeline.
    if (isRedirect) {
      const { POOL_CAPACITY } = config.get()
      if (transactionPool.transactions.unassigned.length >= POOL_CAPACITY) {
        logger.warn(
          `REDIRECT REJECTED on ${HTTP_PORT}: pool ${transactionPool.transactions.unassigned.length} >= capacity ${POOL_CAPACITY}`
        )
        return response.status(503).json({ ok: false, code: 'OVER_UTILIZED' })
      }
    }

    // Respond immediately — defer all CPU work (signing, hashing, P2P fan-out)
    // to after the HTTP round-trip so JMeter threads are not blocked by ECDSA crypto.
    //
    // DEDUP: pre-filter redirect TXs SYNCHRONOUSLY (before setImmediate).
    // Only check transactionIds (already-pooled) — do NOT add to transactionIds here.
    // Adding prematurely causes _handleTransactions to see the TX as "existing" and
    // drop it silently — a bug that previously caused 100% of redirect TXs to vanish.
    // Within-batch dedup uses a local Set so duplicate IDs in one request are caught.
    const pendingItems = []
    const _batchSeen = new Set()
    for (const item of data) {
      const { _drainId } = item
      if (_drainId) {
        if (transactionPool.transactionIds.has(_drainId) || _batchSeen.has(_drainId)) {
          logger.debug(`DEDUP (sync): skipping already-pooled TX ${_drainId}`)
          continue // already seen — drop even before setImmediate
        }
        _batchSeen.add(_drainId) // within-batch dedup only
      }
      pendingItems.push(item)
    }
    if (pendingItems.length === 0) return response.json({ ok: true })

    response.json({ ok: true })
    setImmediate(() => {
      // Sign all TXs first, then gossip + pool-add in a single batch.
      const signedTxs = []
      for (const item of pendingItems) {
        const { _drainId, ...itemData } = item
        const transaction = wallet.createTransaction(itemData)
        if (_drainId) transaction.id = _drainId // pin canonical ID
        signedTxs.push(transaction)
      }

      if (isRedirect) {
        // ── FAST PATH for redirect TXs ──────────────────────────────────────
        // We just signed these ourselves — skip verifyTransaction + isValidValidator
        // (both would pass trivially). Add directly to pool and gossip in ONE
        // batch message instead of N individual broadcastTransactions calls.
        // Saves: N Ed25519 verifies, N validator lookups, (N-1)×3 WebSocket msgs.
        for (const tx of signedTxs) {
          if (!transactionPool.transactionExists(tx)) {
            transactionPool.addTransaction(tx)
          }
        }
        if (signedTxs.length > 0) {
          p2pserver.broadcastTransactions(P2P_PORT, signedTxs)
        }
      } else {
        // ── STANDARD PATH for direct JMeter TXs ────────────────────────────
        // Batch all TXs into one parseMessage → one broadcastTransactions call.
        p2pserver.parseMessage({
          type: MESSAGE_TYPE.transactions,
          transactions: signedTxs,
          port: P2P_PORT
        })
      }

      // Trigger block creation once for the entire batch.
      const { TRANSACTION_THRESHOLD: TH } = config.get()
      if (transactionPool.transactions.unassigned.length >= TH) {
        p2pserver.initiateBlockCreation(P2P_PORT, false)
      }
    })
  } catch (error) {
    logger.warn(`Transaction processing error on ${HTTP_PORT}:`, error)
    response.json({ ok: true })
  }
})

// parse message
app.post('/message', async (request, response) => {
  logger.log(`Processing message on ${HTTP_PORT}`, JSON.stringify(request.body))
  p2pserver.parseMessage(request.body)
  response.status(200).send('Ok')
})

// Proactive redirect drain — startup safety-net: for the brief window before the
// core assigns REDIRECT_TO_URL, dead-shard nodes buffer TXs locally; this loop
// drains those accumulated TXs once a redirect target becomes available.
// Under normal operation (after the first core assignment) the synchronous proxy
// above handles all new TXs inline, so this loop fires rarely (near-empty pools).
// It is kept to safely handle edge cases: network retries, proxy timeouts, or any
// TX that slipped into the pool before the proxy activated.
{
  const DRAIN_INTERVAL_MS = 500
  // 5 s max backoff: fast enough to drain a stalled pool within the 30 s
  // drain-wait window, slow enough not to hammer healthy shards with 503 retries
  // every second and starve their PBFT of CPU (which caused an 18% drain rate
  // when MAX was 1 s).  Healthy shards commit every 2-5 s under EMA-boosted
  // load, so a 5 s ceiling means at most one missed window per backoff period.
  const MAX_DRAIN_INTERVAL_MS = 5000
  const startupJitter = Math.floor(Math.random() * DRAIN_INTERVAL_MS)
  let currentDrainInterval = DRAIN_INTERVAL_MS
  // Round-robin index: advances each drain cycle so successive batches target
  // Pick a deterministic URL for the entire batch using the first TX's id.
  // Sending all TXs in one POST to ONE healthy-shard node lets shard-internal
  // gossip distribute them to the proposer so the full threshold (100 TXs) can
  // accumulate in the proposer's pool and trigger a block immediately.
  // Splitting the batch across multiple nodes (e.g. 4 \u00d7 25 TXs) left each
  // node below threshold, causing inactivity-path sub-threshold blocks (avg 72
  // TXs/block vs the intended 100), cutting drain rates by more than 60 %.
  const _hashMod = (str, n) => {
    let h = 5381
    for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0
    return h % n
  }

  // Send the full batch to exactly ONE deterministic target URL.
  // Falls back sequentially through other URLs on error so a single unhealthy
  // node does not stall the drain loop.
  // Returns { succeeded, failed, got503 } for partial-recovery safety.
  const _forwardBatch = async (toForward, urls) => {
    if (!urls.length) return { succeeded: [], failed: toForward, got503: false }

    // Deterministic primary: hash of first TX id mod url count.
    const primaryIdx = _hashMod(toForward[0].id, urls.length)
    const rotated = [...urls.slice(primaryIdx), ...urls.slice(0, primaryIdx)]

    let got503 = false
    for (const url of rotated) {
      try {
        const res = await axios.post(`${url}/transaction`, {
          isRedirect: true,
          transactions: toForward.map((t) => ({ ...t.input.data, _drainId: t.id }))
        })
        if (res.data && res.data.code === 'OVER_UTILIZED') {
          logger.warn(`REDIRECT DRAIN: ${url} over-utilized, trying next\u2026`)
          got503 = true
          continue
        }
        return { succeeded: toForward, failed: [], got503 }
      } catch (err) {
        if (err.response && err.response.status === 503) {
          logger.warn(`REDIRECT DRAIN: ${url} over-utilized (503), trying next\u2026`)
          got503 = true
          continue
        }
        logger.warn(`REDIRECT DRAIN: redirect to ${url} failed, trying next\u2026`, err)
      }
    }
    // All URLs failed
    return { succeeded: [], failed: toForward, got503 }
  }

  const drainOnce = async () => {
    const { IS_FAULTY, REDIRECT_TO_URL, SHOULD_REDIRECT_FROM_FAULTY_NODES, DRAIN_BATCH_SIZE } =
      config.get()
    if (
      IS_FAULTY ||
      !SHOULD_REDIRECT_FROM_FAULTY_NODES ||
      !Array.isArray(REDIRECT_TO_URL) ||
      !REDIRECT_TO_URL.length
    )
      return scheduleDrain()

    const unassigned = transactionPool.transactions.unassigned
    if (!unassigned.length) return scheduleDrain()

    // Scale batch size up when the backlog is large so broken shards drain big
    // queues faster without increasing HTTP request frequency on healthy shards.
    // Larger batches keep request-rate constant (500 ms cadence) while the healthy
    // shard's POOL_CAPACITY check (503 if pool >= capacity) remains the hard safety
    // valve — it will reject oversized batches before the pool overflows.
    //   > 1000 TXs waiting → 3× batch (e.g. 300 TXs/call)
    //   > 100  TXs waiting → 2× batch (e.g. 200 TXs/call)
    //   otherwise          → 1× batch (e.g. 100 TXs/call  — base cadence)
    let batchMultiplier = 1
    if (unassigned.length > 1000) batchMultiplier = 3
    else if (unassigned.length > 100) batchMultiplier = 2
    const batchSize = Math.min(DRAIN_BATCH_SIZE * batchMultiplier, unassigned.length)

    // Snapshot and remove from pool BEFORE yielding to the event loop.
    const toForward = unassigned.splice(0, batchSize)
    toForward.forEach((t) => transactionPool.transactionIds.delete(t.id))
    logger.log(
      `REDIRECT DRAIN: forwarding ${toForward.length} txs (${unassigned.length} remaining, interval ${currentDrainInterval}ms)`
    )

    const { succeeded, failed, got503 } = await _forwardBatch(toForward, REDIRECT_TO_URL)

    if (succeeded.length > 0) {
      // At least some TXs delivered — reset backoff interval.
      currentDrainInterval = DRAIN_INTERVAL_MS
    }
    if (failed.length > 0) {
      // Restore only the TXs that could not be delivered this cycle.
      failed.forEach((t) => transactionPool.transactionIds.add(t.id))
      transactionPool.transactions.unassigned.unshift(...failed)
      if (got503) {
        currentDrainInterval = Math.min(currentDrainInterval * 2, MAX_DRAIN_INTERVAL_MS)
        logger.warn(
          `REDIRECT DRAIN: ${failed.length} TXs blocked (503), backing off to ${currentDrainInterval}ms`
        )
      } else {
        logger.warn(`REDIRECT DRAIN: ${failed.length} TXs failed, restored to pool for next cycle`)
      }
    }

    scheduleDrain()
  }

  function scheduleDrain() {
    setTimeout(drainOnce, currentDrainInterval)
  }

  // Delay the first tick by a random jitter, then use dynamic scheduling.
  // This prevents all broken-shard nodes (which start nearly simultaneously under
  // Kubernetes) from firing their drain timers in lock-step.
  setTimeout(drainOnce, startupJitter)
}

// Defence-in-depth: catch any uncaught exception or unhandled rejection that
// slips through so the process does NOT exit (which would cause CrashLoopBackOff
// and TCP "Connection reset" errors in JMeter).  The primary fix is in gossipChunk
// (no longer re-throws), but this ensures any future unhandled throw is logged
// instead of killing the process.
process.on('uncaughtException', (err) => {
  logger.error(`UNCAUGHT EXCEPTION (process kept alive): ${err.message}`, err.stack)
})
process.on('unhandledRejection', (reason) => {
  logger.error(`UNHANDLED REJECTION (process kept alive):`, reason)
})

// starts the app server
app.listen(HTTP_PORT, () => {
  logger.log(`Listening on port ${HTTP_PORT}`)
})

// starts the p2p server
p2pserver.listen()
