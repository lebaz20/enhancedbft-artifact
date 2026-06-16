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
  const BLOCK_THRESHOLD = process.env.BLOCK_THRESHOLD
    ? parseInt(process.env.BLOCK_THRESHOLD, 10)
    : 5

  // total number of nodes in the network
  const NUMBER_OF_NODES_PER_SHARD = process.env.NUMBER_OF_NODES_PER_SHARD
    ? parseInt(process.env.NUMBER_OF_NODES_PER_SHARD, 10)
    : 4

  const DEFAULT_TTL = process.env.DEFAULT_TTL ? parseInt(process.env.DEFAULT_TTL, 10) : 6
  const NUMBER_OF_NODES = process.env.NUMBER_OF_NODES
    ? parseInt(process.env.NUMBER_OF_NODES, 10)
    : 8
  const NODES_SUBSET = process.env.NODES_SUBSET ? JSON.parse(process.env.NODES_SUBSET) : []
  const COMMITTEE_SUBSET = process.env.COMMITTEE_SUBSET
    ? JSON.parse(process.env.COMMITTEE_SUBSET)
    : []
  const COMMITTEE_PEERS = process.env.COMMITTEE_PEERS ? process.env.COMMITTEE_PEERS.split(',') : []
  const PEERS = process.env.PEERS ? process.env.PEERS.split(',') : []
  const CORE = process.env.CORE

  const SHOULD_REDIRECT_FROM_FAULTY_NODES = process.env.SHOULD_REDIRECT_FROM_FAULTY_NODES === 'true'
  const IS_FAULTY = process.env.IS_FAULTY === 'true'

  // improve performance by using a subset of nodes in the network
  const NUMBER_OF_FAULTY_NODES = process.env.NUMBER_OF_FAULTY_NODES || 0

  // Minimum number of positive votes required for the message/block to be valid
  // Standard PBFT safety threshold: 2f+1 where f = floor((n-1)/3)
  // This tolerates up to floor((n-1)/3) faulty nodes per shard.
  // The naive formula 2*(n/3) gives 5.33 for n=8 (requires 6 votes) which is
  // stricter than necessary — shards with 3 faulty out of 8 only have 5 honest
  // nodes and would never reach consensus even though PBFT allows it.
  const MIN_APPROVALS = 2 * Math.floor((NUMBER_OF_NODES_PER_SHARD - 1) / 3) + 1

  // SUBSET INDEX
  const SUBSET_INDEX = process.env.SUBSET_INDEX ?? 'SUBSET1'
  const COMMITTEE_SUBSET_INDEX = process.env.COMMITTEE_SUBSET_INDEX ?? 'SUBSET_COMMITTEE'

  // CPU limit for each node in the network
  const CPU_LIMIT = process.env.CPU_LIMIT ?? '1'

  const REDIRECT_TO_URL = process.env.REDIRECT_TO_URL ?? []

  const config = {
    TRANSACTION_THRESHOLD,
    BLOCK_THRESHOLD,
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
    DEFAULT_TTL,
    CORE,
    PEERS,
    COMMITTEE_SUBSET,
    COMMITTEE_PEERS,
    COMMITTEE_SUBSET_INDEX
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
    config[key] = value
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    _cachedConfig = config
  }
}
