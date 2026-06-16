const PreparePool = require('../services/pools/prepare')
const Wallet = require('../services/wallet')

describe('PreparePool', () => {
  let preparePool
  let wallet
  let block

  beforeEach(() => {
    preparePool = new PreparePool()
    wallet = new Wallet('test-secret')
    block = { hash: 'test-block-hash', data: [] }
  })

  describe('constructor', () => {
    it('should initialize with empty list', () => {
      expect(preparePool.list).toBeDefined()
      expect(typeof preparePool.list).toBe('object')
      expect(Object.keys(preparePool.list).length).toBe(0)
    })
  })

  describe('createPrepare', () => {
    it('should create a prepare message', () => {
      const prepare = preparePool.createPrepare(block, wallet)

      expect(prepare).toBeDefined()
      expect(prepare.blockHash).toBe(block.hash)
      expect(prepare.publicKey).toBe(wallet.getPublicKey())
      expect(prepare.signature).toBeDefined()
      expect(typeof prepare.signature).toBe('string')
    })

    it('should create consistent signatures', () => {
      const prepare1 = preparePool.createPrepare(block, wallet)
      const prepare2 = preparePool.createPrepare(block, wallet)

      expect(prepare1.signature).toBe(prepare2.signature)
    })

    it('should create different signatures for different wallets', () => {
      const wallet2 = new Wallet('different-secret')
      const prepare1 = preparePool.createPrepare(block, wallet)
      const prepare2 = preparePool.createPrepare(block, wallet2)

      expect(prepare1.publicKey).not.toBe(prepare2.publicKey)
      expect(prepare1.signature).not.toBe(prepare2.signature)
    })
  })

  describe('addPrepare', () => {
    it('should add prepare to list', () => {
      const prepare = preparePool.createPrepare(block, wallet)

      preparePool.addPrepare(prepare)

      expect(preparePool.list[block.hash]).toBeDefined()
      expect(preparePool.list[block.hash].length).toBe(1)
      expect(preparePool.list[block.hash][0]).toBe(prepare)
    })

    it('should initialize list for new block hash', () => {
      const prepare = preparePool.createPrepare(block, wallet)

      preparePool.addPrepare(prepare)

      expect(Array.isArray(preparePool.list[block.hash])).toBe(true)
    })

    it('should add multiple prepares for same block', () => {
      const wallet2 = new Wallet('different-secret')
      const prepare1 = preparePool.createPrepare(block, wallet)
      const prepare2 = preparePool.createPrepare(block, wallet2)

      preparePool.addPrepare(prepare1)
      preparePool.addPrepare(prepare2)

      expect(preparePool.list[block.hash].length).toBe(2)
    })
  })

  describe('existingPrepare', () => {
    it('should return false for non-existing prepare', () => {
      const prepare = preparePool.createPrepare(block, wallet)

      expect(preparePool.existingPrepare(prepare)).toBe(false)
    })

    it('should return true for existing prepare', () => {
      const prepare = preparePool.createPrepare(block, wallet)
      preparePool.addPrepare(prepare)

      expect(preparePool.existingPrepare(prepare)).toBe(true)
    })

    it('should identify prepare by publicKey', () => {
      const prepare = preparePool.createPrepare(block, wallet)
      preparePool.addPrepare(prepare)

      const samePrepare = { 
        blockHash: block.hash, 
        publicKey: wallet.getPublicKey(),
        signature: 'different-signature'
      }

      expect(preparePool.existingPrepare(samePrepare)).toBe(true)
    })

    it('should return false for different publicKey', () => {
      const wallet2 = new Wallet('different-secret')
      const prepare1 = preparePool.createPrepare(block, wallet)
      const prepare2 = preparePool.createPrepare(block, wallet2)
      
      preparePool.addPrepare(prepare1)

      expect(preparePool.existingPrepare(prepare2)).toBe(false)
    })
  })

  describe('prepare', () => {
    it('should create and add prepare', () => {
      const prepare = preparePool.prepare(block, wallet)

      expect(prepare).toBeDefined()
      expect(prepare.blockHash).toBe(block.hash)
      expect(preparePool.list[block.hash].length).toBe(1)
    })

    it('should return the created prepare', () => {
      const prepare = preparePool.prepare(block, wallet)

      expect(preparePool.existingPrepare(prepare)).toBe(true)
    })
  })

  describe('isBlockPrepared', () => {
    it('should return false for unprepared block', () => {
      expect(preparePool.isBlockPrepared(block, wallet)).toBe(false)
    })

    it('should return true for prepared block', () => {
      preparePool.prepare(block, wallet)

      expect(preparePool.isBlockPrepared(block, wallet)).toBe(true)
    })

    it('should return false for null block', () => {
      expect(preparePool.isBlockPrepared(null, wallet)).toBe(false)
    })

    it('should return false for block without hash', () => {
      const invalidBlock = { data: [] }
      expect(preparePool.isBlockPrepared(invalidBlock, wallet)).toBe(false)
    })

    it('should be false for different wallet', () => {
      const wallet2 = new Wallet('different-secret')
      preparePool.prepare(block, wallet)

      expect(preparePool.isBlockPrepared(block, wallet2)).toBe(false)
    })
  })

  describe('getList', () => {
    it('should return prepare list for block hash', () => {
      const prepare = preparePool.createPrepare(block, wallet)
      preparePool.addPrepare(prepare)

      const list = preparePool.getList(block.hash)

      expect(list).toBeDefined()
      expect(Array.isArray(list)).toBe(true)
      expect(list.length).toBe(1)
      expect(list[0]).toBe(prepare)
    })

    it('should return undefined for non-existing hash', () => {
      const list = preparePool.getList('non-existing')

      expect(list).toBeUndefined()
    })

    it('should return all prepares for a block', () => {
      const wallet2 = new Wallet('secret2')
      const wallet3 = new Wallet('secret3')

      preparePool.prepare(block, wallet)
      preparePool.prepare(block, wallet2)
      preparePool.prepare(block, wallet3)

      const list = preparePool.getList(block.hash)

      expect(list.length).toBe(3)
    })
  })

  describe('isValidPrepare', () => {
    it('should validate correct prepare', () => {
      const prepare = preparePool.createPrepare(block, wallet)

      expect(preparePool.isValidPrepare(prepare)).toBe(true)
    })

    it('should reject prepare with invalid signature', () => {
      const prepare = preparePool.createPrepare(block, wallet)
      prepare.signature = 'a'.repeat(128) // Properly sized but invalid

      expect(preparePool.isValidPrepare(prepare)).toBe(false)
    })

    it('should reject prepare with wrong publicKey', () => {
      const wallet2 = new Wallet('different-secret')
      const prepare = preparePool.createPrepare(block, wallet)
      prepare.publicKey = wallet2.getPublicKey()

      expect(preparePool.isValidPrepare(prepare)).toBe(false)
    })

    it('should reject prepare with mismatched hash', () => {
      const prepare = preparePool.createPrepare(block, wallet)
      prepare.blockHash = 'different-hash'

      expect(preparePool.isValidPrepare(prepare)).toBe(false)
    })
  })
})
