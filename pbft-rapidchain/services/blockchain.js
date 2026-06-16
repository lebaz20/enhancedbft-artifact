// Import total number of nodes used to create validators list
const config = require('../config')
const logger = require('../utils/logger')

// Used to verify block
const Block = require('./block')

const HASH_FIRST_CHAR_INDEX = 0
const MAX_RETRY_ATTEMPTS = 10
const INITIAL_RETRY_INTERVAL_MS = 300
const RETRY_INTERVAL_INCREMENT_MS = 300
const CPU_UNDER_UTILIZED_THRESHOLD = 20
const CPU_OVER_UTILIZED_THRESHOLD = 70
const RateUtility = require('../utils/rate')
const { readCgroupCPUPercentPromise } = require('../utils/cpu')
const { SHARD_STATUS } = require('../constants/status')
const { NODES_SUBSET, SUBSET_INDEX, IS_FAULTY, MIN_APPROVALS, COMMITTEE_SUBSET } = config.get()

const CPU_CACHE_INTERVAL_MS = 5000

class Blockchain {
  // committeeValidators is optional; when provided its .list is used for committee
  // proposer selection so cross-shard committee messages are routed to the right node.
  constructor(validators, transactionPool, isCore = false, committeeValidators = null) {
    if (!isCore) {
      this.validatorList = validators.generateAddresses(NODES_SUBSET)
      // Build committee validator list from the passed-in committeeValidators instance,
      // falling back to the shard validator list if no committee validators are provided.
      this.committeeValidatorList = committeeValidators?.list ?? this.validatorList
      this.transactionPool = transactionPool
      this.chain = {
        [SUBSET_INDEX]: [Block.genesis()]
      }
      // Shard nodes that are also committee members need committeeChain so that
      // getProposer / isValidBlock / addBlock work correctly for committee consensus.
      this.committeeChain = [Block.genesis()]
    } else {
      this.chain = {}
      this.committeeChain = [Block.genesis()]
    }
    // Track the rate of incoming blocks
    this.ratePerMin = {}
    // Cache CPU percentage so getRate() responds instantly without a 1s wait
    this._cpuCache = 0
    if (!isCore) {
      this._startCpuCacheUpdater()
    }
  }

  _startCpuCacheUpdater() {
    const update = () => {
      // eslint-disable-next-line promise/catch-or-return
      readCgroupCPUPercentPromise(CPU_CACHE_INTERVAL_MS)
        // eslint-disable-next-line promise/always-return
        .then((pct) => {
          this._cpuCache = pct
        })
        .catch(() => {
          // keep previous cached value on error
        })
        .finally(() => {
          this._cpuCacheTimer = setTimeout(update, CPU_CACHE_INTERVAL_MS)
        })
    }
    update()
  }

  stopCpuCacheUpdater() {
    if (this._cpuCacheTimer) {
      clearTimeout(this._cpuCacheTimer)
      this._cpuCacheTimer = null
    }
  }

  addBlock(block, subsetIndex = SUBSET_INDEX, isCommittee = false) {
    if (isCommittee) {
      this.committeeChain.push(block)
      logger.log('NEW TEMP BLOCK ADDED TO CHAIN')
      return block
    } else {
      if (!this.chain[subsetIndex]) {
        this.chain[subsetIndex] = [Block.genesis()]
      }
      block.createdAt = Date.now()
      if (!this.ratePerMin[subsetIndex]) {
        this.ratePerMin[subsetIndex] = {}
      }
      RateUtility.updateRatePerMin(this.ratePerMin[subsetIndex], block.createdAt)
      this.chain[subsetIndex].push(block)
      logger.log('NEW BLOCK ADDED TO CHAIN')
      return block
    }
  }

  createBlock(transactions, wallet, previousBlock = undefined, isCommittee = false) {
    const chainLastBlock = isCommittee
      ? this.committeeChain[this.committeeChain.length - 1]
      : this.chain[SUBSET_INDEX][this.chain[SUBSET_INDEX].length - 1]
    const block = Block.createBlock(previousBlock ?? chainLastBlock, transactions, wallet)
    return block
  }

  getProposer(blocksCount = undefined, isCommittee = false, viewOffset = 0) {
    // committeeChain is a plain array; this.chain is keyed by SUBSET_INDEX.
    // Use the array directly to avoid chain[SUBSET_INDEX] returning undefined.
    const chainArray = isCommittee ? this.committeeChain : this.chain[SUBSET_INDEX]
    // For committee, use the dedicated committee validator list and subset.
    const validatorList =
      isCommittee && this.committeeValidatorList ? this.committeeValidatorList : this.validatorList
    const nodeSubset = isCommittee && COMMITTEE_SUBSET.length > 0 ? COMMITTEE_SUBSET : NODES_SUBSET

    const currentChainLength = chainArray.length
    let blockIndex = (blocksCount ?? currentChainLength) - 1
    if (!chainArray[blockIndex]?.hash) {
      blockIndex = currentChainLength - 1
    }

    const hashCharCode = chainArray[blockIndex].hash[HASH_FIRST_CHAR_INDEX].charCodeAt(0)
    const proposerRotationModulo = validatorList.length
    const index = (hashCharCode + viewOffset) % proposerRotationModulo
    return {
      proposer: validatorList[index],
      proposerIndex: nodeSubset[index]
    }
  }

  // eslint-disable-next-line max-params
  isValidBlock(block, blocksCount, previousBlock = undefined, isCommittee = false, viewOffset = 0) {
    // committeeChain is a plain array; this.chain is keyed by SUBSET_INDEX.
    const chainArray = isCommittee ? this.committeeChain : this.chain[SUBSET_INDEX]
    const lastBlock = previousBlock ?? chainArray[chainArray.length - 1]
    if (
      lastBlock.sequenceNo + 1 === block.sequenceNo &&
      block.lastHash === lastBlock.hash &&
      block.hash === Block.blockHash(block) &&
      Block.verifyBlock(block) &&
      Block.verifyProposer(block, this.getProposer(blocksCount, isCommittee, viewOffset).proposer)
    ) {
      logger.log('BLOCK VALID')
      return true
    } else {
      logger.log(
        lastBlock.sequenceNo + 1 === block.sequenceNo,
        block.lastHash === lastBlock.hash,
        block.hash === Block.blockHash(block),
        Block.verifyBlock(block),
        Block.verifyProposer(block, this.getProposer(blocksCount, isCommittee, viewOffset).proposer)
      )
      logger.error('BLOCK INVALID')
      return false
    }
  }

  // eslint-disable-next-line max-params
  async addUpdatedBlock(hash, blockPool, preparePool, commitPool, isCommittee = false) {
    const blockExists = await this.waitUntilAvailableBlock(hash, (hash) =>
      blockPool.existingBlockByHash(hash, isCommittee)
    )
    if (blockExists) {
      const block = blockPool.getBlock(hash, isCommittee)
      const previousBlockExists = await this.waitUntilAvailableBlock(block.lastHash, (hash) =>
        this.existingBlock(hash, SUBSET_INDEX, isCommittee)
      )
      if (previousBlockExists) {
        // Guard against concurrent commit handlers that both passed the
        // blockNotInChain check before the first handler's addBlock completed.
        if (this.existingBlock(hash, SUBSET_INDEX, isCommittee)) return false
        // handles nodes that missed pre_prepare and never called assignTransactions
        this.transactionPool.removeDuplicates(block.hash, block.data, isCommittee)
        block.prepareMessages = preparePool.getList(hash, isCommittee)
        block.commitMessages = commitPool.getList(hash, isCommittee)
        this.addBlock(block, SUBSET_INDEX, isCommittee)
        return block
      }
      logger.error(`FAILED TO LOCATE PREVIOUS BLOCK #${block.lastHash}`)
      return false
    }
    logger.error(`FAILED TO LOCATE BLOCK #${hash}`)
    return false
  }

  existingBlock(hash, subsetIndex = SUBSET_INDEX, isCommittee = false) {
    return !!(isCommittee ? this.committeeChain : this.chain[subsetIndex])?.find(
      (b) => b.hash === hash
    )
  }

  waitUntilAvailableBlock(item, existingCheck) {
    return new Promise((resolve) => {
      function recExistingCheck(retryInterval, retrialCount) {
        if (existingCheck(item)) {
          resolve(true)
        } else if (retrialCount <= MAX_RETRY_ATTEMPTS) {
          setTimeout(
            () => recExistingCheck(retryInterval + RETRY_INTERVAL_INCREMENT_MS, retrialCount + 1),
            retryInterval + RETRY_INTERVAL_INCREMENT_MS
          )
        } else {
          resolve(false)
        }
      }
      recExistingCheck(INITIAL_RETRY_INTERVAL_MS, 1)
    })
  }

  // get total number of blocks and transactions
  getTotal() {
    const total = {}
    Object.keys(this.chain).forEach((subsetIndex) => {
      // Subtract 1 to exclude the genesis block (always present, always has 0 transactions)
      const actualBlocksCount = Math.max(0, this.chain[subsetIndex].length - 1)
      total[subsetIndex] = {
        blocks: actualBlocksCount,
        transactions: this.chain[subsetIndex]
          .slice(1)
          .reduce((sum, block) => sum + block.data.length, 0),
        // Count ALL pending (unconfirmed) transactions — unassigned plus those
        // assigned to inflight blocks that have not yet been committed.  Without
        // this, dead-shard honest nodes report 0 unassigned while their TXs are
        // stuck in transactions[blockHash], making the drain rate look like 99%
        // when those TXs will never be confirmed.
        unassignedTransactions:
          subsetIndex === SUBSET_INDEX
            ? (() => {
                if (!this.transactionPool) return 0
                const pool = this.transactionPool.transactions
                const unassigned = pool.unassigned.length
                // Sum TXs in all inflight-block buckets (keys other than 'unassigned')
                const assigned = Object.entries(pool)
                  .filter(([k]) => k !== 'unassigned')
                  .reduce((sum, [, txs]) => sum + (Array.isArray(txs) ? txs.length : 0), 0)
                return unassigned + assigned
              })()
            : 0
      }
    })
    // Committee chain is intentionally excluded: its blocks contain the same
    // transactions already committed in shard chains (re-wrapped for cross-shard
    // finality), so including them would double-count every transaction.
    return total
  }

  // get shard rate of blocks and transactions
  async getRate(sockets) {
    let nonFaultyNodesCount = Object.keys(sockets).filter((port) => !sockets[port].isFaulty).length
    if (!IS_FAULTY) {
      nonFaultyNodesCount++
    }

    const cpuPercentage = this._cpuCache
    const previousMinute = RateUtility.getPreviousMinute()
    const currentShardTransactionsRate = RateUtility.getRatePerMin(
      this.transactionPool?.ratePerMin,
      previousMinute
    )
    // let currentShardBlocksRate;
    const rate = {
      blocks: {},
      transactions: {
        [SUBSET_INDEX]: currentShardTransactionsRate
      }
    }
    Object.keys(this.chain).forEach((subsetIndex) => {
      const blocksRate = RateUtility.getRatePerMin(this.ratePerMin[subsetIndex], previousMinute)
      rate.blocks[subsetIndex] = blocksRate
      // if (subsetIndex === SUBSET_INDEX) {
      //   currentShardBlocksRate = blocksRate;
      // }
    })

    // const currentShardProcessedTransactionsPeakRate = currentShardBlocksRate * TRANSACTION_THRESHOLD + TRANSACTION_THRESHOLD;
    let shardStatus = SHARD_STATUS.normal
    // didn't build a single block or transaction rate is more than double the produced blocks rate
    // TODO: track failed consensus attempts
    // } else if (!currentShardBlocksRate || currentShardTransactionsRate > currentShardProcessedTransactionsPeakRate * 2) {
    if (nonFaultyNodesCount < MIN_APPROVALS) {
      shardStatus = SHARD_STATUS.faulty
    } else if (cpuPercentage < CPU_UNDER_UTILIZED_THRESHOLD) {
      shardStatus = SHARD_STATUS.under_utilized
    } else if (cpuPercentage > CPU_OVER_UTILIZED_THRESHOLD) {
      shardStatus = SHARD_STATUS.over_utilized
    }

    rate.shardStatus = shardStatus
    // rate.shardStatus = SUBSET_INDEX === 'SUBSET1' ? SHARD_STATUS.faulty : SHARD_STATUS.normal;
    rate.nodeIndex = `NODE${process.env.HTTP_PORT.slice(1)}`
    rate.shardIndex = SUBSET_INDEX
    rate.shardSize = sockets ? Object.keys(sockets).length + 1 : 0
    rate.cpu = `${cpuPercentage.toString()}%`
    return rate
  }
}
module.exports = Blockchain
