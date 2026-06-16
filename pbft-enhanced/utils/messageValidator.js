/**
 * Validates consensus protocol messages
 */
class MessageValidator {
  /**
   * Validates a transaction message
   * @param {Object} transaction - Transaction to validate
   * @param {Object} transactionPool - Transaction pool instance
   * @param {Object} validators - Validators instance
   * @returns {boolean} True if transaction is valid
   */
  static isValidTransaction(transaction, transactionPool, validators) {
    return (
      !transactionPool.transactionExists(transaction) &&
      transactionPool.verifyTransaction(transaction) &&
      validators.isValidValidator(transaction.from)
    )
  }

  /**
   * Validates a prepare message
   * @param {Object} prepare - Prepare message to validate
   * @param {Object} preparePool - Prepare pool instance
   * @param {Object} validators - Validators instance
   * @returns {boolean} True if prepare message is valid
   */
  static isValidPrepare(prepare, preparePool, validators) {
    return (
      !preparePool.existingPrepare(prepare) &&
      preparePool.isValidPrepare(prepare) &&
      validators.isValidValidator(prepare.publicKey)
    )
  }

  /**
   * Validates a commit message
   * @param {Object} commit - Commit message to validate
   * @param {Object} commitPool - Commit pool instance
   * @param {Object} validators - Validators instance
   * @returns {boolean} True if commit message is valid
   */
  static isValidCommit(commit, commitPool, validators) {
    return (
      !commitPool.existingCommit(commit) &&
      commitPool.isValidCommit(commit) &&
      validators.isValidValidator(commit.publicKey)
    )
  }

  /**
   * Validates a round change message
   * @param {Object} message - Round change message to validate
   * @param {Object} messagePool - Message pool instance
   * @param {Object} validators - Validators instance
   * @returns {boolean} True if message is valid
   */
  static isValidRoundChange(message, messagePool, validators) {
    return (
      !messagePool.existingMessage(message) &&
      messagePool.isValidMessage(message) &&
      validators.isValidValidator(message.publicKey)
    )
  }

  /**
   * Validates a pre-prepare message
   * @param {Object} block - Block to validate
   * @param {Object} blockPool - Block pool instance
   * @param {Object} blockchain - Blockchain instance
   * @param {number} blocksCount - Current block count
   * @param {Object} previousBlock - Previous block
   * @returns {boolean} True if block is valid
   */
  // eslint-disable-next-line max-params
  static isValidPrePrepare(
    block,
    blockPool,
    blockchain,
    blocksCount,
    previousBlock
  ) {
    return (
      !blockPool.existingBlock(block) &&
      blockchain.isValidBlock(block, blocksCount, previousBlock)
    )
  }
}

module.exports = MessageValidator
