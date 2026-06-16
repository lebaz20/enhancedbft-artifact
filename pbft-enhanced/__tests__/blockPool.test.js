const BlockPool = require('../services/pools/block')

describe('BlockPool', () => {
  let blockPool

  beforeEach(() => {
    blockPool = new BlockPool()
  })

  describe('constructor', () => {
    it('should initialize with empty blocks array', () => {
      expect(blockPool.blocks).toBeDefined()
      expect(Array.isArray(blockPool.blocks)).toBe(true)
      expect(blockPool.blocks.length).toBe(0)
    })
  })

  describe('addBlock', () => {
    it('should add a block to the pool', () => {
      const block = { hash: 'hash1', data: [] }

      blockPool.addBlock(block)

      expect(blockPool.blocks.length).toBe(1)
      expect(blockPool.blocks[0]).toBe(block)
    })

    it('should add multiple blocks', () => {
      const block1 = { hash: 'hash1', data: [] }
      const block2 = { hash: 'hash2', data: [] }

      blockPool.addBlock(block1)
      blockPool.addBlock(block2)

      expect(blockPool.blocks.length).toBe(2)
      expect(blockPool.blocks[0]).toBe(block1)
      expect(blockPool.blocks[1]).toBe(block2)
    })
  })

  describe('existingBlock', () => {
    it('should return true for existing block', () => {
      const block = { hash: 'hash1', data: [] }
      blockPool.addBlock(block)

      expect(blockPool.existingBlock(block)).toBe(true)
    })

    it('should return false for non-existing block', () => {
      const block = { hash: 'hash1', data: [] }

      expect(blockPool.existingBlock(block)).toBe(false)
    })

    it('should identify block by hash', () => {
      const block1 = { hash: 'hash1', data: [] }
      const block2 = { hash: 'hash1', data: ['different'] }
      blockPool.addBlock(block1)

      expect(blockPool.existingBlock(block2)).toBe(true)
    })
  })

  describe('existingBlockByHash', () => {
    it('should return true for existing block hash', () => {
      const block = { hash: 'hash1', data: [] }
      blockPool.addBlock(block)

      expect(blockPool.existingBlockByHash('hash1')).toBe(true)
    })

    it('should return false for non-existing block hash', () => {
      expect(blockPool.existingBlockByHash('hash1')).toBe(false)
    })

    it('should find block among multiple blocks', () => {
      blockPool.addBlock({ hash: 'hash1', data: [] })
      blockPool.addBlock({ hash: 'hash2', data: [] })
      blockPool.addBlock({ hash: 'hash3', data: [] })

      expect(blockPool.existingBlockByHash('hash2')).toBe(true)
      expect(blockPool.existingBlockByHash('hash4')).toBe(false)
    })
  })

  describe('getBlock', () => {
    it('should return block by hash', () => {
      const block = { hash: 'hash1', data: ['test'] }
      blockPool.addBlock(block)

      const retrieved = blockPool.getBlock('hash1')

      expect(retrieved).toBe(block)
      expect(retrieved.data).toEqual(['test'])
    })

    it('should return undefined for non-existing hash', () => {
      const retrieved = blockPool.getBlock('non-existing')

      expect(retrieved).toBeUndefined()
    })

    it('should return correct block among multiple', () => {
      const block1 = { hash: 'hash1', data: ['data1'] }
      const block2 = { hash: 'hash2', data: ['data2'] }
      const block3 = { hash: 'hash3', data: ['data3'] }

      blockPool.addBlock(block1)
      blockPool.addBlock(block2)
      blockPool.addBlock(block3)

      expect(blockPool.getBlock('hash2')).toBe(block2)
      expect(blockPool.getBlock('hash2').data).toEqual(['data2'])
    })
  })
})
