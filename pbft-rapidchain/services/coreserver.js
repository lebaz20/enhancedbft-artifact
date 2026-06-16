// import the ws module
const WebSocket = require('ws')
const MESSAGE_TYPE = require('../constants/message')
const { SHARD_STATUS } = require('../constants/status')
const config = require('../config')
const logger = require('../utils/logger')
const { COMMITTEE_SUBSET_INDEX } = config.get()
class Coreserver {
  constructor(port, blockchain, idaGossip) {
    this.port = port
    this.sockets = {}
    this.socketsMap = {}
    this.blockchain = blockchain
    this.rates = {}
    this.idaGossip = idaGossip
    this.config = config.get()
    // Map of subsetIndex -> { block, subsetIndex } for shard blocks forwarded to committee
    this.pendingShardBlocks = {}
  }

  // Creates a server on a given port
  listen() {
    const server = new WebSocket.Server({ port: this.port })
    logger.log(`Listening on port ${this.port}`)
    server.on('connection', (socket, request) => {
      const parsedUrl = new URL(request.url, `http://${request.headers.host}`)
      const isCommittee = parsedUrl.searchParams.get('isCommittee') === 'true'
      const subsetIndex = isCommittee
        ? COMMITTEE_SUBSET_INDEX
        : parsedUrl.searchParams.get('subsetIndex')
      const port = parsedUrl.searchParams.get('port')
      const httpPort = parsedUrl.searchParams.get('httpPort')
      // Use the pod's actual IP for redirect URLs — avoids Kubernetes DNS
      // resolution failures that cause ENOTFOUND both locally and on AWS.
      let remoteIp = request.socket.remoteAddress || ''
      if (remoteIp.startsWith('::ffff:')) remoteIp = remoteIp.slice(7)
      this.connectSocket(socket, port, subsetIndex, httpPort, remoteIp)
      this.messageHandler(socket, isCommittee)
      logger.log('core sockets', JSON.stringify(this.socketsMap))
    })
  }

  // connects to a given socket and registers the message handler on it
  // eslint-disable-next-line max-params
  connectSocket(socket, port, subsetIndex, httpPort, remoteIp) {
    if (!this.sockets[subsetIndex]) {
      this.sockets[subsetIndex] = {}
      this.socketsMap[subsetIndex] = []
    }
    this.sockets[subsetIndex][port] = {
      socket,
      url: `http://${remoteIp}:${httpPort}`
    }
    this.socketsMap[subsetIndex].push(port)
    this.idaGossip.setNodeSockets(this.sockets)
  }

  // send block to committee shard
  sendBlockToCommitteeShard(block, subsetIndex) {
    // Store pending shard block so we can broadcast it back once committee confirms it
    this.pendingShardBlocks[subsetIndex] = { block, subsetIndex }
    this.idaGossip.sendFromCoreToSpecificShard({
      message: {
        type: MESSAGE_TYPE.block_from_core,
        block,
        subsetIndex
      },
      chunkKey: 'block',
      targetsSubsetIndex: COMMITTEE_SUBSET_INDEX
    })
  }

  // broadcast block
  broadcastBlock(block, subsetIndex) {
    this.idaGossip.broadcastFromCore({
      message: {
        type: MESSAGE_TYPE.block_from_core,
        block,
        subsetIndex
      },
      chunkKey: 'block',
      sendersSubsetIndex: subsetIndex
    })
  }

  // update config
  updateConfig(config, subsetIndex) {
    this.idaGossip.sendFromCoreToSpecificShard({
      message: {
        type: MESSAGE_TYPE.config_from_core,
        config
      },
      targetsSubsetIndex: subsetIndex
    })
  }

  // Calculate shard status mapping from rates
  calculateShardStatusMap() {
    const shardStatusMap = {}
    Object.values(SHARD_STATUS).forEach((status) => {
      shardStatusMap[status] = Object.entries(this.rates)
        .filter(([, rate]) => rate.shardStatus === status)
        .map(([shardIndex]) => shardIndex)
    })
    return shardStatusMap
  }

  // Find best candidate shard for faulty shard redirection
  findRedirectCandidate(assignedIndices, shardStatusMap) {
    const candidateSets = [
      {
        shards: shardStatusMap[SHARD_STATUS.under_utilized] || [],
        status: SHARD_STATUS.under_utilized
      },
      {
        shards: shardStatusMap[SHARD_STATUS.normal] || [],
        status: SHARD_STATUS.normal
      },
      {
        shards: shardStatusMap[SHARD_STATUS.over_utilized] || [],
        status: SHARD_STATUS.over_utilized
      }
    ]

    for (const { shards, status } of candidateSets) {
      const available = shards.filter((index) => !assignedIndices.has(index))
      if (available.length > 0) {
        const randomIndex = Math.floor(Math.random() * available.length)
        return { selected: available[randomIndex], status }
      }
    }
    return null
  }

  // Build faulty shard redirect assignment mapping
  buildFaultyShardRedirectAssignment(faultyShards, shardStatusMap) {
    const assignedIndices = new Set()
    const faultyShardRedirectAssignment = {}

    faultyShards.forEach((faultyShardIndex) => {
      const result = this.findRedirectCandidate(assignedIndices, shardStatusMap)
      if (result) {
        assignedIndices.add(result.selected)
        faultyShardRedirectAssignment[faultyShardIndex] = {
          redirectSubset: result.selected,
          status: result.status
        }
      }
    })

    return faultyShardRedirectAssignment
  }

  // Apply redirect configuration to faulty shards
  applyRedirectConfiguration(faultyShardRedirectAssignment) {
    Object.entries(faultyShardRedirectAssignment).forEach(
      ([faultyShardIndex, { redirectSubset }]) => {
        let redirectUrls = []
        if (this.sockets[redirectSubset]) {
          redirectUrls = Object.values(this.sockets[redirectSubset]).map((object) => object.url)
          const config = [{ key: 'REDIRECT_TO_URL', value: redirectUrls }]
          this.updateConfig(config, faultyShardIndex)
        }
      }
    )
  }

  // Clear redirect configuration for healthy shards
  clearRedirectConfiguration(shards) {
    shards.forEach((shardIndex) => {
      const config = [{ key: 'REDIRECT_TO_URL', value: [] }]
      this.updateConfig(config, shardIndex)
    })
  }

  // Handle faulty shard redirection logic
  handleFaultyShardRedirection() {
    const shardStatusMap = this.calculateShardStatusMap()
    const faultyShards = shardStatusMap[SHARD_STATUS.faulty] || []
    const underUtilizedShards = shardStatusMap[SHARD_STATUS.under_utilized] || []
    const normalShards = shardStatusMap[SHARD_STATUS.normal] || []
    const overUtilizedShards = shardStatusMap[SHARD_STATUS.over_utilized] || []

    const faultyShardRedirectAssignment = this.buildFaultyShardRedirectAssignment(
      faultyShards,
      shardStatusMap
    )

    this.applyRedirectConfiguration(faultyShardRedirectAssignment)
    this.clearRedirectConfiguration([
      ...underUtilizedShards,
      ...normalShards,
      ...overUtilizedShards
    ])
  }

  // handles any message sent to the current node
  messageHandler(socket, isCommittee) {
    // registers message handler
    socket.on('message', async (message) => {
      if (Buffer.isBuffer(message)) {
        message = message.toString() // Convert Buffer to string
      }
      const receivedData = JSON.parse(message)
      const data = this.idaGossip.handleChunk(receivedData)
      if (data) {
        logger.log(this.port, 'RECEIVED', data.type)

        // select a particular message handler
        switch (data.type) {
          case MESSAGE_TYPE.block_to_core:
            // add updated block to chain
            if (!this.blockchain.existingBlock(data.block.hash, data.subsetIndex, isCommittee)) {
              this.blockchain.addBlock(data.block, data.subsetIndex, !isCommittee)

              if (!isCommittee) {
                this.sendBlockToCommitteeShard(data.block, data.subsetIndex)
              } else {
                const stats = {
                  total: this.blockchain.getTotal(),
                  rate: this.rates
                }
                logger.log(`CORE TOTAL:`, JSON.stringify(stats))
                // Each committee transaction wraps a shard block:
                // transaction.input.data = { data: originalBlock.data, subsetIndex: originalSubsetIndex }
                // Look up the original shard block from pendingShardBlocks and broadcast it
                data.block.data.forEach((transaction) => {
                  logger.log(`COMMITTEE BLOCK TRANSACTION:`, JSON.stringify(transaction))
                  const originalSubsetIndex = transaction?.input?.data?.subsetIndex
                  const pending = this.pendingShardBlocks[originalSubsetIndex]
                  if (pending) {
                    logger.log(`BROADCASTING SHARD BLOCK FOR SUBSET:`, originalSubsetIndex)
                    this.broadcastBlock(pending.block, pending.subsetIndex)
                    delete this.pendingShardBlocks[originalSubsetIndex]
                  } else {
                    logger.error(
                      `NO PENDING SHARD BLOCK FOR SUBSET:`,
                      originalSubsetIndex,
                      `(available: ${Object.keys(this.pendingShardBlocks)})`
                    )
                  }
                })
              }
            }
            break
          case MESSAGE_TYPE.rate_to_core:
            // collect shards rates
            if (
              !this.rates[data.rate.shardIndex] ||
              this.rates[data.rate.shardIndex].transactions <
                data.rate.transactions[data.rate.shardIndex] ||
              this.rates[data.rate.shardIndex].shardStatus !== data.rate.shardStatus
            ) {
              this.rates[data.rate.shardIndex] = {
                transactions: data.rate.transactions?.[data.rate.shardIndex],
                blocks: data.rate.blocks?.[data.rate.shardIndex],
                shardStatus: data.rate.shardStatus
              }
              const { SHOULD_REDIRECT_FROM_FAULTY_NODES } = this.config
              if (SHOULD_REDIRECT_FROM_FAULTY_NODES) {
                this.handleFaultyShardRedirection()
              }
            }
            logger.log(`CORE RATE:`, JSON.stringify(this.rates))
            logger.log(`CORE TOTAL:`, JSON.stringify(data.total))
            break
        }
      }
    })
  }
}

module.exports = Coreserver
