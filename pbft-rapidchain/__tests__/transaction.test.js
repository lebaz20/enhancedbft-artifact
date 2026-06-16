const Transaction = require('../services/transaction')
const Wallet = require('../services/wallet')
const ChainUtility = require('../utils/chain')

describe('Transaction', () => {
  let wallet
  let transaction
  const testData = { type: 'transfer', amount: 100, recipient: 'address123' }

  beforeEach(() => {
    wallet = new Wallet('test-secret')
    transaction = new Transaction(testData, wallet)
  })

  describe('constructor', () => {
    it('should create a transaction with required fields', () => {
      expect(transaction.id).toBeDefined()
      expect(transaction.from).toBeDefined()
      expect(transaction.input).toBeDefined()
      expect(transaction.hash).toBeDefined()
      expect(transaction.signature).toBeDefined()
      expect(transaction.createdAt).toBeDefined()
    })

    it('should set from field to wallet public key', () => {
      expect(transaction.from).toBe(wallet.publicKey)
    })

    it('should include data in input', () => {
      expect(transaction.input.data).toEqual(testData)
    })

    it('should include timestamp in input', () => {
      expect(transaction.input.timestamp).toBeDefined()
      expect(typeof transaction.input.timestamp).toBe('number')
      expect(transaction.input.timestamp).toBeLessThanOrEqual(Date.now())
    })

    it('should generate unique transaction IDs', () => {
      const transaction1 = new Transaction(testData, wallet)
      const transaction2 = new Transaction(testData, wallet)

      expect(transaction1.id).not.toBe(transaction2.id)
    })

    it('should create hash from input', () => {
      const expectedHash = ChainUtility.hash(transaction.input)
      expect(transaction.hash).toBe(expectedHash)
    })

    it('should sign the transaction hash', () => {
      const expectedSignature = wallet.sign(transaction.hash)
      expect(transaction.signature).toBe(expectedSignature)
    })

    it('should set createdAt timestamp', () => {
      const beforeCreation = Date.now()
      const newTransaction = new Transaction(testData, wallet)
      const afterCreation = Date.now()

      expect(newTransaction.createdAt).toBeGreaterThanOrEqual(beforeCreation)
      expect(newTransaction.createdAt).toBeLessThanOrEqual(afterCreation)
    })
  })

  describe('verifyTransaction', () => {
    it('should verify a valid transaction', () => {
      const isValid = Transaction.verifyTransaction(transaction)
      expect(isValid).toBe(true)
    })

    it('should reject transaction with tampered data', () => {
      transaction.input.data = { type: 'transfer', amount: 999999 }
      const isValid = Transaction.verifyTransaction(transaction)
      expect(isValid).toBe(false)
    })

    it('should reject transaction with tampered signature', () => {
      // Use signature from different data
      const otherWallet = new Wallet('other-wallet-secret')
      const otherHash = ChainUtility.hash({ other: 'data' })
      transaction.signature = otherWallet.sign(otherHash)

      const isValid = Transaction.verifyTransaction(transaction)
      expect(isValid).toBe(false)
    })

    it('should reject transaction with wrong from address', () => {
      const otherWallet = new Wallet('other-secret')
      transaction.from = otherWallet.publicKey
      const isValid = Transaction.verifyTransaction(transaction)
      expect(isValid).toBe(false)
    })

    it('should reject transaction with tampered hash', () => {
      transaction.hash = ChainUtility.hash({ fake: 'data' })
      // Signature was created with original input hash, won't match new hash
      // But verification uses hash of input, not transaction.hash field
      // So we need to change the input to make it invalid
      transaction.input = { fake: 'data', timestamp: Date.now() }
      const isValid = Transaction.verifyTransaction(transaction)
      expect(isValid).toBe(false)
    })

    it('should verify multiple valid transactions', () => {
      const transaction1 = new Transaction({ amount: 100 }, wallet)
      const transaction2 = new Transaction({ amount: 200 }, wallet)
      const transaction3 = new Transaction({ amount: 300 }, wallet)

      expect(Transaction.verifyTransaction(transaction1)).toBe(true)
      expect(Transaction.verifyTransaction(transaction2)).toBe(true)
      expect(Transaction.verifyTransaction(transaction3)).toBe(true)
    })
  })

  describe('transaction integrity', () => {
    it('should maintain data integrity through hash verification', () => {
      const originalHash = transaction.hash
      const recomputedHash = ChainUtility.hash(transaction.input)

      expect(originalHash).toBe(recomputedHash)
    })

    it('should maintain signature integrity', () => {
      const isSignatureValid = ChainUtility.verifySignature(
        transaction.from,
        transaction.signature,
        transaction.hash
      )

      expect(isSignatureValid).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('should handle empty data object', () => {
      const emptyTransaction = new Transaction({}, wallet)
      expect(Transaction.verifyTransaction(emptyTransaction)).toBe(true)
    })

    it('should handle complex nested data', () => {
      const complexData = {
        type: 'smart-contract',
        params: {
          nested: {
            deep: {
              value: 'test'
            }
          }
        },
        array: [1, 2, 3]
      }
      const complexTransaction = new Transaction(complexData, wallet)
      expect(Transaction.verifyTransaction(complexTransaction)).toBe(true)
    })

    it('should handle large data payloads', () => {
      const largeData = {
        payload: 'x'.repeat(1000),
        metadata: Array.from({ length: 100 }, (_, index) => ({ id: index }))
      }
      const largeTransaction = new Transaction(largeData, wallet)
      expect(Transaction.verifyTransaction(largeTransaction)).toBe(true)
    })
  })
})
