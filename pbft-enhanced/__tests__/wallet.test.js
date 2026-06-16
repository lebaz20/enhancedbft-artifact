const Wallet = require('../services/wallet')
const ChainUtility = require('../utils/chain')

describe('Wallet', () => {
  let wallet
  const testSecret = 'test-secret-phrase'

  beforeEach(() => {
    wallet = new Wallet(testSecret)
  })

  describe('constructor', () => {
    it('should create a wallet with a key pair', () => {
      expect(wallet.keyPair).toBeDefined()
      expect(wallet.publicKey).toBeDefined()
    })

    it('should create consistent key pairs for the same secret', () => {
      const wallet1 = new Wallet(testSecret)
      const wallet2 = new Wallet(testSecret)

      expect(wallet1.publicKey).toBe(wallet2.publicKey)
    })

    it('should create different key pairs for different secrets', () => {
      const wallet1 = new Wallet('secret1-with-more-variation')
      const wallet2 = new Wallet('secret2-with-more-variation')

      expect(wallet1.publicKey).not.toBe(wallet2.publicKey)
    })
  })

  describe('toString', () => {
    it('should return a string representation with public key', () => {
      const str = wallet.toString()

      expect(str).toContain('Wallet')
      expect(str).toContain('publicKey')
      expect(str).toContain(wallet.publicKey)
    })
  })

  describe('sign', () => {
    it('should sign a data hash', () => {
      const dataHash = ChainUtility.hash({ test: 'data' })
      const signature = wallet.sign(dataHash)

      expect(signature).toBeDefined()
      expect(typeof signature).toBe('string')
      expect(signature.length).toBeGreaterThan(0)
    })

    it('should produce consistent signatures for the same data hash', () => {
      const dataHash = ChainUtility.hash({ test: 'data' })
      const signature1 = wallet.sign(dataHash)
      const signature2 = wallet.sign(dataHash)

      expect(signature1).toBe(signature2)
    })

    it('should produce different signatures for different data hashes', () => {
      const dataHash1 = ChainUtility.hash({ test: 'data1' })
      const dataHash2 = ChainUtility.hash({ test: 'data2' })

      const signature1 = wallet.sign(dataHash1)
      const signature2 = wallet.sign(dataHash2)

      expect(signature1).not.toBe(signature2)
    })

    it('should produce verifiable signatures', () => {
      const dataHash = ChainUtility.hash({ test: 'data' })
      const signature = wallet.sign(dataHash)

      const isValid = ChainUtility.verifySignature(
        wallet.publicKey,
        signature,
        dataHash
      )

      expect(isValid).toBe(true)
    })
  })

  describe('createTransaction', () => {
    it('should create a transaction with data', () => {
      const data = { type: 'transfer', amount: 100 }
      const transaction = wallet.createTransaction(data)

      expect(transaction).toBeDefined()
      expect(transaction.from).toBe(wallet.publicKey)
      expect(transaction.input.data).toEqual(data)
      expect(transaction.signature).toBeDefined()
      expect(transaction.hash).toBeDefined()
    })

    it('should create valid transactions that can be verified', () => {
      const data = { type: 'transfer', amount: 100 }
      const transaction = wallet.createTransaction(data)

      const Transaction = require('../services/transaction')
      const isValid = Transaction.verifyTransaction(transaction)

      expect(isValid).toBe(true)
    })

    it('should create unique transactions each time', () => {
      const data = { type: 'transfer', amount: 100 }
      const transaction1 = wallet.createTransaction(data)
      const transaction2 = wallet.createTransaction(data)

      expect(transaction1.id).not.toBe(transaction2.id)
      expect(transaction1.input.timestamp).not.toBe(
        transaction2.input.timestamp
      )
    })
  })

  describe('getPublicKey', () => {
    it('should return the public key', () => {
      const publicKey = wallet.getPublicKey()

      expect(publicKey).toBe(wallet.publicKey)
      expect(typeof publicKey).toBe('string')
    })
  })
})
