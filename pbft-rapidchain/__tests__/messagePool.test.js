const MessagePool = require('../services/pools/message')
const Wallet = require('../services/wallet')

describe('MessagePool', () => {
  let messagePool
  let wallet
  let block

  beforeEach(() => {
    messagePool = new MessagePool()
    wallet = new Wallet('test-secret')
    block = {
      hash: 'test-block-hash',
      data: [{ id: '1', amount: 100 }]
    }
  })

  describe('constructor', () => {
    it('should initialize with empty list', () => {
      expect(messagePool.list).toBeDefined()
      expect(typeof messagePool.list).toBe('object')
      expect(Object.keys(messagePool.list).length).toBe(0)
    })

    it('should initialize with default message', () => {
      expect(messagePool.message).toBe('INITIATE NEW ROUND')
    })
  })

  describe('createMessage', () => {
    it('should create a round change message', () => {
      const message = messagePool.createMessage(block, wallet)

      expect(message).toBeDefined()
      expect(message.publicKey).toBe(wallet.getPublicKey())
      expect(message.message).toBe('INITIATE NEW ROUND')
      expect(message.blockHash).toBe(block.hash)
      expect(message.data).toBe(block.data)
      expect(message.signature).toBeDefined()
    })

    it('should initialize list for block hash', () => {
      messagePool.createMessage(block, wallet)

      expect(messagePool.list[block.hash]).toBeDefined()
      expect(Array.isArray(messagePool.list[block.hash])).toBe(true)
      expect(messagePool.list[block.hash].length).toBe(1)
    })

    it('should create valid signature', () => {
      const message = messagePool.createMessage(block, wallet)

      expect(typeof message.signature).toBe('string')
      expect(message.signature.length).toBeGreaterThan(0)
    })

    it('should reset list when creating message for same block', () => {
      messagePool.createMessage(block, wallet)
      const wallet2 = new Wallet('different-secret')
      
      messagePool.createMessage(block, wallet2)

      expect(messagePool.list[block.hash].length).toBe(1)
    })

    it('should create different messages for different blocks', () => {
      const block2 = { hash: 'hash2', data: [] }
      
      const message1 = messagePool.createMessage(block, wallet)
      const message2 = messagePool.createMessage(block2, wallet)

      expect(message1.blockHash).not.toBe(message2.blockHash)
      expect(Object.keys(messagePool.list).length).toBe(2)
    })
  })

  describe('addMessage', () => {
    it('should add message to existing list', () => {
      const message1 = messagePool.createMessage(block, wallet)
      const wallet2 = new Wallet('different-secret')
      const message2 = {
        publicKey: wallet2.getPublicKey(),
        message: 'INITIATE NEW ROUND',
        blockHash: block.hash,
        data: block.data,
        signature: wallet2.sign('test')
      }

      messagePool.addMessage(message2)

      expect(messagePool.list[block.hash].length).toBe(2)
      expect(messagePool.list[block.hash][1]).toBe(message2)
    })

    it('should not add message if block hash not in list', () => {
      const message = {
        publicKey: wallet.getPublicKey(),
        message: 'INITIATE NEW ROUND',
        blockHash: 'non-existing-hash',
        data: [],
        signature: 'sig'
      }

      messagePool.addMessage(message)

      expect(messagePool.list['non-existing-hash']).toBeUndefined()
    })

    it('should add multiple messages for same block', () => {
      messagePool.createMessage(block, wallet)
      
      const wallet2 = new Wallet('secret2')
      const wallet3 = new Wallet('secret3')
      
      const message2 = {
        publicKey: wallet2.getPublicKey(),
        blockHash: block.hash,
        signature: 'sig2'
      }
      const message3 = {
        publicKey: wallet3.getPublicKey(),
        blockHash: block.hash,
        signature: 'sig3'
      }

      messagePool.addMessage(message2)
      messagePool.addMessage(message3)

      expect(messagePool.list[block.hash].length).toBe(3)
    })
  })

  describe('existingMessage', () => {
    it('should return false for non-existing message', () => {
      const message = {
        publicKey: wallet.getPublicKey(),
        blockHash: block.hash
      }

      expect(messagePool.existingMessage(message)).toBe(false)
    })

    it('should return true for existing message', () => {
      const message = messagePool.createMessage(block, wallet)

      expect(messagePool.existingMessage(message)).toBe(true)
    })

    it('should identify message by publicKey', () => {
      messagePool.createMessage(block, wallet)

      const sameMessage = {
        publicKey: wallet.getPublicKey(),
        blockHash: block.hash,
        signature: 'different-signature'
      }

      expect(messagePool.existingMessage(sameMessage)).toBe(true)
    })

    it('should return false for different publicKey', () => {
      messagePool.createMessage(block, wallet)
      
      const wallet2 = new Wallet('different-secret')
      const differentMessage = {
        publicKey: wallet2.getPublicKey(),
        blockHash: block.hash
      }

      expect(messagePool.existingMessage(differentMessage)).toBe(false)
    })

    it('should return false when block hash not in list', () => {
      const message = {
        publicKey: wallet.getPublicKey(),
        blockHash: 'non-existing'
      }

      expect(messagePool.existingMessage(message)).toBe(false)
    })
  })

  describe('isValidMessage', () => {
    it('should validate correct message', () => {
      const message = messagePool.createMessage(block, wallet)

      expect(messagePool.isValidMessage(message)).toBe(true)
    })

    it('should reject message with invalid signature', () => {
      const message = messagePool.createMessage(block, wallet)
      message.signature = 'a'.repeat(128) // Properly sized but invalid

      expect(messagePool.isValidMessage(message)).toBe(false)
    })

    it('should reject message with wrong publicKey', () => {
      const wallet2 = new Wallet('different-secret')
      const message = messagePool.createMessage(block, wallet)
      message.publicKey = wallet2.getPublicKey()

      expect(messagePool.isValidMessage(message)).toBe(false)
    })

    it('should reject message with mismatched blockHash', () => {
      const message = messagePool.createMessage(block, wallet)
      message.blockHash = 'different-hash'

      expect(messagePool.isValidMessage(message)).toBe(false)
    })

    it('should reject message with mismatched message text', () => {
      const message = messagePool.createMessage(block, wallet)
      message.message = 'DIFFERENT MESSAGE'

      expect(messagePool.isValidMessage(message)).toBe(false)
    })
  })
})
