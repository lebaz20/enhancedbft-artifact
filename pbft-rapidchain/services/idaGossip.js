const nodeCrypto = require('crypto')
const config = require('../config')
const axios = require('axios')
const { v1: uuidv1 } = require('uuid')
const isEmpty = require('lodash/isEmpty')

const { NUMBER_OF_NODES, DEFAULT_TTL, NUMBER_OF_NODES_PER_SHARD } = config.get()

class IDAGossip {
  constructor() {
    this.fileChunks = new Map() // Store received chunks
    this.socketGossipNodes // Connected nodes (all network peers)
    this.socketGossipPeers // Connected peers
    this.socketGossipCore // Connected Core
  }

  setNodeSockets(sockets) {
    this.socketGossipNodes = sockets
  }

  setPeerSockets(sockets) {
    this.socketGossipPeers = sockets
  }

  setCoreSocket(socket) {
    this.socketGossipCore = socket
  }

  getCoreSocket(socketKey = 'core') {
    return this.socketGossipCore[socketKey]
  }

  getOtherSubsets(subsetIndex) {
    const sockets = []
    Object.keys(this.socketGossipNodes)
      .filter((socketSubsetIndex) => socketSubsetIndex !== subsetIndex)
      .forEach((socketSubsetIndex) => {
        Object.keys(this.socketGossipNodes[socketSubsetIndex]).forEach((socketPort) => {
          const socket = this.socketGossipNodes[socketSubsetIndex][socketPort].socket
          sockets.push(socket)
        })
      })
    return sockets
  }

  getSubset(subsetIndex) {
    return Object.values(this.socketGossipNodes[subsetIndex]).map(({ socket }) => socket)
  }

  getSocketGossipPeers(sendersSubset, socketsKey = 'peers') {
    if (!this.socketGossipPeers) return []
    const sockets = this.socketGossipPeers[socketsKey]
    if (!sockets) return []
    return Object.keys(sockets)
      .filter((port) => !sendersSubset.includes(port))
      .map((port) => sockets[port]?.socket)
      .filter(Boolean)
  }

  getHTTPGossipPeers(sendersSubset) {
    return Array.from({ length: NUMBER_OF_NODES }, (_, index) => index)
      .filter((number_) => !sendersSubset.includes(number_))
      .map((number_) => `http://p2p-server-${number_}:${3001 + number_}/message`)
  }

  // Split data into IDA chunks
  splitData(data, customTotalChunks, customRequiredChunks) {
    const jsonString = JSON.stringify(data)
    const fileBuffer = Buffer.from(jsonString, 'utf8')

    const fileSizeKB = fileBuffer.length / 1024

    // For small payloads (< 2 KB) skip IDA fragmentation entirely — send as a
    // single chunk with no stagger.  Prepare, commit, view-change, and round-change
    // consensus messages are all ~300–500 bytes. Previously they were split into
    // 2 required + 1 redundant chunk, imposing a 100 ms reconstruction floor on
    // every one of them (receiver waits for chunk 0 AND chunk 1). Bypassing
    // fragmentation removes that floor.  Safe because consensus messages always
    // use shouldGossip=false (direct send to all peers) regardless of shard size.
    if (!customTotalChunks && !customRequiredChunks && fileSizeKB < 2) {
      const fileHash = nodeCrypto.createHash('sha256').update(fileBuffer).digest('hex')
      return [
        { id: uuidv1(), index: 0, data: fileBuffer.toString('base64'), totalChunks: 1, fileHash }
      ]
    }

    let totalChunks, requiredChunks

    if (customTotalChunks && customRequiredChunks) {
      totalChunks = customTotalChunks
      requiredChunks = customRequiredChunks
    } else {
      // Mathematical approach: linear scaling with file size
      // General Guidelines
      //     HTTP requests: 1-8KB for optimal performance
      //     WebSocket messages: 1-16KB per message
      //     UDP packets: < 1500 bytes (MTU limit)
      //     TCP segments: 1-64KB (but smaller is faster)
      // Performance Considerations
      //     < 1KB: Excellent performance, minimal latency
      //     1-8KB: Good performance for most networks
      //     8-64KB: Acceptable but may cause delays
      //     > 64KB: Risk of fragmentation and timeouts
      requiredChunks = Math.max(2, Math.ceil(fileSizeKB / 5))

      // Total chunks = required chunks + redundancy (50% more)
      totalChunks = Math.ceil(requiredChunks * 1.5)
    }

    const fileHash = nodeCrypto.createHash('sha256').update(fileBuffer).digest('hex')
    const chunkSize = Math.ceil(fileBuffer.length / requiredChunks)
    const chunks = []

    // Simple chunking (real IDA would use Reed-Solomon encoding)
    for (let index = 0; index < requiredChunks; index++) {
      const start = index * chunkSize
      const end = Math.min(start + chunkSize, fileBuffer.length)

      chunks.push({
        id: uuidv1(),
        index: index,
        data: fileBuffer.subarray(start, end).toString('base64'),
        totalChunks: requiredChunks,
        fileHash
      })
    }

    // Add redundant chunks for fault tolerance
    for (let index = requiredChunks; index < totalChunks; index++) {
      const randomIndex = Math.floor(Math.random() * requiredChunks)
      chunks.push({
        id: uuidv1(),
        index: randomIndex,
        data: chunks[randomIndex].data, // Simple redundancy
        totalChunks: requiredChunks,
        fileHash
      })
    }

    return chunks
  }

  sendSocketMessage(socket, data) {
    return new Promise((resolve) => {
      // Check if socket is open before sending
      if (!socket || socket.readyState !== 1) {
        // WebSocket.OPEN = 1 — peer disconnected, skip silently
        resolve()
        return
      }
      socket.send(data, (error) => {
        if (error) {
          // EPIPE / send errors are expected in gossip when peers disconnect mid-send
          console.warn('WebSocket send error (peer likely disconnected):', error.message)
        }
        resolve()
      })
    })
  }

  // Gossip chunk to random peers
  gossipChunk(message, ttl = DEFAULT_TTL) {
    if (ttl <= 0) return

    const { communicationType, sendersSubset, targetsSubset, shouldGossip, socketsKey } = message
    let peers
    if (communicationType === 'http') {
      peers = isEmpty(targetsSubset) ? this.getHTTPGossipPeers(sendersSubset) : targetsSubset
    } else {
      if (targetsSubset === 'core') {
        peers = [this.getCoreSocket(socketsKey)]
      } else {
        try {
          peers = isEmpty(targetsSubset)
            ? this.getSocketGossipPeers(sendersSubset, socketsKey)
            : targetsSubset
        } catch (error) {
          console.error('Error getting peers for gossip:', error.message)
          return Promise.resolve()
        }
      }
    }
    const randomPeers = shouldGossip ? peers.sort(() => 0.5 - Math.random()).slice(0, 4) : peers

    const requests = randomPeers.map((peer) => {
      const messageToSend = {
        ...message,
        ttl: ttl - 1
      }
      if (communicationType === 'http') {
        return axios({
          method: 'post',
          url: peer,
          data: messageToSend
        }).catch((error) => {
          console.warn('HTTP gossip send error (peer likely unavailable):', error.message)
        })
      } else {
        return this.sendSocketMessage(peer, JSON.stringify(messageToSend))
      }
    })
    return Promise.allSettled(requests)
  }

  calculateTTL(numberNodes) {
    return Math.ceil(1.85 * Math.log10(numberNodes) - 0.67)
  }

  sendToShardPeers({ message, chunkKey, senderPort, socketsKey, consensusMessage = false }) {
    // Consensus messages (pre-prepare, prepare, commit, round-change) MUST reach every
    // validator in the shard, so gossip is disabled for them. With TTL=1 and random
    // 4-of-N gossip, only 4 nodes would receive the message — below MIN_APPROVALS=6
    // for an 8-node shard and consensus would be impossible. Transaction messages can
    // still use gossip for efficiency.
    return this.sendData({
      message,
      chunkKey,
      communicationType: 'ws',
      sendersSubset: [senderPort],
      targetsSubset: [],
      shouldGossip: !consensusMessage && NUMBER_OF_NODES_PER_SHARD > 4,
      ttl: this.calculateTTL(NUMBER_OF_NODES_PER_SHARD),
      socketsKey: socketsKey ?? 'peers'
    })
  }

  sendToAnotherShard({ message, chunkKey, targetsSubset }) {
    return this.sendData({
      message,
      chunkKey,
      communicationType: 'http',
      sendersSubset: [],
      targetsSubset,
      shouldGossip: NUMBER_OF_NODES_PER_SHARD > 4,
      ttl: this.calculateTTL(NUMBER_OF_NODES_PER_SHARD)
    })
  }

  broadcastFromCore({ message, chunkKey, sendersSubsetIndex }) {
    const targetsSubset = this.getOtherSubsets(sendersSubsetIndex)
    if (targetsSubset.length > 0) {
      return this.sendData({
        message,
        chunkKey,
        communicationType: 'ws',
        sendersSubset: [],
        targetsSubset,
        shouldGossip: true,
        ttl: this.calculateTTL(NUMBER_OF_NODES)
      })
    }
  }

  sendFromCoreToSpecificShard({ message, chunkKey, targetsSubsetIndex }) {
    const targetsSubset = this.getSubset(targetsSubsetIndex)
    return this.sendData({
      message,
      chunkKey,
      communicationType: 'ws',
      sendersSubset: [],
      targetsSubset,
      shouldGossip: NUMBER_OF_NODES_PER_SHARD > 4,
      ttl: this.calculateTTL(NUMBER_OF_NODES)
    })
  }

  sendToCore({ message, chunkKey, socketsKey }) {
    return this.sendData({
      message,
      chunkKey,
      communicationType: 'ws',
      sendersSubset: [],
      targetsSubset: 'core',
      socketsKey: socketsKey ?? 'core',
      shouldGossip: false
    })
  }

  // Send large data using IDA gossip
  sendData({
    message,
    communicationType,
    sendersSubset,
    targetsSubset,
    chunkKey,
    shouldGossip,
    socketsKey,
    ttl = DEFAULT_TTL
  }) {
    const chunks = chunkKey ? this.splitData(message[chunkKey]) : [message]

    // Wait for all gossipChunk promises to resolve
    const promises = chunks.map((chunk, index) => {
      const processedMessage = {
        ...message,
        sendersSubset,
        communicationType,
        targetsSubset,
        shouldGossip,
        socketsKey,
        chunkKey
      }
      if (chunkKey) {
        processedMessage[chunkKey] = chunk
      }
      // Stagger chunk sending to avoid overwhelming the network.
      // 100 ms between chunks is intentional for RapidChain's 12-node gossip:
      // transaction messages use shouldGossip=true with 4 random peers per forward,
      // so a multi-chunk burst without pacing can cause message storms. Consensus
      // messages (shouldGossip=false) are already handled by the < 2 KB single-
      // chunk bypass above, so they incur 0 stagger regardless.
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(this.gossipChunk(processedMessage, ttl))
        }, index * 100)
      })
    })
    return Promise.all(promises)
  }

  // Handle incoming chunk
  handleChunk(message) {
    const { ttl, shouldGossip, chunkKey: originalChunkKey } = message

    if (originalChunkKey) {
      const chunk = message[originalChunkKey]
      // Store chunk if not already received
      const chunkKey = `${chunk.fileHash}-${chunk.index}`
      if (!this.fileChunks.has(chunkKey)) {
        this.fileChunks.set(chunkKey, chunk)

        if (shouldGossip) {
          // Continue gossiping to other peers
          this.gossipChunk(message, ttl)
        }

        // Check if we can reconstruct data
        const data = this.tryReconstructData(chunk.fileHash, chunk.totalChunks)
        return data ? { ...message, [originalChunkKey]: data } : undefined
      }
    } else {
      if (shouldGossip) {
        // Continue gossiping to other peers
        this.gossipChunk(message, ttl)
      }
      return message
    }
    return undefined
  }

  // Try to reconstruct data from chunks
  tryReconstructData(fileHash, totalChunks) {
    const chunks = Array.from(this.fileChunks.values())
      .filter((chunk) => chunk.fileHash === fileHash)
      .sort((a, b) => a.index - b.index)

    if (chunks.length >= totalChunks) {
      // Take only the required chunks for reconstruction
      const requiredChunks = chunks.slice(0, totalChunks)
      const reconstructedBuffer = Buffer.concat(
        requiredChunks.map((chunk) => Buffer.from(chunk.data, 'base64'))
      )

      // Verify file integrity
      const reconstructedHash = nodeCrypto
        .createHash('sha256')
        .update(reconstructedBuffer)
        .digest('hex')

      if (reconstructedHash === fileHash) {
        const jsonString = reconstructedBuffer.toString('utf8')
        const data = JSON.parse(jsonString)

        // Clean up: remove all chunks for this file after successful reconstruction
        const keysToDelete = []
        for (const [key, chunk] of this.fileChunks) {
          if (chunk.fileHash === fileHash) {
            keysToDelete.push(key)
          }
        }
        keysToDelete.forEach((key) => this.fileChunks.delete(key))

        return data
      }
    }

    return undefined
  }
}

module.exports = IDAGossip
