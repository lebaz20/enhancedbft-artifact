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

  getSocketGossipPeers(sendersSubset, socketsKey) {
    // Guard: peers may not be connected yet during startup — return empty rather than throwing.
    if (!this.socketGossipPeers) return []
    const sockets = socketsKey
      ? (this.socketGossipPeers[socketsKey] ?? this.socketGossipPeers)
      : this.socketGossipPeers
    if (!sockets) return []
    return Object.keys(sockets)
      .filter((port) => !sendersSubset.includes(port))
      .map((port) => sockets[port]?.socket)
      .filter(Boolean)
  }

  getSocketGossipCore(socketsKey) {
    return socketsKey
      ? (this.socketGossipCore[socketsKey] ?? this.socketGossipCore)
      : this.socketGossipCore
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
    // single chunk with no stagger.  This cuts prepare/commit/view-change/round-
    // change message latency from a 100 ms floor (2-chunk reconstruction wait)
    // to near-zero.  Safe for Enhanced's 4-node shards where shouldGossip=false
    // (direct send to ≤3 fixed peers) — no gossip fan-out means no congestion risk.
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
        peers = [this.getSocketGossipCore(socketsKey)]
      } else {
        try {
          peers = isEmpty(targetsSubset)
            ? this.getSocketGossipPeers(sendersSubset, socketsKey)
            : targetsSubset
        } catch (error) {
          // Log but never re-throw — gossip errors inside setImmediate callbacks
          // propagate as uncaughtException and crash the Node.js process.
          console.error('Error getting peers for gossip:', error.message)
          return Promise.resolve()
        }
      }
    }
    const randomPeers = shouldGossip ? peers.sort(() => 0.5 - Math.random()).slice(0, 10) : peers

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

  sendToShardPeers({ message, chunkKey, senderPort, consensusMessage = false }) {
    // Consensus messages (pre-prepare, prepare, commit, round-change) MUST reach every
    // validator in the shard — gossip would randomly drop some recipients and make
    // reaching MIN_APPROVALS impossible. Transactions can still use gossip for efficiency.
    return this.sendData({
      message,
      chunkKey,
      communicationType: 'ws',
      sendersSubset: [senderPort],
      targetsSubset: [],
      shouldGossip: !consensusMessage && NUMBER_OF_NODES_PER_SHARD > 4,
      ttl: this.calculateTTL(NUMBER_OF_NODES_PER_SHARD),
      socketsKey: 'peers'
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

  sendToCore({ message, chunkKey, socketsKey = 'core' }) {
    return this.sendData({
      message,
      chunkKey,
      communicationType: 'ws',
      sendersSubset: [],
      targetsSubset: 'core',
      socketsKey,
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
    socketsKey = 'peers',
    ttl = DEFAULT_TTL
  }) {
    const chunks = chunkKey ? this.splitData(message[chunkKey]) : [message]

    // Single-chunk fast path: bypass Promise+setTimeout entirely and call
    // gossipChunk in the CURRENT event-loop tick.  The <2KB bypass in
    // splitData guarantees single-chunk for all consensus messages (prepare,
    // commit, pre-prepare, view-change, round-change, transaction,
    // block_to_core, rate_to_core).  Every setTimeout(fn, 0) still schedules
    // a timer entry and defers execution until the NEXT timer phase — adding
    // ~1–4 ms latency per consensus hop.  With 6 shards × ~18 PBFT rounds ×
    // ~9 messages/round that accumulates into real round-trip delay.
    if (chunks.length === 1) {
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
        processedMessage[chunkKey] = chunks[0]
      }
      return this.gossipChunk(processedMessage, ttl)
    }

    // Multi-chunk path: stagger sends to avoid overwhelming the network.
    // 10 ms per chunk is sufficient for Enhanced's 4-node shards.
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
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(this.gossipChunk(processedMessage, ttl))
        }, index * 10)
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
    // Fast path for single-chunk messages — the common case with Enhanced's
    // <2KB bypass. Avoids: Array.from(fileChunks.values()) allocation, .filter()
    // scan, .sort(), Buffer.concat([single]), and a second full-map cleanup loop.
    // The chunk is always stored at key `${fileHash}-0` for index=0 single-chunk
    // messages because splitData returns [{index:0,...}] for them.
    if (totalChunks === 1) {
      const chunk = this.fileChunks.get(`${fileHash}-0`)
      if (!chunk) return undefined
      const reconstructedBuffer = Buffer.from(chunk.data, 'base64')
      const reconstructedHash = nodeCrypto
        .createHash('sha256')
        .update(reconstructedBuffer)
        .digest('hex')
      if (reconstructedHash !== fileHash) return undefined
      this.fileChunks.delete(`${fileHash}-0`)
      return JSON.parse(reconstructedBuffer.toString('utf8'))
    }

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
