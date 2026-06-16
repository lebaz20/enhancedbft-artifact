const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, `config.persisted.${process.env.HTTP_PORT}.json`)

// Load config from file or fallback to env/defaults
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  }

  // Maximum number of transactions that can be present in a block and transaction pool
  const TRANSACTION_THRESHOLD = process.env.TRANSACTION_THRESHOLD
    ? parseInt(process.env.TRANSACTION_THRESHOLD, 10)
    : 5

  // Immutable baseline — adaptive logic in p2pserver.js may raise TRANSACTION_THRESHOLD
  // at runtime to batch more TXs per block under heavy load. BASE_TRANSACTION_THRESHOLD
  // is never mutated so the scaling formula always has a stable reference point.
  const BASE_TRANSACTION_THRESHOLD = TRANSACTION_THRESHOLD

  // Maximum number of transactions sent per redirect drain cycle.
  // Decoupled from TRANSACTION_THRESHOLD so broken shards can flush larger backlogs
  // in one HTTP round-trip while healthy shards still form smaller, faster blocks.
  // Defaults to 2× TRANSACTION_THRESHOLD (e.g. drain 100 TX/cycle, confirm in 50-TX blocks).
  const DRAIN_BATCH_SIZE = process.env.DRAIN_BATCH_SIZE
    ? parseInt(process.env.DRAIN_BATCH_SIZE, 10)
    : TRANSACTION_THRESHOLD * 2

  // total number of nodes in the network
  const NUMBER_OF_NODES_PER_SHARD = process.env.NUMBER_OF_NODES_PER_SHARD
    ? parseInt(process.env.NUMBER_OF_NODES_PER_SHARD, 10)
    : 4

  const DEFAULT_TTL = process.env.DEFAULT_TTL ? parseInt(process.env.DEFAULT_TTL, 10) : 6
  const NUMBER_OF_NODES = process.env.NUMBER_OF_NODES
    ? parseInt(process.env.NUMBER_OF_NODES, 10)
    : 8

  // NUMBER_OF_FAULTY_NODES declared here because POOL_CAPACITY derivation needs it.
  const NUMBER_OF_FAULTY_NODES = process.env.NUMBER_OF_FAULTY_NODES
    ? parseInt(process.env.NUMBER_OF_FAULTY_NODES, 10)
    : 0

  // Maximum unassigned TXs a healthy shard will accept via redirect before returning 503.
  //
  // Derived from shard topology and drain-loop dynamics — not trial and error:
  //   faulty_per_break   = floor(NODES_PER_SHARD/3) + 1   — minimum faulty nodes to break a shard
  //   broken_shards      = floor(FAULTY_NODES / faulty_per_break)
  //   honest_per_broken  = NODES_PER_SHARD - faulty_per_break  — each runs one drain loop
  //   redirect_rate/shard = (broken × honest_per_broken / healthy) × DRAIN_BATCH_SIZE × 2
  //     where ×2 comes from 1000 ms / 500 ms drain interval (appP2p.js DRAIN_INTERVAL_MS)
  //   POOL_CAPACITY = redirect_rate × 30 s — gives EMA time to scale blocks to 10× THRESHOLD
  //   so consensus drain rate overtakes the redirect inflow before the pool fills.
  //   Floor of THRESHOLD × 20 applies when there are no faulty nodes.
  //     N=24 → ~2000+   N=128 → ~22 900   N=512 → ~23 700
  const _faultyPerBreak = Math.floor(NUMBER_OF_NODES_PER_SHARD / 3) + 1
  const _honestPerBroken = NUMBER_OF_NODES_PER_SHARD - _faultyPerBreak
  const _brokenShards = Math.floor(NUMBER_OF_FAULTY_NODES / _faultyPerBreak)
  const _healthyShards = Math.max(
    1,
    Math.floor(NUMBER_OF_NODES / NUMBER_OF_NODES_PER_SHARD) - _brokenShards
  )
  // 500 ms drain interval (appP2p.js DRAIN_INTERVAL_MS) → 2 cycles/s
  const _redirectRatePerShard =
    ((_brokenShards * _honestPerBroken) / _healthyShards) * DRAIN_BATCH_SIZE * 2
  const POOL_CAPACITY = process.env.POOL_CAPACITY
    ? parseInt(process.env.POOL_CAPACITY, 10)
    : Math.max(TRANSACTION_THRESHOLD * 20, Math.ceil(_redirectRatePerShard * 30))

  const NODES_SUBSET = process.env.NODES_SUBSET ? JSON.parse(process.env.NODES_SUBSET) : []

  const SHOULD_REDIRECT_FROM_FAULTY_NODES = process.env.SHOULD_REDIRECT_FROM_FAULTY_NODES === 'true'
  const ENABLE_SHARD_MERGE = process.env.ENABLE_SHARD_MERGE === 'true'
  const IS_FAULTY = process.env.IS_FAULTY === 'true'

  // Minimum number of positive votes required for the message/block to be valid
  // Standard PBFT safety threshold: 2f+1 where f = floor((n-1)/3)
  // This tolerates up to floor((n-1)/3) faulty nodes per shard.
  // The naive formula 2*(n/3) gives 5.33 for n=8 (requires 6 votes) which is
  // stricter than necessary — shards with 3 faulty out of 8 only have 5 honest
  // nodes and would never reach consensus even though PBFT allows it.
  const MIN_APPROVALS = 2 * Math.floor((NUMBER_OF_NODES_PER_SHARD - 1) / 3) + 1

  // SUBSET INDEX
  const SUBSET_INDEX = process.env.SUBSET_INDEX ?? 'SUBSET1'

  // CPU limit for each node in the network
  const CPU_LIMIT = process.env.CPU_LIMIT ?? '1'

  const REDIRECT_TO_URL = process.env.REDIRECT_TO_URL ?? []

  // Each shard is the designated verifier for ALL other shards in the pool.
  // Computed statically at pod creation time by prepare-config.js and injected
  // as a JSON array env var — dead shards simply never emit block_from_core.
  const VERIFICATION_SOURCE_SUBSETS = process.env.VERIFICATION_SOURCE_SUBSETS
    ? JSON.parse(process.env.VERIFICATION_SOURCE_SUBSETS)
    : []

  const config = {
    TRANSACTION_THRESHOLD,
    BASE_TRANSACTION_THRESHOLD,
    DRAIN_BATCH_SIZE,
    POOL_CAPACITY,
    NUMBER_OF_NODES_PER_SHARD,
    NUMBER_OF_NODES,
    NUMBER_OF_FAULTY_NODES,
    MIN_APPROVALS,
    SUBSET_INDEX,
    NODES_SUBSET,
    CPU_LIMIT,
    REDIRECT_TO_URL,
    IS_FAULTY,
    SHOULD_REDIRECT_FROM_FAULTY_NODES,
    ENABLE_SHARD_MERGE,
    DEFAULT_TTL,
    VERIFICATION_SOURCE_SUBSETS
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  return config
}

// Cache config in memory to avoid sync FS reads on every get() call.
// Invalidated on set() and on file changes (fs.watch).
let _cachedConfig = null

try {
  fs.watch(CONFIG_PATH, () => {
    _cachedConfig = null
  })
} catch {
  /* file may not exist yet at startup */
}

module.exports = {
  get: () => {
    if (!_cachedConfig) _cachedConfig = loadConfig()
    return _cachedConfig
  },
  set: (key, value) => {
    const config = _cachedConfig || loadConfig()
    // Skip synchronous filesystem write when value is unchanged — this path
    // fires on every block round (EMA reset) and was blocking the event loop
    // with 640+ writeFileSync calls/min at 32 shards.
    if (config[key] === value) return
    config[key] = value
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    _cachedConfig = config
  }
}
