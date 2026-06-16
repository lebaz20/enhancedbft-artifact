const Blockchain = require('../services/blockchain')
const Block = require('../services/block')
const Validators = require('../services/validators')

// Mock config
jest.mock('../config', () => ({
  get: () => ({
    NODES_SUBSET: [0, 1, 2, 3],
    NUMBER_OF_NODES_PER_SHARD: 4,
    SUBSET_INDEX: 'SUBSET0',
    IS_FAULTY: false,
    MIN_APPROVALS: 3,
    COMMITTEE_SUBSET: []
  })
}))

// Mock cpu utils to avoid cgroup file dependency and prevent background timer
jest.mock('../utils/cpu', () => ({
  readCgroupCPUPercentPromise: jest.fn().mockResolvedValue(50)
}))

// Mock logger
jest.mock('../utils/logger', () => ({
  log: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}))

describe('Blockchain', () => {
  let blockchain
  let validators
  let mockTransactionPool

  beforeEach(() => {
    validators = new Validators([0, 1, 2, 3])
    mockTransactionPool = {
      transactions: { unassigned: [] },
      ratePerMin: {},
      hashExists: jest.fn().mockReturnValue(true),
      removeDuplicates: jest.fn()
    }
    blockchain = new Blockchain(validators, mockTransactionPool)
  })

  afterEach(() => {
    blockchain.stopCpuCacheUpdater()
  })

  describe('constructor', () => {
    it('should create a blockchain with a genesis block', () => {
      expect(blockchain.chain.SUBSET0).toBeDefined()
      expect(blockchain.chain.SUBSET0.length).toBe(1)
      expect(blockchain.chain.SUBSET0[0].sequenceNo).toBe(0)
    })

    it('should initialize validator list', () => {
      expect(blockchain.validatorList).toBeDefined()
      expect(Array.isArray(blockchain.validatorList)).toBe(true)
      expect(blockchain.validatorList.length).toBe(4)
    })

    it('should initialize transaction pool', () => {
      expect(blockchain.transactionPool).toBe(mockTransactionPool)
    })

    it('should initialize ratePerMin', () => {
      expect(blockchain.ratePerMin).toBeDefined()
      expect(typeof blockchain.ratePerMin).toBe('object')
    })

    it('should create core blockchain without chain when isCore=true', () => {
      const coreBlockchain = new Blockchain(validators, mockTransactionPool, true)
      expect(coreBlockchain.chain).toEqual({})
      expect(coreBlockchain.validatorList).toBeUndefined()
    })

    it('should initialize committeeChain when isCore=true', () => {
      const coreBlockchain = new Blockchain(validators, mockTransactionPool, true)
      expect(coreBlockchain.committeeChain).toBeDefined()
      expect(Array.isArray(coreBlockchain.committeeChain)).toBe(true)
      expect(coreBlockchain.committeeChain.length).toBe(1)
      expect(coreBlockchain.committeeChain[0].sequenceNo).toBe(0)
    })
  })

  describe('addBlock', () => {
    it('should add a block to the chain', () => {
      const block = { hash: 'test-hash', data: [], createdAt: Date.now() }
      const initialLength = blockchain.chain.SUBSET0.length

      blockchain.addBlock(block)

      expect(blockchain.chain.SUBSET0.length).toBe(initialLength + 1)
      expect(blockchain.chain.SUBSET0[blockchain.chain.SUBSET0.length - 1]).toBe(block)
    })

    it('should set createdAt timestamp on block', () => {
      const block = { hash: 'test-hash', data: [] }
      const beforeTime = Date.now()

      blockchain.addBlock(block)

      expect(block.createdAt).toBeDefined()
      expect(block.createdAt).toBeGreaterThanOrEqual(beforeTime)
    })

    it('should initialize chain for new subset index', () => {
      const block = { hash: 'test-hash', data: [], createdAt: Date.now() }

      blockchain.addBlock(block, 'SUBSET1')

      expect(blockchain.chain.SUBSET1).toBeDefined()
      expect(blockchain.chain.SUBSET1.length).toBe(2) // Genesis + new block
    })

    it('should update rate per minute', () => {
      const block = { hash: 'test-hash', data: [], createdAt: Date.now() }

      blockchain.addBlock(block)

      expect(blockchain.ratePerMin.SUBSET0).toBeDefined()
    })

    it('should add block to committeeChain when isCommittee=true', () => {
      const coreBlockchain = new Blockchain(validators, mockTransactionPool, true)
      const block = { hash: 'committee-hash', data: [], createdAt: Date.now() }
      const initialLength = coreBlockchain.committeeChain.length

      coreBlockchain.addBlock(block, undefined, true)

      expect(coreBlockchain.committeeChain.length).toBe(initialLength + 1)
      expect(coreBlockchain.committeeChain[coreBlockchain.committeeChain.length - 1]).toBe(block)
    })

    it('should add block to regular chain when isCommittee=false', () => {
      const block = { hash: 'regular-hash', data: [], createdAt: Date.now() }
      const initialLength = blockchain.chain.SUBSET0.length

      blockchain.addBlock(block, 'SUBSET0', false)

      expect(blockchain.chain.SUBSET0.length).toBe(initialLength + 1)
      expect(blockchain.chain.SUBSET0[blockchain.chain.SUBSET0.length - 1]).toBe(block)
    })
  })

  describe('createBlock', () => {
    it('should create a new block', () => {
      const Wallet = require('../services/wallet')
      const wallet = new Wallet('test-proposer')
      const transactions = [{ id: '1' }]

      const block = blockchain.createBlock(transactions, wallet)

      expect(block).toBeDefined()
      expect(block.data).toEqual(transactions)
    })

    it('should use provided previous block', () => {
      const Wallet = require('../services/wallet')
      const wallet = new Wallet('test-proposer')
      const transactions = []
      const previousBlock = blockchain.chain.SUBSET0[0]

      const block = blockchain.createBlock(transactions, wallet, previousBlock)

      expect(block.lastHash).toBe(previousBlock.hash)
      expect(block.sequenceNo).toBe(previousBlock.sequenceNo + 1)
    })

    it('should use last block in chain if no previous block provided', () => {
      const Wallet = require('../services/wallet')
      const wallet = new Wallet('test-proposer')
      const transactions = []

      const block = blockchain.createBlock(transactions, wallet)

      const lastBlock = blockchain.chain.SUBSET0[blockchain.chain.SUBSET0.length - 1]
      expect(block.lastHash).toBe(lastBlock.hash)
    })
  })

  describe('getProposer', () => {
    it('should return a proposer from validator list', () => {
      const result = blockchain.getProposer()

      expect(result.proposer).toBeDefined()
      expect(blockchain.validatorList).toContain(result.proposer)
      expect(result.proposerIndex).toBeDefined()
    })

    it('should return consistent proposer for same block count and minute', () => {
      const result1 = blockchain.getProposer()
      const result2 = blockchain.getProposer()

      expect(result1.proposer).toBe(result2.proposer)
      expect(result1.proposerIndex).toBe(result2.proposerIndex)
    })

    it('should handle custom blocks count', () => {
      const result = blockchain.getProposer(5)

      expect(result.proposer).toBeDefined()
      expect(blockchain.validatorList).toContain(result.proposer)
    })

    it('should work with isCommittee parameter', () => {
      // For P2P blockchain (not core), isCommittee parameter is available
      const result = blockchain.getProposer(undefined, false)

      expect(result.proposer).toBeDefined()
      expect(blockchain.validatorList).toContain(result.proposer)
    })
  })

  describe('existingBlock', () => {
    it('should return true for existing block', () => {
      const genesisHash = blockchain.chain.SUBSET0[0].hash

      expect(blockchain.existingBlock(genesisHash)).toBe(true)
    })

    it('should return false for non-existing block', () => {
      expect(blockchain.existingBlock('non-existing-hash')).toBe(false)
    })

    it('should check specific subset index', () => {
      const block = { hash: 'test-hash', data: [] }
      blockchain.addBlock(block, 'SUBSET1')

      expect(blockchain.existingBlock('test-hash', 'SUBSET1')).toBe(true)
      expect(blockchain.existingBlock('test-hash', 'SUBSET0')).toBe(false)
    })

    it('should return false for undefined subset', () => {
      expect(blockchain.existingBlock('any-hash', 'SUBSET999')).toBe(false)
    })
  })

  describe('getTotal', () => {
    it('should return total blocks and transactions', () => {
      const total = blockchain.getTotal()

      expect(total.SUBSET0).toBeDefined()
      // Genesis block is excluded from the count (it has no real transactions)
      expect(total.SUBSET0.blocks).toBe(0)
      expect(total.SUBSET0.transactions).toBe(0)
      expect(total.SUBSET0.unassignedTransactions).toBe(0)
    })

    it('should count transactions in blocks', () => {
      const block1 = { hash: 'hash1', data: [{ id: '1' }, { id: '2' }] }
      const block2 = { hash: 'hash2', data: [{ id: '3' }] }

      blockchain.addBlock(block1)
      blockchain.addBlock(block2)

      const total = blockchain.getTotal()

      expect(total.SUBSET0.blocks).toBe(2) // 2 real blocks (genesis excluded)
      expect(total.SUBSET0.transactions).toBe(3)
    })

    it('should handle multiple subsets', () => {
      const block = { hash: 'hash1', data: [{ id: '1' }] }
      blockchain.addBlock(block, 'SUBSET1')

      const total = blockchain.getTotal()

      expect(total.SUBSET0.blocks).toBe(0) // genesis only, no real blocks
      expect(total.SUBSET1.blocks).toBe(1) // genesis + 1 real block → 1 real block
    })
  })

  describe('waitUntilAvailableBlock', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should resolve immediately if item exists', async () => {
      const existingCheck = jest.fn().mockReturnValue(true)

      const result = await blockchain.waitUntilAvailableBlock('item', existingCheck)

      expect(result).toBe(true)
      expect(existingCheck).toHaveBeenCalledWith('item')
    })

    it('should resolve false after max retries', async () => {
      const existingCheck = jest.fn().mockReturnValue(false)

      const resultPromise = blockchain.waitUntilAvailableBlock('item', existingCheck)
      await jest.runAllTimersAsync()

      const result = await resultPromise
      expect(result).toBe(false)
    })

    it('should retry until item becomes available', async () => {
      let callCount = 0
      const existingCheck = jest.fn(() => {
        callCount++
        return callCount >= 2 // Make it succeed on 2nd try instead of 3rd
      })

      const resultPromise = blockchain.waitUntilAvailableBlock('item', existingCheck)
      await jest.runAllTimersAsync()

      const result = await resultPromise
      expect(result).toBe(true)
      expect(callCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe('isValidBlock', () => {
    it('should validate a correct block', () => {
      const Wallet = require('../services/wallet')
      // Get the expected proposer for this block
      const proposerInfo = blockchain.getProposer()
      const proposerIndex = proposerInfo.proposerIndex
      const wallet = new Wallet(`NODE${proposerIndex}`)

      const block = blockchain.createBlock([], wallet)
      const blocksCount = blockchain.chain.SUBSET0.length

      const isValid = blockchain.isValidBlock(block, blocksCount)

      expect(isValid).toBe(true)
    })

    it('should reject block with wrong sequence number', () => {
      const Wallet = require('../services/wallet')
      const proposerInfo = blockchain.getProposer()
      const proposerIndex = proposerInfo.proposerIndex
      const wallet = new Wallet(`NODE${proposerIndex}`)

      const block = blockchain.createBlock([], wallet)
      block.sequenceNo = 999
      const blocksCount = blockchain.chain.SUBSET0.length

      const isValid = blockchain.isValidBlock(block, blocksCount)

      expect(isValid).toBe(false)
    })

    it('should reject block with wrong lastHash', () => {
      const Wallet = require('../services/wallet')
      const proposerInfo = blockchain.getProposer()
      const proposerIndex = proposerInfo.proposerIndex
      const wallet = new Wallet(`NODE${proposerIndex}`)

      const block = blockchain.createBlock([], wallet)
      block.lastHash = 'wrong-hash'
      const blocksCount = blockchain.chain.SUBSET0.length

      const isValid = blockchain.isValidBlock(block, blocksCount)

      expect(isValid).toBe(false)
    })

    it('should support isCommittee parameter in validation', () => {
      const Wallet = require('../services/wallet')
      const proposerInfo = blockchain.getProposer()
      const proposerIndex = proposerInfo.proposerIndex
      const wallet = new Wallet(`NODE${proposerIndex}`)

      const block = blockchain.createBlock([], wallet)
      const blocksCount = blockchain.chain.SUBSET0.length
      const previousBlock = blockchain.chain.SUBSET0[blocksCount - 1]

      // Test with isCommittee=false
      const isValid = blockchain.isValidBlock(block, blocksCount, previousBlock, false)

      expect(isValid).toBe(true)
    })
  })
})
