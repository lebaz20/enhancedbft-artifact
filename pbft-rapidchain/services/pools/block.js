const logger = require('../../utils/logger')

class BlockPool {
  constructor() {
    this.blocks = []
    this.committeeBlocks = []
  }

  // check if the block exists or not
  existingBlock(block, isCommittee = false) {
    if (isCommittee) {
      return !!this.committeeBlocks?.find((b) => b.hash === block.hash)
    }
    return !!this.blocks?.find((b) => b.hash === block.hash)
  }
  existingBlockByHash(hash, isCommittee = false) {
    if (isCommittee) {
      return !!this.committeeBlocks?.find((b) => b.hash === hash)
    }
    return !!this.blocks?.find((b) => b.hash === hash)
  }

  // pushes block to the chain
  addBlock(block, isCommittee = false) {
    if (isCommittee) {
      this.committeeBlocks.push(block)
    } else {
      this.blocks.push(block)
    }
    logger.log('added block to pool')
  }

  // returns the block for the given hash
  getBlock(hash, isCommittee = false) {
    if (isCommittee) {
      return this.committeeBlocks.find((b) => b.hash === hash)
    }
    return this.blocks.find((b) => b.hash === hash)
  }
}

module.exports = BlockPool
