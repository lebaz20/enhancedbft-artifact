const MessageValidator = require('../utils/messageValidator')

describe('MessageValidator', () => {
  let mockTransactionPool
  let mockPreparePool
  let mockCommitPool
  let mockMessagePool
  let mockBlockPool
  let mockBlockchain
  let mockValidators

  beforeEach(() => {
    mockTransactionPool = {
      transactionExists: jest.fn(),
      verifyTransaction: jest.fn()
    }

    mockPreparePool = {
      existingPrepare: jest.fn(),
      isValidPrepare: jest.fn()
    }

    mockCommitPool = {
      existingCommit: jest.fn(),
      isValidCommit: jest.fn()
    }

    mockMessagePool = {
      existingMessage: jest.fn(),
      isValidMessage: jest.fn()
    }

    mockBlockPool = {
      existingBlock: jest.fn()
    }

    mockBlockchain = {
      isValidBlock: jest.fn()
    }

    mockValidators = {
      isValidValidator: jest.fn()
    }
  })

  describe('isValidTransaction', () => {
    const transaction = { id: '1', from: 'validator1' }

    it('should return true for valid transaction', () => {
      mockTransactionPool.transactionExists.mockReturnValue(false)
      mockTransactionPool.verifyTransaction.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidTransaction(
        transaction,
        mockTransactionPool,
        mockValidators
      )

      expect(result).toBe(true)
    })

    it('should return false if transaction exists', () => {
      mockTransactionPool.transactionExists.mockReturnValue(true)
      mockTransactionPool.verifyTransaction.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidTransaction(
        transaction,
        mockTransactionPool,
        mockValidators
      )

      expect(result).toBe(false)
    })

    it('should return false if transaction verification fails', () => {
      mockTransactionPool.transactionExists.mockReturnValue(false)
      mockTransactionPool.verifyTransaction.mockReturnValue(false)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidTransaction(
        transaction,
        mockTransactionPool,
        mockValidators
      )

      expect(result).toBe(false)
    })

    it('should return false if validator is invalid', () => {
      mockTransactionPool.transactionExists.mockReturnValue(false)
      mockTransactionPool.verifyTransaction.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(false)

      const result = MessageValidator.isValidTransaction(
        transaction,
        mockTransactionPool,
        mockValidators
      )

      expect(result).toBe(false)
    })
  })

  describe('isValidPrepare', () => {
    const prepare = { blockHash: 'hash1', publicKey: 'validator1' }

    it('should return true for valid prepare', () => {
      mockPreparePool.existingPrepare.mockReturnValue(false)
      mockPreparePool.isValidPrepare.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidPrepare(
        prepare,
        mockPreparePool,
        mockValidators
      )

      expect(result).toBe(true)
    })

    it('should return false if prepare exists', () => {
      mockPreparePool.existingPrepare.mockReturnValue(true)
      mockPreparePool.isValidPrepare.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidPrepare(
        prepare,
        mockPreparePool,
        mockValidators
      )

      expect(result).toBe(false)
    })

    it('should return false if prepare is invalid', () => {
      mockPreparePool.existingPrepare.mockReturnValue(false)
      mockPreparePool.isValidPrepare.mockReturnValue(false)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidPrepare(
        prepare,
        mockPreparePool,
        mockValidators
      )

      expect(result).toBe(false)
    })

    it('should return false if validator is invalid', () => {
      mockPreparePool.existingPrepare.mockReturnValue(false)
      mockPreparePool.isValidPrepare.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(false)

      const result = MessageValidator.isValidPrepare(
        prepare,
        mockPreparePool,
        mockValidators
      )

      expect(result).toBe(false)
    })
  })

  describe('isValidCommit', () => {
    const commit = { blockHash: 'hash1', publicKey: 'validator1' }

    it('should return true for valid commit', () => {
      mockCommitPool.existingCommit.mockReturnValue(false)
      mockCommitPool.isValidCommit.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidCommit(
        commit,
        mockCommitPool,
        mockValidators
      )

      expect(result).toBe(true)
    })

    it('should return false if commit exists', () => {
      mockCommitPool.existingCommit.mockReturnValue(true)
      mockCommitPool.isValidCommit.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidCommit(
        commit,
        mockCommitPool,
        mockValidators
      )

      expect(result).toBe(false)
    })

    it('should return false if commit is invalid', () => {
      mockCommitPool.existingCommit.mockReturnValue(false)
      mockCommitPool.isValidCommit.mockReturnValue(false)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidCommit(
        commit,
        mockCommitPool,
        mockValidators
      )

      expect(result).toBe(false)
    })
  })

  describe('isValidRoundChange', () => {
    const message = { round: 1, publicKey: 'validator1' }

    it('should return true for valid round change', () => {
      mockMessagePool.existingMessage.mockReturnValue(false)
      mockMessagePool.isValidMessage.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidRoundChange(
        message,
        mockMessagePool,
        mockValidators
      )

      expect(result).toBe(true)
    })

    it('should return false if message exists', () => {
      mockMessagePool.existingMessage.mockReturnValue(true)
      mockMessagePool.isValidMessage.mockReturnValue(true)
      mockValidators.isValidValidator.mockReturnValue(true)

      const result = MessageValidator.isValidRoundChange(
        message,
        mockMessagePool,
        mockValidators
      )

      expect(result).toBe(false)
    })
  })

  describe('isValidPrePrepare', () => {
    const block = { hash: 'hash1' }
    const previousBlock = { hash: 'hash0' }
    const blocksCount = 1

    it('should return true for valid pre-prepare', () => {
      mockBlockPool.existingBlock.mockReturnValue(false)
      mockBlockchain.isValidBlock.mockReturnValue(true)

      const result = MessageValidator.isValidPrePrepare(
        block,
        mockBlockPool,
        mockBlockchain,
        blocksCount,
        previousBlock
      )

      expect(result).toBe(true)
    })

    it('should return false if block exists', () => {
      mockBlockPool.existingBlock.mockReturnValue(true)
      mockBlockchain.isValidBlock.mockReturnValue(true)

      const result = MessageValidator.isValidPrePrepare(
        block,
        mockBlockPool,
        mockBlockchain,
        blocksCount,
        previousBlock
      )

      expect(result).toBe(false)
    })

    it('should return false if block is invalid', () => {
      mockBlockPool.existingBlock.mockReturnValue(false)
      mockBlockchain.isValidBlock.mockReturnValue(false)

      const result = MessageValidator.isValidPrePrepare(
        block,
        mockBlockPool,
        mockBlockchain,
        blocksCount,
        previousBlock
      )

      expect(result).toBe(false)
    })
  })
})
