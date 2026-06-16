const TransactionPool = require('../services/pools/transaction')
const Transaction = require('../services/transaction')
const Wallet = require('../services/wallet')

// Mock config
jest.mock('../config', () => ({
  get: () => ({
    TRANSACTION_THRESHOLD: 5
  })
}))

describe('TransactionPool', () => {
  let transactionPool
  let wallet

  beforeEach(() => {
    transactionPool = new TransactionPool()
    wallet = new Wallet('test-secret')
    jest.clearAllTimers()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('constructor', () => {
    it('should initialize with empty unassigned transactions', () => {
      expect(transactionPool.transactions).toBeDefined()
      expect(transactionPool.transactions.unassigned).toBeDefined()
      expect(Array.isArray(transactionPool.transactions.unassigned)).toBe(true)
      expect(transactionPool.transactions.unassigned.length).toBe(0)
    })

    it('should initialize empty committeeTransactions object', () => {
      expect(transactionPool.committeeTransactions).toBeDefined()
      expect(typeof transactionPool.committeeTransactions).toBe('object')
    })

    it('should initialize empty ratePerMin', () => {
      expect(transactionPool.ratePerMin).toBeDefined()
      expect(typeof transactionPool.ratePerMin).toBe('object')
    })

    it('should initialize empty transactionsCreatedAt', () => {
      expect(transactionPool.transactionsCreatedAt).toBeDefined()
      expect(typeof transactionPool.transactionsCreatedAt).toBe('object')
    })
  })

  describe('addTransaction', () => {
    it('should add transaction to unassigned pool', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )

      transactionPool.addTransaction(transaction)

      expect(transactionPool.transactions.unassigned.length).toBe(1)
      expect(transactionPool.transactions.unassigned[0]).toBe(transaction)
    })

    it('should add multiple transactions', () => {
      const tx1 = new Transaction(
        { recipient: 'recipient1', amount: 100 },
        wallet
      )
      const tx2 = new Transaction(
        { recipient: 'recipient2', amount: 200 },
        wallet
      )

      transactionPool.addTransaction(tx1)
      transactionPool.addTransaction(tx2)

      expect(transactionPool.transactions.unassigned.length).toBe(2)
    })

    it('should update rate per minute', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )

      transactionPool.addTransaction(transaction)

      expect(Object.keys(transactionPool.ratePerMin).length).toBeGreaterThan(0)
    })

    it('should add transaction to committeeTransactions when isCommittee=true', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )

      transactionPool.addTransaction(transaction, true)

      expect(transactionPool.committeeTransactions.unassigned).toBeDefined()
      expect(
        Array.isArray(transactionPool.committeeTransactions.unassigned)
      ).toBe(true)
      expect(transactionPool.committeeTransactions.unassigned.length).toBe(1)
      expect(transactionPool.committeeTransactions.unassigned[0]).toBe(
        transaction
      )
      expect(transactionPool.transactions.unassigned.length).toBe(0)
    })

    it('should add transaction to regular pool when isCommittee=false', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )

      transactionPool.addTransaction(transaction, false)

      expect(transactionPool.transactions.unassigned.length).toBe(1)
      expect(transactionPool.transactions.unassigned[0]).toBe(transaction)
    })
  })

  describe('assignTransactions', () => {
    it('should assign transactions to block', () => {
      const tx1 = new Transaction(
        { recipient: 'recipient1', amount: 100 },
        wallet
      )
      const tx2 = new Transaction(
        { recipient: 'recipient2', amount: 200 },
        wallet
      )

      transactionPool.addTransaction(tx1)
      transactionPool.addTransaction(tx2)

      const block = { hash: 'block-hash', data: [tx1, tx2] }

      transactionPool.assignTransactions(block)

      expect(transactionPool.transactions.unassigned.length).toBe(0)
      expect(transactionPool.transactions['block-hash']).toBeDefined()
      expect(transactionPool.transactions['block-hash'].length).toBe(2)
    })

    it('should track assignment time', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)

      const block = { hash: 'block-hash', data: [tx] }
      const beforeTime = Date.now()

      transactionPool.assignTransactions(block)

      expect(transactionPool.transactionsCreatedAt['block-hash']).toBeDefined()
      expect(
        transactionPool.transactionsCreatedAt['block-hash']
      ).toBeGreaterThanOrEqual(beforeTime)
    })

    it('should reassign transactions after timeout', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)

      const block = { hash: 'block-hash', data: [tx] }
      transactionPool.assignTransactions(block)

      expect(transactionPool.transactions.unassigned.length).toBe(0)

      // Fast forward 2 minutes
      jest.advanceTimersByTime(3 * 60 * 1000)

      expect(transactionPool.transactions.unassigned.length).toBe(1)
      expect(transactionPool.transactions['block-hash']).toBeUndefined()
    })

    it('should not reassign if transactions were cleared', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)

      const block = { hash: 'block-hash', data: [tx] }
      transactionPool.assignTransactions(block)
      transactionPool.clear('block-hash', [tx])

      jest.advanceTimersByTime(3 * 60 * 1000)

      expect(transactionPool.transactions.unassigned.length).toBe(0)
    })

    it('should assign committee transactions when isCommittee=true', () => {
      const tx1 = new Transaction(
        { recipient: 'recipient1', amount: 100 },
        wallet
      )
      const tx2 = new Transaction(
        { recipient: 'recipient2', amount: 200 },
        wallet
      )

      transactionPool.addTransaction(tx1, true)
      transactionPool.addTransaction(tx2, true)

      const block = { hash: 'committee-block-hash', data: [tx1, tx2] }

      transactionPool.assignTransactions(block, true)

      expect(transactionPool.committeeTransactions.unassigned.length).toBe(0)
      expect(
        transactionPool.committeeTransactions['committee-block-hash']
      ).toBeDefined()
      expect(
        transactionPool.committeeTransactions['committee-block-hash'].length
      ).toBe(2)
    })

    it('should remove duplicates when reassigning', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)

      const block = { hash: 'block-hash', data: [tx] }
      transactionPool.assignTransactions(block)

      // Add the same transaction again
      transactionPool.addTransaction(tx)

      jest.advanceTimersByTime(3 * 60 * 1000)

      expect(transactionPool.transactions.unassigned.length).toBe(1)
    })
  })

  describe('getInflightBlocks', () => {
    it('should return inflight block hashes', () => {
      const tx1 = new Transaction(
        { recipient: 'recipient1', amount: 100 },
        wallet
      )
      const tx2 = new Transaction(
        { recipient: 'recipient2', amount: 200 },
        wallet
      )

      transactionPool.addTransaction(tx1)
      transactionPool.addTransaction(tx2)

      const block1 = { hash: 'hash1', data: [tx1] }
      const block2 = { hash: 'hash2', data: [tx2] }

      transactionPool.assignTransactions(block1)
      transactionPool.assignTransactions(block2)

      const inflight = transactionPool.getInflightBlocks()

      expect(inflight.length).toBeGreaterThanOrEqual(2)
      expect(inflight).toContain('hash1')
      expect(inflight).toContain('hash2')
    })

    it('should exclude specific block hash', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)

      const block = { hash: 'exclude-hash', data: [tx] }
      transactionPool.assignTransactions(block)

      const inflight = transactionPool.getInflightBlocks(block)

      expect(inflight).not.toContain('exclude-hash')
    })
  })

  describe('poolFull', () => {
    it('should return false when pool is not full', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)

      expect(transactionPool.poolFull()).toBe(false)
    })

    it('should return true when pool reaches threshold', () => {
      for (let i = 0; i < 5; i++) {
        const tx = new Transaction(
          { recipient: `recipient${i}`, amount: 100 },
          wallet
        )
        transactionPool.addTransaction(tx)
      }

      expect(transactionPool.poolFull()).toBe(true)
    })

    it('should return true when pool exceeds threshold', () => {
      for (let i = 0; i < 6; i++) {
        const tx = new Transaction(
          { recipient: `recipient${i}`, amount: 100 },
          wallet
        )
        transactionPool.addTransaction(tx)
      }

      expect(transactionPool.poolFull()).toBe(true)
    })
    it('should check committee pool when isCommittee=true', () => {
      // Add to committee pool only
      for (let i = 0; i < 3; i++) {
        const tx = new Transaction(
          { recipient: `recipient${i}`, amount: 100 },
          wallet
        )
        transactionPool.addTransaction(tx, true)
      }

      expect(transactionPool.poolFull(true)).toBe(false)
      expect(transactionPool.poolFull(false)).toBe(false)
    })
  })

  describe('verifyTransaction', () => {
    it('should verify valid transaction', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )

      expect(transactionPool.verifyTransaction(transaction)).toBe(true)
    })

    it('should reject invalid transaction', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      // Create a properly sized but invalid signature
      transaction.signature = 'a'.repeat(128)

      expect(transactionPool.verifyTransaction(transaction)).toBe(false)
    })
  })

  describe('transactionExists', () => {
    it('should return false for non-existing transaction', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )

      expect(transactionPool.transactionExists(transaction)).toBe(false)
    })

    it('should return true for existing transaction in unassigned', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(transaction)

      expect(transactionPool.transactionExists(transaction)).toBe(true)
    })

    it('should return true for transaction in assigned block', () => {
      const transaction = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(transaction)

      const block = { hash: 'hash1', data: [transaction] }
      transactionPool.assignTransactions(block)

      expect(transactionPool.transactionExists(transaction)).toBe(true)
    })
  })

  describe('hashExists', () => {
    it('should return false for non-existing hash', () => {
      expect(transactionPool.hashExists('non-existing')).toBeFalsy()
    })

    it('should return true for existing hash with transactions', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)

      const block = { hash: 'hash1', data: [tx] }
      transactionPool.assignTransactions(block)

      expect(transactionPool.hashExists('hash1')).toBe(true)
    })

    it('should return false for hash with empty transactions', () => {
      transactionPool.transactions['empty-hash'] = []

      expect(transactionPool.hashExists('empty-hash')).toBeFalsy()
    })
  })

  describe('removeDuplicates', () => {
    it('should remove duplicate transactions from other blocks', () => {
      const tx1 = new Transaction(
        { recipient: 'recipient1', amount: 100 },
        wallet
      )
      const tx2 = new Transaction(
        { recipient: 'recipient2', amount: 200 },
        wallet
      )

      transactionPool.addTransaction(tx1)
      transactionPool.addTransaction(tx2)

      const block1 = { hash: 'hash1', data: [tx1] }
      const block2 = { hash: 'hash2', data: [tx2] }

      transactionPool.assignTransactions(block1)
      transactionPool.assignTransactions(block2)

      transactionPool.removeDuplicates('hash1', [tx1])

      expect(transactionPool.transactions['hash1']).toBeDefined()
      expect(transactionPool.transactions['hash2']).toBeDefined()
    })

    it('should remove duplicates from unassigned pool', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)
      transactionPool.addTransaction(tx) // duplicate

      transactionPool.removeDuplicates('hash1', [tx])

      expect(transactionPool.transactions.unassigned.length).toBe(0)
    })
  })

  describe('clear', () => {
    it('should clear transactions for specific hash', () => {
      const tx = new Transaction(
        { recipient: 'recipient', amount: 100 },
        wallet
      )
      transactionPool.addTransaction(tx)

      const block = { hash: 'hash1', data: [tx] }
      transactionPool.assignTransactions(block)

      transactionPool.clear('hash1', [tx])

      expect(transactionPool.transactions['hash1']).toBeUndefined()
      expect(transactionPool.transactions.unassigned.length).toBe(0)
    })

    it('should remove transactions from unassigned pool', () => {
      const tx1 = new Transaction(
        { recipient: 'recipient1', amount: 100 },
        wallet
      )
      const tx2 = new Transaction(
        { recipient: 'recipient2', amount: 200 },
        wallet
      )

      transactionPool.addTransaction(tx1)
      transactionPool.addTransaction(tx2)

      transactionPool.clear('hash1', [tx1])

      expect(transactionPool.transactions.unassigned.length).toBe(1)
      expect(transactionPool.transactions.unassigned[0]).toBe(tx2)
    })
  })
})
