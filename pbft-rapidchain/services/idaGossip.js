const nodeCrypto = require('crypto')
const config = require('../config')
const axios = require('axios')
const { v1: uuidv1 } = require('uuid')
const isEmpty = require('lodash/isEmpty')
const reedSolomon = require('./reedSolomon')

const { NUMBER_OF_NODES, DEFAULT_TTL, NUMBER_OF_NODES_PER_SHARD } = config.get()

class IDAGossip {
  constructor() {
    this.fileChunks = new Map() // Store received chunks
    this._chunkTimestamps = new Map() // key → timestamp for TTL eviction
    this.socketGossipNodes // Connected nodes (all network peers)
    this.socketGossipPeers // Connected peers
    this.socketGossipCore // Connected Core
    // Evict stale chunks every 20s (cutoff=25s) to prevent IDA chunk accumulation OOM
    setInterval(() => {
      const cutoff = Date.now() - 25000
      for (const [key, ts] of this._chunkTimestamps) {
        if (ts < cutoff) {
          this.fileChunks.delete(key)
          this._chunkTimestamps.delete(key)
        }
      }
      // Hard cap: if still over 3000 entries, evict oldest half
      if (this.fileChunks.size > 3000) {
        const sorted = [...this._chunkTimestamps.entries()].sort((a, b) => a[1] - b[1])
        const toEvict = sorted.slice(0, Math.floor(sorted.length / 2))
        for (const [key] of toEvict) {
          this.fileChunks.delete(key)
          this._chunkTimestamps.delete(key)
        }
      }
    }, 20000).unref()
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
      // GF(2^8) has 255 non-zero elements; the Vandermonde RS matrix requires
      // k distinct non-zero field bases, so k must stay below 256.  A 4000-tx
      // block (~2 MB JSON) would otherwise yield k=400 and cause a singular-
      // matrix crash during Gaussian elimination.  Cap at 200 for safety margin.
      requiredChunks = Math.min(200, Math.max(2, Math.ceil(fileSizeKB / 5)))

      // Total chunks = required chunks + redundancy (50% more)
      totalChunks = Math.ceil(requiredChunks * 1.5)
    }

    const fileHash = nodeCrypto.createHash('sha256').update(fileBuffer).digest('hex')
    const dataShards = requiredChunks
    const parityShards = totalChunks - requiredChunks
    const shardSize = Math.ceil(fileBuffer.length / dataShards)
    const originalLength = fileBuffer.length

    // Pad the payload up to `shardSize * dataShards` with zeros so every data
    // shard is the same length (RS requires uniform shard size).
    const paddedData = new Uint8Array(shardSize * dataShards)
    paddedData.set(fileBuffer, 0)
    const dataShardArray = []
    for (let index = 0; index < dataShards; index++) {
      dataShardArray.push(paddedData.subarray(index * shardSize, (index + 1) * shardSize))
    }

    let parityShardArray = []
    if (parityShards > 0) {
      parityShardArray = reedSolomon.encodeParity(dataShardArray, parityShards)
    }

    const chunks = []
    for (let index = 0; index < dataShards; index++) {
      chunks.push({
        id: uuidv1(),
        index,
        data: Buffer.from(dataShardArray[index]).toString('base64'),
        dataShards,
        parityShards,
        shardSize,
        originalLength,
        totalChunks: dataShards, // legacy: minimum distinct shards needed
        fileHash
      })
    }
    for (let index = 0; index < parityShards; index++) {
      chunks.push({
        id: uuidv1(),
        index: dataShards + index,
        data: Buffer.from(parityShardArray[index]).toString('base64'),
        dataShards,
        parityShards,
        shardSize,
        originalLength,
        totalChunks: dataShards,
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
        this._chunkTimestamps.set(chunkKey, Date.now())

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

  cleanupChunks(fileHash) {
    const keysToDelete = []
    for (const [key, chunk] of this.fileChunks) {
      if (chunk.fileHash === fileHash) {
        keysToDelete.push(key)
      }
    }
    keysToDelete.forEach((key) => { this.fileChunks.delete(key); this._chunkTimestamps.delete(key) })
  }

  // Try to reconstruct data from chunks. Any `dataShards` distinct-index shards
  // (data or parity) are sufficient thanks to Reed-Solomon.
  tryReconstructData(fileHash /*, legacyTotalChunks */) {
    const allChunks = Array.from(this.fileChunks.values()).filter(
      (chunk) => chunk.fileHash === fileHash
    )
    if (allChunks.length === 0) return undefined

    // Small-payload bypass path: a single unfragmented chunk.
    if (allChunks[0].totalChunks === 1 && allChunks[0].parityShards === undefined) {
      const buffer = Buffer.from(allChunks[0].data, 'base64')
      const reconstructedHash = nodeCrypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex')
      if (reconstructedHash !== fileHash) return undefined
      const data = JSON.parse(buffer.toString('utf8'))
      this.cleanupChunks(fileHash)
      return data
    }

    const { dataShards, parityShards, shardSize, originalLength } = allChunks[0]
    const totalShards = dataShards + parityShards

    // Deduplicate by index; gossip may deliver the same shard more than once.
    const byIndex = new Map()
    for (const chunk of allChunks) {
      if (chunk.index < totalShards && !byIndex.has(chunk.index)) {
        byIndex.set(chunk.index, chunk)
      }
    }
    if (byIndex.size < dataShards) return undefined

    const shards = new Array(totalShards).fill(null)
    for (const [index, chunk] of byIndex) {
      const buf = Buffer.from(chunk.data, 'base64')
      if (buf.length !== shardSize) continue // ignore malformed
      shards[index] = new Uint8Array(buf)
    }

    if (parityShards > 0) {
      try {
        reedSolomon.reconstruct(shards, dataShards, parityShards)
      } catch {
        // Corrupted/mismatched shards: hand back nothing and let more chunks arrive.
        return undefined
      }
    } else {
      for (let index = 0; index < dataShards; index++) {
        if (shards[index] === null) return undefined
      }
    }

    // Concatenate data shards, then trim the zero padding back to originalLength.
    const reconstructedBuffer = Buffer.alloc(shardSize * dataShards)
    for (let index = 0; index < dataShards; index++) {
      reconstructedBuffer.set(shards[index], index * shardSize)
    }
    const trimmed = reconstructedBuffer.subarray(0, originalLength)
    const reconstructedHash = nodeCrypto
      .createHash('sha256')
      .update(trimmed)
      .digest('hex')
    if (reconstructedHash !== fileHash) return undefined

    const data = JSON.parse(trimmed.toString('utf8'))
    this.cleanupChunks(fileHash)
    return data
  }
}

module.exports = IDAGossip
