const logger = require('../../utils/logger')
const EventEmitter = require('events')

class BlockPool extends EventEmitter {
  constructor() {
    super()
    this.blocks = []
    this._blockMap = new Map() // O(1) hash → block index
  }

  // check if the block exists or not
  existingBlock(block) {
    return this._blockMap.has(block.hash)
  }
  existingBlockByHash(hash) {
    return this._blockMap.has(hash)
  }

  // pushes block to the chain
  addBlock(block) {
    this.blocks.push(block)
    this._blockMap.set(block.hash, block)
    logger.log('added block to pool')
    this.emit('block', block.hash)
  }

  // returns the block for the given hash
  getBlock(hash) {
    return this._blockMap.get(hash)
  }
}

module.exports = BlockPool
