// Import transaction class used for verification
const Transaction = require('../transaction')
const RateUtility = require('../../utils/rate')
const logger = require('../../utils/logger')

// Transaction threshold is the limit or the holding capacity of the nodes
// Once this exceeds a new block is generated
const config = require('../../config')
const TIMEOUTS = require('../../constants/timeouts')
const { TRANSACTION_THRESHOLD, BLOCK_THRESHOLD } = config.get()

class TransactionPool {
  constructor() {
    this.transactions = { unassigned: [] }
    this.transactionIds = new Set() // O(1) existence index for shard transactions
    this.transactionsCreatedAt = {}
    this.committeeTransactions = { unassigned: [] }
    this.committeeTransactionIds = new Set() // O(1) existence index for committee transactions
    this.reassignmentTimers = {}
    // Committed TX IDs — prevents TXs from being re-proposed after the
    // safety-reassignment timer moves them back to unassigned.
    this.committedTxIds = new Set()
    this.committedCommitteeTxIds = new Set()
    // Track the rate of incoming transactions
    this.ratePerMin = {}
  }

  // pushes transactions in the list
  addTransaction(transaction, isCommittee = false) {
    if (isCommittee) {
      if (!this.committeeTransactions) {
        this.committeeTransactions = { unassigned: [] }
      }
      this.committeeTransactions.unassigned.push(transaction)
      this.committeeTransactionIds.add(transaction.id)
    } else {
      this.transactions.unassigned.push(transaction)
      this.transactionIds.add(transaction.id)
      RateUtility.updateRatePerMin(this.ratePerMin, transaction.createdAt)
    }
  }

  // assign block transactions to the block via block hash
  // Release assignment after x time in case block creation doesn't succeed
  assignTransactions(block, isCommittee = false) {
    const assignedTransactions = block.data
    if (!isCommittee) {
      const removeIds = new Set(assignedTransactions.map((item) => item.id))
      this.transactions.unassigned = this.transactions.unassigned.filter(
        (item) => !removeIds.has(item.id)
      )

      const hash = block.hash
      this.transactions[hash] = assignedTransactions
      this.transactionsCreatedAt[hash] = Date.now()

      const jitter = Math.floor(Math.random() * TIMEOUTS.TRANSACTION_REASSIGNMENT_TIMEOUT_MS * 0.2)
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
      }, TIMEOUTS.TRANSACTION_REASSIGNMENT_TIMEOUT_MS + jitter) // timeout + jitter
    } else {
      const removeIds = new Set(assignedTransactions.map((item) => item.id))
      this.committeeTransactions.unassigned = this.committeeTransactions.unassigned.filter(
        (item) => !removeIds.has(item.id)
      )

      const hash = block.hash
      this.committeeTransactions[hash] = assignedTransactions
      const committeeJitter = Math.floor(
        Math.random() * TIMEOUTS.TRANSACTION_REASSIGNMENT_TIMEOUT_MS * 0.2
      )
      this.reassignmentTimers[`committee_${hash}`] = setTimeout(() => {
        delete this.reassignmentTimers[`committee_${hash}`]
        // remove the block hash after timeout
        if (this.committeeTransactions[hash] && this.committeeTransactions[hash].length > 0) {
          const uncommitted = this.committeeTransactions[hash].filter(
            (item) => !this.committedCommitteeTxIds.has(item.id)
          )
          this.committeeTransactions.unassigned = [
            ...this.committeeTransactions.unassigned,
            ...uncommitted
          ]
          delete this.committeeTransactions[hash]
          // Remove duplicates from unassigned pool — O(n) via Set
          const _cSeenIds2 = new Set()
          this.committeeTransactions.unassigned = this.committeeTransactions.unassigned.filter(
            (item) => _cSeenIds2.size < _cSeenIds2.add(item.id).size
          )
        }
      }, TIMEOUTS.TRANSACTION_REASSIGNMENT_TIMEOUT_MS + committeeJitter) // timeout + jitter
    }
  }

  // get inflight blocks
  getInflightBlocks(block = undefined, isCommittee = false) {
    // unassigned is the only key we have in case no inbound transactions
    let inflightBlocks = Object.keys(isCommittee ? this.committeeTransactions : this.transactions)
    if (block?.hash) {
      inflightBlocks = inflightBlocks.filter((hash) => hash !== block.hash)
    }
    return inflightBlocks
  }

  // returns true if transaction pool is full
  // else returns false
  poolFull(isCommittee = false) {
    if (isCommittee) {
      return this.committeeTransactions.unassigned.length >= BLOCK_THRESHOLD
    }
    return this.transactions.unassigned.length >= TRANSACTION_THRESHOLD
  }

  // wrapper function to verify transactions
  verifyTransaction(transaction) {
    return Transaction.verifyTransaction(transaction)
  }

  // checks if transactions exists or not — O(1) via Set index
  transactionExists(transaction, isCommittee = false) {
    return isCommittee
      ? this.committeeTransactionIds.has(transaction.id)
      : this.transactionIds.has(transaction.id)
  }

  // checks if transactions block hash exists or not
  hashExists(hash, isCommittee = false) {
    return (
      (isCommittee ? this.committeeTransactions : this.transactions)[hash] &&
      (isCommittee ? this.committeeTransactions : this.transactions)[hash].length > 0
    )
  }

  // check if other hashes have the same transactions, then move them to the unassigned pool
  // check if the unassigned pool has the same transactions, then remove them
  removeDuplicates(blockHash, transactions, isCommittee = false) {
    const _beforeUnassigned = isCommittee
      ? this.committeeTransactions.unassigned.length
      : this.transactions.unassigned.length
    if (isCommittee) {
      Object.keys(this.committeeTransactions).forEach((hash) => {
        if (blockHash === hash || 'unassigned' === hash) {
          return // skip the current block hash and unassigned pool
        }
        const existingTransactions = this.committeeTransactions[hash] || []
        const existingIds = new Set(existingTransactions.map((item) => item.id))
        const hasDuplicate = transactions.some((item) => existingIds.has(item.id))
        if (hasDuplicate) {
          this.committeeTransactions.unassigned = [
            ...this.committeeTransactions.unassigned,
            ...existingTransactions
          ]
          delete this.committeeTransactions[hash]
        }
      })
      // Remove duplicates from unassigned pool (O(n) via Set)
      const _cSeenIds = new Set()
      this.committeeTransactions.unassigned = this.committeeTransactions.unassigned.filter(
        (item) => _cSeenIds.size < _cSeenIds.add(item.id).size
      )
      // Filter out transactions that are being committed — O(n+m) via Set
      const _cCommittedIds = new Set(transactions.map((t) => t.id))
      this.committeeTransactions.unassigned = this.committeeTransactions.unassigned.filter(
        (item) => !_cCommittedIds.has(item.id)
      )
      // Keep committed IDs in the existence index so redistributed TXs
      // cannot pass transactionExists() and be re-added after commit.
    } else {
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
      // Remove duplicates from unassigned pool (O(n) via Set)
      const _seenIds = new Set()
      this.transactions.unassigned = this.transactions.unassigned.filter(
        (item) => _seenIds.size < _seenIds.add(item.id).size
      )
      // Filter out transactions that are being committed — O(n+m) via Set
      const _committedIds = new Set(transactions.map((t) => t.id))
      this.transactions.unassigned = this.transactions.unassigned.filter(
        (item) => !_committedIds.has(item.id)
      )
      // Keep committed IDs in the existence index so redistributed TXs
      // cannot pass transactionExists() and be re-added after commit.
    }
    const _afterUnassigned = isCommittee
      ? this.committeeTransactions.unassigned.length
      : this.transactions.unassigned.length
    const _afterIds = isCommittee ? this.committeeTransactionIds.size : this.transactionIds.size
    logger.debug(
      `REMOVE_DUPLICATES block=#${blockHash.slice(0, 8)} committed=${transactions.length}` +
        ` beforeUnassigned=${_beforeUnassigned} afterUnassigned=${_afterUnassigned}` +
        ` seenIndex=${_afterIds} isCommittee=${isCommittee}`
    )
  }

  // empties the pool
  clear(hash, data, isCommittee = false) {
    // Fast exit: _handleCommit clears the pool immediately on commit, so when
    // _handleRoundChange calls clear() ~100 ms later the bucket is already gone.
    // Check if the hash bucket still exists; if not, the block was already cleared.
    const _txStore = isCommittee ? this.committeeTransactions : this.transactions
    if (!(hash in _txStore) && data.length === 0) {
      return
    }

    const _pool = isCommittee ? this.committeeTransactions : this.transactions
    const _ids = isCommittee ? this.committeeTransactionIds : this.transactionIds
    const _beforeUnassigned = _pool.unassigned.length
    const _bucketSize = _pool[hash] ? _pool[hash].length : 0
    logger.log(
      `CLEAR block=#${hash.slice(0, 8)} committed=${data.length}` +
        ` beforeUnassigned=${_beforeUnassigned} bucket=${_bucketSize}` +
        ` seenIndex=${_ids.size} isCommittee=${isCommittee}`
    )

    // Cancel the safety-reassignment timer — block committed successfully
    const timerKey = isCommittee ? `committee_${hash}` : hash
    if (this.reassignmentTimers[timerKey]) {
      clearTimeout(this.reassignmentTimers[timerKey])
      delete this.reassignmentTimers[timerKey]
    }

    if (isCommittee) {
      if (hash in this.committeeTransactions) {
        delete this.committeeTransactions[hash]
        delete this.committeeTransactionsCreatedAt[hash]
      }
      const removeIds = new Set(data.map((item) => item.id))
      // Track committed TX IDs so reassignment timer won't re-propose them
      removeIds.forEach((id) => this.committedCommitteeTxIds.add(id))
      this.committeeTransactions.unassigned = this.committeeTransactions.unassigned.filter(
        (item) => !removeIds.has(item.id)
      )
      // Keep committed IDs in the existence index — prevents TX duplication
      // when redistribution re-broadcasts already-committed transactions.
    } else {
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
    }
    logger.log(
      `CLEAR DONE block=#${hash.slice(0, 8)}` +
        ` afterUnassigned=${_pool.unassigned.length}` +
        ` seenIndex=${_ids.size}`
    )
  }

  // Immediately return all assigned-but-uncommitted TX back to unassigned.
  // Called on view-change quorum so the new proposer can act right away instead
  // of waiting up to 30 s for the safety-reassignment timers to fire.
  releaseAssigned(isCommittee = false) {
    const pool = isCommittee ? this.committeeTransactions : this.transactions
    const committedSet = isCommittee ? this.committedCommitteeTxIds : this.committedTxIds
    const timerPrefix = isCommittee ? 'committee_' : ''
    Object.keys(pool).forEach((hash) => {
      if (hash === 'unassigned') return
      const timerKey = `${timerPrefix}${hash}`
      if (this.reassignmentTimers[timerKey]) {
        clearTimeout(this.reassignmentTimers[timerKey])
        delete this.reassignmentTimers[timerKey]
      }
      pool.unassigned = [...pool.unassigned, ...pool[hash]]
      delete pool[hash]
      if (!isCommittee) delete this.transactionsCreatedAt[hash]
    })
    // Deduplicate — a TX might exist in both unassigned and a hash bucket
    const seen = new Set()
    pool.unassigned = pool.unassigned.filter((item) => seen.size < seen.add(item.id).size)
    // Filter out committed TXs — prevents re-proposal after view-change
    pool.unassigned = pool.unassigned.filter((item) => !committedSet.has(item.id))
  }
}

module.exports = TransactionPool
