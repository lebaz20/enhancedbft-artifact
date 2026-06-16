// Import transaction class used for verification
const Transaction = require('../transaction')
const RateUtility = require('../../utils/rate')
const logger = require('../../utils/logger')

// Transaction threshold is the limit or the holding capacity of the nodes
// Once this exceeds a new block is generated
const config = require('../../config')
const TIMEOUTS = require('../../constants/timeouts')
const TRANSACTION_REASSIGNMENT_TIMEOUT_MS = TIMEOUTS.TRANSACTION_REASSIGNMENT_TIMEOUT_MS

class TransactionPool {
  constructor() {
    this.transactions = { unassigned: [] }
    this.transactionIds = new Set() // O(1) existence index across all buckets
    this.transactionsCreatedAt = {}
    this.reassignmentTimers = {}
    // Committed TX IDs — prevents TXs from being re-proposed after the
    // safety-reassignment timer moves them back to unassigned.
    this.committedTxIds = new Set()
    // Track the rate of incoming transactions
    this.ratePerMin = {}
    // O(1) counter for verification TXs in unassigned pool — avoids O(n) filter in getTotal()
    this._verificationUnassignedCount = 0
  }

  // pushes transactions in the list
  addTransaction(transaction) {
    if (!transaction || !transaction.id) {
      throw new Error('Invalid transaction: transaction and transaction.id are required')
    }
    this.transactions.unassigned.push(transaction)
    this.transactionIds.add(transaction.id)
    if (transaction._type === 'verification') this._verificationUnassignedCount++

    RateUtility.updateRatePerMin(this.ratePerMin, transaction.createdAt)
  }

  // assign block transactions to the block via block hash
  // Release assignment after x time in case block creation doesn't succeed
  assignTransactions(block, reassignmentTimeoutMs = TRANSACTION_REASSIGNMENT_TIMEOUT_MS) {
    if (!block || !block.hash || !Array.isArray(block.data)) {
      throw new Error('Invalid block: block with hash and data array is required')
    }
    const assignedTransactions = block.data
    const removeIds = new Set(assignedTransactions.map((item) => item.id))
    // Track how many verification TXs are being removed from unassigned
    const prevLen = this.transactions.unassigned.length
    this.transactions.unassigned = this.transactions.unassigned.filter(
      (item) => !removeIds.has(item.id)
    )
    // Recount only if items were actually removed (common path)
    if (this.transactions.unassigned.length < prevLen) {
      this._verificationUnassignedCount = this.transactions.unassigned.filter(
        (tx) => tx._type === 'verification'
      ).length
    }
    // NOTE: transactionIds Set keeps these IDs — transactions are still in the pool
    // (just moved to a hash bucket); they'll be deleted from Set in clear() on commit.

    const hash = block.hash
    this.transactions[hash] = assignedTransactions
    this.transactionsCreatedAt[hash] = Date.now()

    // Add up to 20% random jitter so stalled blocks don't all reassign simultaneously
    const jitter = Math.floor(Math.random() * reassignmentTimeoutMs * 0.2)
    this.reassignmentTimers[hash] = setTimeout(() => {
      delete this.reassignmentTimers[hash]
      // remove the block hash after timeout
      if (this.transactions[hash] && this.transactions[hash].length > 0) {
        // Filter out any TXs that were committed while inflight — prevents
        // the same TX from being re-proposed in a new block after reassignment.
        const uncommitted = this.transactions[hash].filter(
          (item) => !this.committedTxIds.has(item.id)
        )
        this.transactions.unassigned = [...this.transactions.unassigned, ...uncommitted]
        delete this.transactions[hash]
        delete this.transactionsCreatedAt[hash]
        // Remove duplicates from unassigned pool — O(n) via Set
        const _seenIds = new Set()
        this.transactions.unassigned = this.transactions.unassigned.filter(
          (item) => _seenIds.size < _seenIds.add(item.id).size
        )
      }
    }, reassignmentTimeoutMs + jitter)
  }

  // get inflight blocks
  getInflightBlocks(block = undefined) {
    // unassigned is the only permanent key — all other keys are block-hash buckets
    let inflightBlocks = Object.keys(this.transactions).filter((k) => k !== 'unassigned')
    if (block?.hash) {
      inflightBlocks = inflightBlocks.filter((hash) => hash !== block.hash)
    }
    return inflightBlocks
  }

  // returns true if transaction pool is full
  // else returns false
  // Reads TRANSACTION_THRESHOLD live so the adaptive block-size logic in
  // p2pserver.js (which calls config.set to scale the threshold under load)
  // is reflected immediately without a process restart.
  poolFull() {
    return this.transactions.unassigned.length >= config.get().TRANSACTION_THRESHOLD
  }

  // wrapper function to verify transactions
  verifyTransaction(transaction) {
    return Transaction.verifyTransaction(transaction)
  }

  // checks if transactions exists or not — O(1) via Set index
  transactionExists(transaction) {
    return this.transactionIds.has(transaction.id)
  }

  // checks if transactions block hash exists or not
  hashExists(hash) {
    return this.transactions[hash] && this.transactions[hash].length > 0
  }

  // check if other hashes have the same transactions, then move them to the unassigned pool
  // check if the unassigned pool has the same transactions, then remove them
  removeDuplicates(blockHash, transactions) {
    const _beforeUnassigned = this.transactions.unassigned.length
    Object.keys(this.transactions).forEach((hash) => {
      if (blockHash === hash || 'unassigned' === hash) {
        return // skip the current block hash and unassigned pool
      }
      const existingTransactions = this.transactions[hash] || []
      const existingIds = new Set(existingTransactions.map((item) => item.id))
      const hasDuplicate = transactions.some((item) => existingIds.has(item.id))
      if (hasDuplicate) {
        this.transactions.unassigned = [...this.transactions.unassigned, ...existingTransactions]
        delete this.transactions[hash]
        delete this.transactionsCreatedAt[hash]
      }
    })
    // Deduplicate unassigned and remove committed transactions in a single O(n+m) pass.
    // Previously two separate passes: findIndex (O(n²)) + some (O(n×m)).
    const committedIds = new Set(transactions.map((t) => t.id))
    const seenIds = new Set()
    this.transactions.unassigned = this.transactions.unassigned.filter((item) => {
      if (committedIds.has(item.id) || seenIds.has(item.id)) return false
      seenIds.add(item.id)
      return true
    })
    // Keep committed IDs in the existence index so redistributed TXs
    // cannot pass transactionExists() and be re-added after commit.
    // Recount verification TXs after dedup
    this._verificationUnassignedCount = this.transactions.unassigned.filter(
      (tx) => tx._type === 'verification'
    ).length
    logger.debug(
      `REMOVE_DUPLICATES block=#${blockHash.slice(0, 8)} committed=${transactions.length}` +
        ` beforeUnassigned=${_beforeUnassigned} afterUnassigned=${this.transactions.unassigned.length}` +
        ` seenIndex=${this.transactionIds.size}`
    )
  }
  clear(hash, data) {
    // Fast exit: _handleCommit clears the pool immediately on commit, so when
    // _handleRoundChange calls clear() ~100 ms later the bucket is already gone.
    // Check if the hash bucket still exists; if not, the block was already cleared.
    if (!(hash in this.transactions) && data.length === 0) {
      return
    }

    const _beforeUnassigned = this.transactions.unassigned.length
    const _bucketSize = this.transactions[hash] ? this.transactions[hash].length : 0
    logger.log(
      `CLEAR block=#${hash.slice(0, 8)} committed=${data.length}` +
        ` beforeUnassigned=${_beforeUnassigned} bucket=${_bucketSize}` +
        ` seenIndex=${this.transactionIds.size}`
    )

    // Cancel the safety-reassignment timer — block committed successfully
    if (this.reassignmentTimers[hash]) {
      clearTimeout(this.reassignmentTimers[hash])
      delete this.reassignmentTimers[hash]
    }

    if (hash in this.transactions) {
      delete this.transactions[hash]
      delete this.transactionsCreatedAt[hash]
    }
    const removeIds = new Set(data.map((item) => item.id))
    // Track committed TX IDs so reassignment timer won't re-propose them
    removeIds.forEach((id) => this.committedTxIds.add(id))
    this.transactions.unassigned = this.transactions.unassigned.filter(
      (item) => !removeIds.has(item.id)
    )
    // Keep committed IDs in the existence index — prevents TX duplication
    // when redistribution re-broadcasts already-committed transactions.
    // Recount verification TXs — clear may remove some
    this._verificationUnassignedCount = this.transactions.unassigned.filter(
      (tx) => tx._type === 'verification'
    ).length
    logger.log(
      `CLEAR DONE block=#${hash.slice(0, 8)}` +
        ` afterUnassigned=${this.transactions.unassigned.length}` +
        ` seenIndex=${this.transactionIds.size}`
    )
  }

  // Immediately return all assigned-but-uncommitted TX back to unassigned.
  // Called on view-change quorum so the new proposer can act right away instead
  // of waiting up to 30 s for the safety-reassignment timers to fire.
  releaseAssigned() {
    Object.keys(this.transactions).forEach((hash) => {
      if (hash === 'unassigned') return
      if (this.reassignmentTimers[hash]) {
        clearTimeout(this.reassignmentTimers[hash])
        delete this.reassignmentTimers[hash]
      }
      this.transactions.unassigned = [...this.transactions.unassigned, ...this.transactions[hash]]
      delete this.transactions[hash]
      delete this.transactionsCreatedAt[hash]
    })
    // Deduplicate — a TX might exist in both unassigned and a hash bucket
    const seen = new Set()
    this.transactions.unassigned = this.transactions.unassigned.filter(
      (item) => seen.size < seen.add(item.id).size
    )
    // Filter out committed TXs — prevents re-proposal after view-change
    this.transactions.unassigned = this.transactions.unassigned.filter(
      (item) => !this.committedTxIds.has(item.id)
    )
    // Recount verification TXs after merge
    this._verificationUnassignedCount = this.transactions.unassigned.filter(
      (tx) => tx._type === 'verification'
    ).length
  }
}

module.exports = TransactionPool
