// import the ws module
const WebSocket = require('ws')
const MESSAGE_TYPE = require('../constants/message')
const { SHARD_STATUS } = require('../constants/status')
const config = require('../config')
const logger = require('../utils/logger')

class Coreserver {
  constructor(port, blockchain, idaGossip) {
    this.port = port
    this.sockets = {}
    this.socketsMap = {}
    this.blockchain = blockchain
    this.rates = {}
    this.idaGossip = idaGossip
    this.config = config.get()
    // Per-shard fault tracking: populated at WebSocket connection time so core
    // knows shard health immediately — no need to wait for rate_to_core broadcasts.
    // { SUBSET1: { total: 4, faulty: 2 }, SUBSET2: { total: 4, faulty: 0 }, ... }
    this.shardNodeCounts = {}
    // Idempotency cache: last JSON-serialised config sent to each shard.
    // clearRedirectConfiguration fires on every rate_to_core update, pushing
    // {REDIRECT_TO_URL:[]} to all healthy shards even when nothing changed.
    // Skipping no-op sends eliminates ~60 spurious WebSocket calls/sec from core.
    this._lastSentConfig = new Map() // shardIndex → JSON string of last config
    // Stable redirect assignments: broken shard → assigned healthy shard.
    // Persisted across rate_to_core updates so drain loops don't get their
    // target URL shuffled mid-flight every 2 seconds. Only evicted when the
    // target shard becomes faulty or leaves the healthy pool.
    this._redirectAssignments = new Map() // faultyShard → targetShard
    // After applyShardMerge(), maps old shard names to the merged shard name
    // so incoming rate_to_core / block_to_core from nodes still identifying
    // as their original shard are attributed to the merged shard.
    this._shardAliases = new Map() // oldShard → mergedShard
    // Auto-incrementing counter for generating unique merged shard names.
    this._mergeCounter = 0
    // Guards applyShardMerge() so it only fires once.
    this._mergeApplied = false
    // Timestamp of first node connection — used as fallback for merge readiness.
    this._firstConnectionAt = null
    // Set of "shard:port" keys that have connected — prevents _trackShardNode
    // from double-counting nodes that reconnect after a transient disconnection.
    this._connectedPorts = new Set()
    // Pending merge payloads keyed by port — when a node reconnects after merge
    // has already been applied, the merge_shard message is resent from here.
    this._pendingMergePayloads = new Map() // port → JSON string
  }

  // Creates a server on a given port
  listen() {
    const server = new WebSocket.Server({ port: this.port })
    logger.log(`Listening on port ${this.port}`)
    server.on('connection', (socket, request) => {
      const parsedUrl = new URL(request.url, `http://${request.headers.host}`)
      const subsetIndex = parsedUrl.searchParams.get('subsetIndex')
      const port = parsedUrl.searchParams.get('port')
      const httpPort = parsedUrl.searchParams.get('httpPort')
      const isFaulty = parsedUrl.searchParams.get('isFaulty') === 'true'
      // Use the pod's actual IP for redirect URLs — avoids Kubernetes DNS
      // resolution failures that cause ENOTFOUND both locally and on AWS.
      let remoteIp = request.socket.remoteAddress || ''
      // Strip IPv6-mapped-IPv4 prefix (e.g. ::ffff:10.244.0.5 → 10.244.0.5)
      if (remoteIp.startsWith('::ffff:')) remoteIp = remoteIp.slice(7)
      this.connectSocket(socket, port, subsetIndex, httpPort, remoteIp, isFaulty)
      this._trackShardNode(subsetIndex, isFaulty, port)
      this.messageHandler(socket, false)
      logger.log('core sockets', JSON.stringify(this.socketsMap))

      // If merge has already been applied and this node has a pending merge
      // payload (socket was closed when we first tried), resend it now.
      if (this._mergeApplied && this._pendingMergePayloads.has(port)) {
        const payload = this._pendingMergePayloads.get(port)
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload)
          this._pendingMergePayloads.delete(port)
          logger.log(`MERGE_SHARD resent on reconnect to port=${port}`)
        }
      }
    })
  }

  // connects to a given socket and registers the message handler on it
  // eslint-disable-next-line max-params
  connectSocket(socket, port, subsetIndex, httpPort, remoteIp, isFaulty = false) {
    if (!this.sockets[subsetIndex]) {
      this.sockets[subsetIndex] = {}
      this.socketsMap[subsetIndex] = []
    }
    this.sockets[subsetIndex][port] = {
      socket,
      url: `http://${remoteIp}:${httpPort}`,
      wsUrl: `ws://${remoteIp}:${port}`,
      isFaulty,
      remoteIp
    }
    this.socketsMap[subsetIndex].push(port)
    this.idaGossip.setNodeSockets(this.sockets)
  }

  // Track per-shard node counts as they connect.  Called once per p2p→core
  // WebSocket, so after all nodes connect core has an accurate fault map.
  // f+1 faulty nodes break a 4-node shard (PBFT tolerance = floor((n-1)/3)).
  _trackShardNode(subsetIndex, isFaulty, port) {
    if (!subsetIndex) return
    if (!this._firstConnectionAt) this._firstConnectionAt = Date.now()
    // Deduplicate: a node that reconnects after a transient disconnection
    // should not inflate the shard's total/faulty counts.
    const connKey = `${subsetIndex}:${port}`
    if (this._connectedPorts.has(connKey)) {
      logger.log(`SHARD NODE RECONNECTED (skipping count) shard=${subsetIndex} port=${port}`)
      return
    }
    this._connectedPorts.add(connKey)
    if (!this.shardNodeCounts[subsetIndex]) {
      this.shardNodeCounts[subsetIndex] = { total: 0, faulty: 0 }
    }
    this.shardNodeCounts[subsetIndex].total += 1
    if (isFaulty) this.shardNodeCounts[subsetIndex].faulty += 1
    logger.log(
      `SHARD NODE CONNECTED shard=${subsetIndex} isFaulty=${isFaulty}` +
        ` total=${this.shardNodeCounts[subsetIndex].total}` +
        ` faulty=${this.shardNodeCounts[subsetIndex].faulty}`
    )
  }

  // Returns per-shard health summary derived from connection-time fault data.
  // { SUBSET1: { total: 4, faulty: 2, healthy: 2, isBroken: true }, ... }
  getShardHealthMap() {
    const healthMap = {}
    for (const [shard, counts] of Object.entries(this.shardNodeCounts)) {
      const nodesPerShard = counts.total
      const faultyThreshold = Math.floor((nodesPerShard - 1) / 3) + 1
      healthMap[shard] = {
        ...counts,
        healthy: counts.total - counts.faulty,
        isBroken: counts.faulty >= faultyThreshold
      }
    }
    return healthMap
  }

  // Build a merge plan that combines broken shards so the merged group has
  // enough healthy nodes for PBFT consensus.
  //
  // For 4-node shards (f = floor((4-1)/3) = 1):
  //   MIN_APPROVALS = 2f+1 = 3 healthy nodes needed for consensus.
  //   - Shard with 3 healthy, 1 faulty  → fine, left alone (3 ≥ 3)
  //   - Shard with 2 healthy, 2 faulty  → broken (2 < 3)
  //   - Merge two broken shards (2+2=4 healthy) → 4 ≥ 3 → consensus OK
  //
  // The merged virtual shard consists of ONLY the healthy nodes from the
  // constituent broken shards.  Faulty nodes keep redirecting TXs — they
  // don't participate in the merged shard's PBFT.
  //
  // Algorithm: greedy bin-packing sorted by healthy count descending.
  // Each time the accumulated healthy count reaches MIN_APPROVALS, a merged
  // group is emitted and the accumulator resets.  Broken shards with 0
  // healthy nodes are skipped (nothing to contribute).
  //
  // Returns:
  //   healthyShards     – shard indices that already have consensus (unchanged)
  //   mergedGroups      – groups of broken shards whose healthy nodes form
  //                       a viable virtual shard
  //   unmergeableShards – broken shards whose healthy nodes couldn't fill
  //                       a group (too few left over)
  buildShardMergeMap() {
    const healthMap = this.getShardHealthMap()

    // Derive MIN_APPROVALS from the most common shard size.
    // All shards normally have the same node count, but use max() to be safe.
    const nodesPerShard = Math.max(...Object.values(healthMap).map((s) => s.total), 1)
    const minApprovals = 2 * Math.floor((nodesPerShard - 1) / 3) + 1

    const healthyShards = []
    const brokenShards = []

    for (const [shard, info] of Object.entries(healthMap)) {
      if (info.isBroken) {
        if (info.healthy > 0) {
          brokenShards.push({ shard, healthy: info.healthy })
        }
        // Shards with 0 healthy nodes are silently dropped — nothing to merge.
      } else {
        healthyShards.push(shard)
      }
    }

    // Sort by healthy count descending: larger contributors first for tighter packing.
    brokenShards.sort((a, b) => b.healthy - a.healthy)

    const mergedGroups = []
    let currentGroup = { shards: [], healthyCount: 0 }

    for (const { shard, healthy } of brokenShards) {
      currentGroup.shards.push(shard)
      currentGroup.healthyCount += healthy
      if (currentGroup.healthyCount >= minApprovals) {
        mergedGroups.push({ ...currentGroup })
        currentGroup = { shards: [], healthyCount: 0 }
      }
    }

    // Remaining broken shards that couldn't accumulate enough healthy nodes.
    const unmergeableShards = currentGroup.shards

    // Log the merge plan.
    if (mergedGroups.length > 0 || unmergeableShards.length > 0) {
      logger.log(
        `SHARD MERGE MAP: minApprovals=${minApprovals} nodesPerShard=${nodesPerShard}` +
          ` healthy=${healthyShards.length} merged=${mergedGroups.length}` +
          ` unmergeable=${unmergeableShards.length}`
      )
      for (const group of mergedGroups) {
        logger.log(
          `  MERGED GROUP: [${group.shards.join(', ')}] → ${group.healthyCount} healthy nodes`
        )
      }
      if (unmergeableShards.length > 0) {
        logger.log(`  UNMERGEABLE: [${unmergeableShards.join(', ')}]`)
      }
    }

    return { healthyShards, mergedGroups, unmergeableShards, minApprovals, nodesPerShard }
  }

  // Execute the merge plan produced by buildShardMergeMap().
  //
  // For each merged group:
  //   1. Generate a fresh shard name (MERGED_1, MERGED_2, …) so the merged
  //      shard doesn't collide with any source shard's stored blocks.
  //   2. Collect healthy (non-faulty) node sockets from all constituent shards.
  //   3. Move those sockets under the new name in this.sockets / socketsMap.
  //   4. Delete ALL old shard entries so IDA gossip sees one unified shard.
  //   5. Register aliases so incoming rate_to_core from nodes still identifying
  //      as their original shard are remapped to the merged shard.
  //   6. Send a MERGE_SHARD message to each healthy node with:
  //        - peerWsUrls: WS URLs of the OTHER healthy nodes (for P2P connection)
  //        - mergedNodesSubset: combined healthy node indices (for validators)
  //        - minApprovals: from original shard size (always 3 for 4-node shards)
  //        - mergedShardIndex: the new unique shard name
  //   7. Send faulty nodes in constituent shards a redirect to the merged shard.
  applyShardMerge() {
    // Wait until nodes have connected before computing the merge plan.
    // rate_to_core fires immediately on first peer handshake — often before
    // many shards have finished connecting.  Incomplete shardNodeCounts would
    // produce wrong merge decisions (e.g. treating partially-connected shards
    // as broken or missing healthy nodes that haven't connected yet).
    //
    // Two conditions release the gate (whichever comes first):
    //   1. All expected nodes connected (ideal case).
    //   2. 30 seconds elapsed since the first connection (fallback — handles
    //      crashed pods or nodes that will never connect).
    const totalConnected = Object.values(this.shardNodeCounts).reduce((sum, s) => sum + s.total, 0)
    const allConnected = totalConnected >= (this.config.NUMBER_OF_NODES || totalConnected)
    const elapsed = this._firstConnectionAt ? Date.now() - this._firstConnectionAt : 0
    const MERGE_READINESS_TIMEOUT_MS = 30000
    if (!allConnected && elapsed < MERGE_READINESS_TIMEOUT_MS) return

    if (!allConnected) {
      logger.log(
        `MERGE READINESS TIMEOUT: ${totalConnected}/${this.config.NUMBER_OF_NODES || '?'} ` +
          `nodes connected after ${Math.round(elapsed / 1000)}s — proceeding with available data`
      )
    }

    const { mergedGroups, minApprovals } = this.buildShardMergeMap()
    if (mergedGroups.length === 0) return

    // --- Pass 1: create merged shards, update sockets, redirect faulty nodes ---
    const mergedEntries = [] // { mergedShardIndex, healthyNodes, mergedSockets, mergedNodesSubset, allWsUrls }

    for (const group of mergedGroups) {
      this._mergeCounter += 1
      const mergedShardIndex = `MERGED_${this._mergeCounter}`

      // Collect healthy node info from all constituent shards.
      const healthyNodes = [] // { port, entry }
      const faultyNodes = [] // { port, entry, shard }

      for (const shard of group.shards) {
        if (!this.sockets[shard]) continue
        for (const [port, entry] of Object.entries(this.sockets[shard])) {
          if (entry.isFaulty) {
            faultyNodes.push({ port, entry, shard })
          } else {
            healthyNodes.push({ port, entry, originalShard: shard })
          }
        }
      }

      // Build the merged shard's socket map (healthy nodes only).
      const mergedSockets = {}
      const mergedPorts = []
      const mergedNodesSubset = []
      const allWsUrls = []

      for (const { port, entry } of healthyNodes) {
        mergedSockets[port] = entry
        mergedPorts.push(port)
        // Node index = P2P port - 5001 (matches prepare-config.js convention)
        mergedNodesSubset.push(parseInt(port, 10) - 5001)
        allWsUrls.push(entry.wsUrl)
      }
      mergedNodesSubset.sort((a, b) => a - b)

      // Remove ALL old shard entries and install the merged shard under its new name.
      for (const shard of group.shards) {
        delete this.sockets[shard]
        delete this.socketsMap[shard]
        delete this.rates[shard] // Clear stale rate data for old shard names
        this._shardAliases.set(shard, mergedShardIndex)
      }
      this.sockets[mergedShardIndex] = mergedSockets
      this.socketsMap[mergedShardIndex] = mergedPorts

      logger.log(
        `SHARD MERGE APPLIED: ${group.shards.join(' + ')} → ${mergedShardIndex}` +
          ` (${healthyNodes.length} healthy, ${faultyNodes.length} faulty)` +
          ` nodesSubset=[${mergedNodesSubset.join(',')}] minApprovals=${minApprovals}`
      )

      // Redirect faulty nodes to the merged shard's healthy nodes.
      // Old shard entries have been deleted from this.sockets, so we send
      // the redirect config directly via each faulty node's own socket.
      const redirectUrls = Object.values(mergedSockets).map((o) => o.url)
      const redirectPayload = JSON.stringify({
        type: MESSAGE_TYPE.config_from_core,
        config: [{ key: 'REDIRECT_TO_URL', value: redirectUrls }]
      })
      for (const { port, entry } of faultyNodes) {
        if (entry.socket && entry.socket.readyState === WebSocket.OPEN) {
          entry.socket.send(redirectPayload)
        }
        logger.log(
          `  REDIRECT faulty port=${port} → ${mergedShardIndex}` + ` (${redirectUrls.length} urls)`
        )
      }

      mergedEntries.push({
        mergedShardIndex,
        healthyNodes,
        mergedSockets,
        mergedNodesSubset,
        allWsUrls
      })
    }

    // Update gossip routing once after all merges are applied.
    this.idaGossip.setNodeSockets(this.sockets)

    // --- Compute verification ring across merged shards ---
    // Each merged shard verifies the next one in the ring, matching the
    // ring-based assignment used at deploy time in prepare-config.js.
    // A single merged shard cannot verify itself → empty array.
    const mergedNames = mergedEntries.map((e) => e.mergedShardIndex)

    // --- Pass 2: send MERGE_SHARD to healthy nodes with verification info ---
    for (let i = 0; i < mergedEntries.length; i++) {
      const { mergedShardIndex, healthyNodes, mergedNodesSubset, allWsUrls } = mergedEntries[i]

      const verificationSourceSubsets =
        mergedNames.length <= 1 ? [] : [mergedNames[(i + 1) % mergedNames.length]]

      for (const { port, entry } of healthyNodes) {
        const peerWsUrls = allWsUrls.filter((url) => url !== entry.wsUrl)
        const mergePayload = {
          type: MESSAGE_TYPE.merge_shard,
          mergedShardIndex,
          peerWsUrls,
          mergedNodesSubset,
          minApprovals,
          verificationSourceSubsets
        }
        const payloadStr = JSON.stringify(mergePayload)
        if (entry.socket && entry.socket.readyState === WebSocket.OPEN) {
          entry.socket.send(payloadStr)
          logger.log(
            `  MERGE_SHARD sent to port=${port} peers=${peerWsUrls.length}` +
              ` nodesSubset=[${mergedNodesSubset.join(',')}]` +
              ` verification=${JSON.stringify(verificationSourceSubsets)}`
          )
        } else {
          // Socket not open — queue for resend when the node reconnects.
          this._pendingMergePayloads.set(port, payloadStr)
          logger.warn(
            `  MERGE_SHARD DEFERRED port=${port}` +
              ` readyState=${entry.socket ? entry.socket.readyState : 'null'}` +
              ` — will resend on reconnect`
          )
        }
      }
    }

    this._mergeApplied = true
  }

  // Accept a newly committed shard block into the batch buffer.
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
    // Skip if the config value for this shard hasn't changed — prevents
    // clearRedirectConfiguration from spamming healthy shards with no-op
    // {REDIRECT_TO_URL:[]} messages on every incoming rate_to_core event.
    const configKey = JSON.stringify(config)
    if (this._lastSentConfig.get(subsetIndex) === configKey) return
    this._lastSentConfig.set(subsetIndex, configKey)
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

  // Return the ordered pool of healthy shards: under-utilised first, then normal.
  // OVER_UTILIZED excluded — routing to them causes continuous flooding.
  _healthyShardPool(shardStatusMap) {
    return [
      ...(shardStatusMap[SHARD_STATUS.under_utilized] || []),
      ...(shardStatusMap[SHARD_STATUS.normal] || [])
    ]
  }

  // Build faulty shard redirect assignment mapping.
  //
  // Strategy: deterministic balanced assignment.  Every time the healthy pool
  // changes, ALL dead-shard assignments are recomputed to spread them evenly.
  // This eliminates the startup-imbalance problem where early-reporting healthy
  // shards accumulated all assignments and late joiners got none.
  //
  // Sorting + modular indexing ensures each healthy shard receives at most
  // ceil(dead/healthy) dead shards.  The idempotency cache (_lastSentConfig)
  // means the resulting config updates are free when the assignment hasn't
  // actually changed.
  buildFaultyShardRedirectAssignment(faultyShards, shardStatusMap) {
    const healthyPool = this._healthyShardPool(shardStatusMap)
    const overSet = new Set(shardStatusMap[SHARD_STATUS.over_utilized] || [])
    // For assignments, prefer non-overutilized shards.  Fall back to
    // over-utilized only when all healthy shards are saturated.
    const assignPool = healthyPool.length > 0 ? healthyPool : [...overSet]

    const assignment = {}

    if (assignPool.length === 0) {
      // No healthy shards at all — clear all assignments.
      for (const faultyShard of faultyShards) {
        assignment[faultyShard] = { redirectSubset: null }
      }
      this._redirectAssignments.clear()
      return assignment
    }

    // Sort faulty shards for deterministic assignment order.
    const sortedFaulty = [...faultyShards].sort()
    // Sort assign pool for deterministic mapping.
    const sortedPool = [...assignPool].sort()

    // Distribute faulty shards evenly: shard[i] → pool[i % pool.length].
    this._redirectAssignments.clear()
    for (let i = 0; i < sortedFaulty.length; i++) {
      const target = sortedPool[i % sortedPool.length]
      this._redirectAssignments.set(sortedFaulty[i], target)
      assignment[sortedFaulty[i]] = { redirectSubset: target }
    }

    return assignment
  }

  // Apply redirect configuration to faulty shards.
  // Each dead shard is assigned the URLs of exactly ONE healthy shard — the one
  // selected by buildFaultyShardRedirectAssignment.  When no candidate is available
  // (redirectSubset === null), clears the URL so the broken shard buffers locally
  // until a healthy shard cools down and the core re-assigns a redirect URL.
  applyRedirectConfiguration(faultyShardRedirectAssignment) {
    Object.entries(faultyShardRedirectAssignment).forEach(
      ([faultyShardIndex, { redirectSubset }]) => {
        if (redirectSubset && this.sockets[redirectSubset]) {
          const redirectUrls = Object.values(this.sockets[redirectSubset]).map((o) => o.url)
          this.updateConfig([{ key: 'REDIRECT_TO_URL', value: redirectUrls }], faultyShardIndex)
        } else {
          // No healthy candidate right now — clear redirect URL
          this.updateConfig([{ key: 'REDIRECT_TO_URL', value: [] }], faultyShardIndex)
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
    const healthyPool = this._healthyShardPool(shardStatusMap)

    this.applyRedirectConfiguration(faultyShardRedirectAssignment, healthyPool)
    this.clearRedirectConfiguration([
      ...underUtilizedShards,
      ...normalShards,
      ...overUtilizedShards
    ])
  }

  // handles any message sent to the current node
  messageHandler(socket) {
    // registers message handler
    socket.on('message', async (message) => {
      if (Buffer.isBuffer(message)) {
        message = message.toString() // Convert Buffer to string
      }
      const receivedData = JSON.parse(message)
      const data = this.idaGossip.handleChunk(receivedData)
      if (data) {
        // Skip noisy per-message log for rate_to_core — fires 256×/sec at 512 nodes.
        if (data.type !== MESSAGE_TYPE.rate_to_core) {
          logger.log(this.port, 'RECEIVED', data.type)
        }

        // Remap shard identifiers from constituent shards to the merged shard.
        if (data.type === MESSAGE_TYPE.block_to_core && this._shardAliases.has(data.subsetIndex)) {
          data.subsetIndex = this._shardAliases.get(data.subsetIndex)
        }
        if (
          data.type === MESSAGE_TYPE.rate_to_core &&
          data.rate &&
          this._shardAliases.has(data.rate.shardIndex)
        ) {
          data.rate.shardIndex = this._shardAliases.get(data.rate.shardIndex)
        }

        // select a particular message handler
        switch (data.type) {
          case MESSAGE_TYPE.block_to_core:
            // add updated block to chain
            if (!this.blockchain.existingBlock(data.block.hash, data.subsetIndex)) {
              this.blockchain.addBlock(data.block, data.subsetIndex)
              this.broadcastBlock(data.block, data.subsetIndex)
            }
            break
          case MESSAGE_TYPE.rate_to_core:
            // collect shards rates
            // Accept the update when:
            //   a) First message from this shard (no prior entry)
            //   b) Transaction count increased (monotonic progress)
            //   c) Shard status changed (e.g. FAULTY→UNDER_UTILIZED after P2P mesh settles)
            // Without (c), a shard whose tx rate stays at 0 during the first minute
            // would remain permanently stuck as FAULTY in the core's map, keeping its
            // redirect URL active and preventing it from ever creating blocks.
            if (
              !this.rates[data.rate.shardIndex] ||
              this.rates[data.rate.shardIndex].transactions < data.rate.transactions ||
              this.rates[data.rate.shardIndex].shardStatus !== data.rate.shardStatus
            ) {
              this.rates[data.rate.shardIndex] = {
                transactions: data.rate.transactions,
                blocks: data.rate.blocks,
                shardStatus: data.rate.shardStatus
              }
              const { SHOULD_REDIRECT_FROM_FAULTY_NODES, ENABLE_SHARD_MERGE } = this.config
              if (SHOULD_REDIRECT_FROM_FAULTY_NODES) {
                this.handleFaultyShardRedirection()
              } else if (ENABLE_SHARD_MERGE && !this._mergeApplied) {
                this.applyShardMerge()
              }
            }
            break
        }
      }
    })
  }
}

module.exports = Coreserver
