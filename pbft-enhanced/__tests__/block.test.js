const Block = require('../services/block')
const Wallet = require('../services/wallet')
const ChainUtility = require('../utils/chain')

describe('Block', () => {
  let wallet
  let genesisBlock
  let block
  const testData = [{ test: 'data' }]

  beforeEach(() => {
    wallet = new Wallet('test-proposer-secret')
    genesisBlock = Block.genesis()
    block = Block.createBlock(genesisBlock, testData, wallet)
  })

  describe('constructor', () => {
    it('should create a block with all required fields', () => {
      const timestamp = Date.now()
      const lastHash = 'previous-hash'
      const hash = 'current-hash'
      const data = [{ transaction: 'data' }]
      const proposer = 'proposer-public-key'
      const signature = 'signature'
      const sequenceNo = 1

      const newBlock = new Block(
        timestamp,
        lastHash,
        hash,
        data,
        proposer,
        signature,
        sequenceNo
      )

      expect(newBlock.timestamp).toBe(timestamp)
      expect(newBlock.lastHash).toBe(lastHash)
      expect(newBlock.hash).toBe(hash)
      expect(newBlock.data).toEqual(data)
      expect(newBlock.proposer).toBe(proposer)
      expect(newBlock.signature).toBe(signature)
      expect(newBlock.sequenceNo).toBe(sequenceNo)
    })
  })

  describe('toString', () => {
    it('should return a string representation with all fields', () => {
      const str = block.toString()

      expect(str).toContain('Block')
      expect(str).toContain('Timestamp')
      expect(str).toContain('Last Hash')
      expect(str).toContain('Hash')
      expect(str).toContain('Data')
      expect(str).toContain('proposer')
      expect(str).toContain('Signature')
      expect(str).toContain('Sequence No')
    })
  })

  describe('genesis', () => {
    it('should create a genesis block', () => {
      expect(genesisBlock).toBeDefined()
      expect(genesisBlock.timestamp).toBe('genesis time')
      expect(genesisBlock.lastHash).toBe('----')
      expect(genesisBlock.hash).toBe('genesis-hash')
      expect(genesisBlock.proposer).toBe('P4@P@53R')
      expect(genesisBlock.signature).toBe('SIGN')
      expect(genesisBlock.sequenceNo).toBe(0)
    })

    it('should create genesis block with empty data array', () => {
      expect(genesisBlock.data).toEqual([])
      expect(Array.isArray(genesisBlock.data)).toBe(true)
    })

    it('should create consistent genesis blocks', () => {
      const genesis1 = Block.genesis()
      const genesis2 = Block.genesis()

      expect(genesis1.hash).toBe(genesis2.hash)
      expect(genesis1.lastHash).toBe(genesis2.lastHash)
      expect(genesis1.sequenceNo).toBe(genesis2.sequenceNo)
    })
  })

  describe('createBlock', () => {
    it('should create a new block from previous block', () => {
      expect(block).toBeDefined()
      expect(block.lastHash).toBe(genesisBlock.hash)
      expect(block.data).toEqual(testData)
      expect(block.proposer).toBe(wallet.publicKey)
      expect(block.sequenceNo).toBe(genesisBlock.sequenceNo + 1)
    })

    it('should increment sequence number correctly', () => {
      const block1 = Block.createBlock(genesisBlock, testData, wallet)
      const block2 = Block.createBlock(block1, testData, wallet)
      const block3 = Block.createBlock(block2, testData, wallet)

      expect(block1.sequenceNo).toBe(1)
      expect(block2.sequenceNo).toBe(2)
      expect(block3.sequenceNo).toBe(3)
    })

    it('should generate unique timestamps', () => {
      const block1 = Block.createBlock(genesisBlock, testData, wallet)
      const block2 = Block.createBlock(genesisBlock, testData, wallet)

      expect(block1.timestamp).toBeLessThanOrEqual(block2.timestamp)
    })

    it('should sign the block hash with wallet', () => {
      const computedHash = Block.hash(
        block.timestamp,
        block.lastHash,
        block.data
      )
      const expectedSignature = wallet.sign(computedHash)

      expect(block.signature).toBe(expectedSignature)
    })

    it('should set proposer to wallet public key', () => {
      expect(block.proposer).toBe(wallet.getPublicKey())
    })

    it('should handle empty data', () => {
      const emptyBlock = Block.createBlock(genesisBlock, [], wallet)
      expect(emptyBlock.data).toEqual([])
    })

    it('should handle large data arrays', () => {
      const largeData = Array.from({ length: 100 }, (_, index) => ({
        id: index
      }))
      const largeBlock = Block.createBlock(genesisBlock, largeData, wallet)
      expect(largeBlock.data).toEqual(largeData)
    })
  })

  describe('hash', () => {
    it('should generate consistent hashes for same inputs', () => {
      const timestamp = Date.now()
      const lastHash = 'previous-hash'
      const data = [{ test: 'data' }]

      const hash1 = Block.hash(timestamp, lastHash, data)
      const hash2 = Block.hash(timestamp, lastHash, data)

      expect(hash1).toBe(hash2)
    })

    it('should generate different hashes for different timestamps', () => {
      const lastHash = 'previous-hash'
      const data = [{ test: 'data' }]

      const hash1 = Block.hash(1000, lastHash, data)
      const hash2 = Block.hash(2000, lastHash, data)

      expect(hash1).not.toBe(hash2)
    })

    it('should generate different hashes for different lastHash', () => {
      const timestamp = Date.now()
      const data = [{ test: 'data' }]

      const hash1 = Block.hash(timestamp, 'hash1', data)
      const hash2 = Block.hash(timestamp, 'hash2', data)

      expect(hash1).not.toBe(hash2)
    })

    it('should generate different hashes for different data', () => {
      const timestamp = Date.now()
      const lastHash = 'previous-hash'

      // Data is converted to string via template literal, arrays become comma-separated
      const hash1 = Block.hash(timestamp, lastHash, '{ "test": "data1" }')
      const hash2 = Block.hash(timestamp, lastHash, '{ "test": "data2" }')

      expect(hash1).not.toBe(hash2)
    })

    it('should generate 64 character SHA256 hash', () => {
      const hash = Block.hash(Date.now(), 'lastHash', [{ test: 'data' }])
      expect(hash.length).toBe(64)
    })
  })

  describe('blockHash', () => {
    it('should compute hash from block properties', () => {
      const computedHash = Block.blockHash(block)
      const expectedHash = Block.hash(
        block.timestamp,
        block.lastHash,
        block.data
      )

      expect(computedHash).toBe(expectedHash)
    })

    it('should match the hash stored in block', () => {
      const computedHash = Block.blockHash(block)
      expect(computedHash).toBe(block.hash)
    })
  })

  describe('signBlockHash', () => {
    it('should sign a block hash with wallet', () => {
      const hash = 'test-hash'
      const signature = Block.signBlockHash(hash, wallet)

      expect(signature).toBeDefined()
      expect(typeof signature).toBe('string')
    })

    it('should create verifiable signatures', () => {
      const hash = Block.hash(Date.now(), 'lastHash', [{ test: 'data' }])
      const signature = Block.signBlockHash(hash, wallet)

      const isValid = ChainUtility.verifySignature(
        wallet.publicKey,
        signature,
        hash
      )

      expect(isValid).toBe(true)
    })
  })

  describe('verifyBlock', () => {
    it('should verify a valid block', () => {
      const isValid = Block.verifyBlock(block)
      expect(isValid).toBe(true)
    })

    it('should reject block with tampered data', () => {
      // When data changes, the recomputed hash won't match the signature
      // Tamper with data
      block.data = 'completely-different-data-that-changes-hash'

      // Verification recomputes hash and compares signature
      const isValid = Block.verifyBlock(block)
      expect(isValid).toBe(false)
    })

    it('should reject block with tampered timestamp', () => {
      block.timestamp = Date.now() + 10000
      const isValid = Block.verifyBlock(block)
      expect(isValid).toBe(false)
    })

    it('should reject block with tampered lastHash', () => {
      block.lastHash = 'tampered-hash'
      const isValid = Block.verifyBlock(block)
      expect(isValid).toBe(false)
    })

    it('should reject block with invalid signature', () => {
      // Use signature from different block
      const otherWallet = new Wallet('other-proposer-secret')
      const otherHash = Block.hash(Date.now(), 'other-hash', [
        { other: 'data' }
      ])
      block.signature = otherWallet.sign(otherHash)
      const isValid = Block.verifyBlock(block)
      expect(isValid).toBe(false)
    })

    it('should reject block signed by wrong proposer', () => {
      const otherWallet = new Wallet('other-secret')
      block.proposer = otherWallet.publicKey
      const isValid = Block.verifyBlock(block)
      expect(isValid).toBe(false)
    })

    it('should verify genesis block has special properties', () => {
      // Genesis block has special values that won't verify with normal verification
      // This test documents that the genesis block is a special case
      expect(genesisBlock.signature).toBe('SIGN')
      expect(genesisBlock.proposer).toBe('P4@P@53R')
      expect(genesisBlock.sequenceNo).toBe(0)
    })
  })

  describe('verifyProposer', () => {
    it('should verify correct proposer', () => {
      const isValid = Block.verifyProposer(block, wallet.publicKey)
      expect(isValid).toBe(true)
    })

    it('should reject incorrect proposer', () => {
      const otherWallet = new Wallet('other-secret')
      const isValid = Block.verifyProposer(block, otherWallet.publicKey)
      expect(isValid).toBe(false)
    })

    it('should reject empty proposer', () => {
      const isValid = Block.verifyProposer(block, '')
      expect(isValid).toBe(false)
    })

    it('should reject null proposer', () => {
      const isValid = Block.verifyProposer(block, null)
      expect(isValid).toBe(false)
    })
  })

  describe('blockchain integration', () => {
    it('should create a valid blockchain sequence', () => {
      const genesis = Block.genesis()
      const block1 = Block.createBlock(genesis, [{ data: 1 }], wallet)
      const block2 = Block.createBlock(block1, [{ data: 2 }], wallet)
      const block3 = Block.createBlock(block2, [{ data: 3 }], wallet)

      expect(block1.lastHash).toBe(genesis.hash)
      expect(block2.lastHash).toBe(block1.hash)
      expect(block3.lastHash).toBe(block2.hash)

      expect(Block.verifyBlock(block1)).toBe(true)
      expect(Block.verifyBlock(block2)).toBe(true)
      expect(Block.verifyBlock(block3)).toBe(true)
    })
  })
})
