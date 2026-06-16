const WebSocket = require('ws')
const axios = require('axios')
const MESSAGE_TYPE = require('../constants/message')
const logger = require('../utils/logger')
const TIMEOUTS = require('../constants/timeouts')

const config = require('../config')
const { SUBSET_INDEX, IS_FAULTY, VERIFICATION_SOURCE_SUBSETS } = config.get()

const P2P_PORT = process.env.P2P_PORT || 5001

const peers = process.env.PEERS ? process.env.PEERS.split(',') : []
const core = process.env.CORE

class P2pserver {
  // eslint-disable-next-line max-params
  constructor(
    blockchain,
    transactionPool,
    wallet,
    blockPool,
    preparePool,
    commitPool,
    messagePool,
    validators,
    idaGossip
  ) {
    this.sockets = {}
    this.wallet = wallet
    this.blockchain = blockchain
    this.transactionPool = transactionPool
    this.blockPool = blockPool
    this.preparePool = preparePool
    this.commitPool = commitPool
    this.messagePool = messagePool
    this.validators = validators
    this.lastTransactionCreatedAt = undefined
    this.idaGossip = idaGossip
    // View-change: incremented when the designated proposer is faulty/silent
    this._viewOffset = 0
    this._inactivityViewRotated = false
    this._poolWasFullThisEpoch = false
    // Vote pool for atomic view-change: targetView → Set<publicKey>.
    // A rotation only applies once MIN_APPROVALS distinct validator votes
    // arrive, so all shard nodes advance to the same view simultaneously.
    this._viewChangeVotes = new Map()
    // EMA backlog pressure: smoothed estimate of how many full BASE-sized blocks are
    // waiting in the unassigned pool.  Updated every time initiateBlockCreation fires.
    // Used for both adaptive block-size scaling and dynamic timeout shortening so all
    // load-reactive decisions share the same underlying signal.
    this._backlogEma = 0
    // Timestamp of last EMA diagnostic log — used to throttle high-frequency logging.
    // Without throttling, the EMA line fires on every incoming TX (up to 36/s per shard)
    // producing thousands of lines that bury the meaningful events.
    this._lastEmaLogAt = 0
    // _blockProposedAt[hash]: Date.now() when this node broadcast PRE_PREPARE for a block.
    // Used to measure actual PBFT round time (PRE_PREPARE → NEW BLOCK ADDED TO CHAIN).
    this._blockProposedAt = {}
    // Adaptive timeout: exponentially-smoothed average of actual PBFT round times.
    // The block creation timeout (= view-change timer) is set to max(1000, 2 × _avgRoundMs)
    // so small networks (16-64 nodes, ~0.5-2s rounds) get 1-2s view-change rotation
    // while large networks (512 nodes, ~17-35s rounds) keep their safe margin.
    // Start at 2000 ms so the first adaptive timeout is max(1000, 4000) = 4s.
    // Previously started at BLOCK_CREATION_TIMEOUT_MS/2 = 12500 ms which made
    // the first timeout 25 s — far too slow for ≤128-node networks with ~400 ms
    // actual rounds.  EMA converges to the true round time within 2-3 blocks.
    this._avgRoundMs = 2000
    // (no pending verification queue — verification TXs bypass the threshold ceiling)
  }

  listen() {
    const server = new WebSocket.Server({ port: P2P_PORT })
    server.on('connection', (socket, request) => {
      const parsedUrl = new URL(request.url, `http://${request.headers.host}`)
      const port = parsedUrl.searchParams.get('port')
      const isFaulty = parsedUrl.searchParams.get('isFaulty')
      logger.log(`new connection from ${port} to ${P2P_PORT}`)
      this.connectSocket(socket, port, isFaulty === 'true', false)
      this.messageHandler(socket, false)
      // Clean up stale socket entry when the remote peer drops so
      // gossip messages are not sent to dead sockets.
      socket.on('close', () => {
        logger.warn(`Incoming peer ${port} disconnected from ${P2P_PORT}`)
        if (this.sockets[port]?.socket === socket) {
          delete this.sockets[port]
          this.idaGossip.setPeerSockets({ peers: this.sockets })
        }
      })
      // Immediately announce own isFaulty to the connecting peer so outgoing
      // connections (which default to isFaulty=false) are corrected at once.
      // This is the authoritative source: the node knows its own IS_FAULTY flag
      // and the connecting peer cannot infer it from the connection direction alone.
      socket.send(
        JSON.stringify({ type: MESSAGE_TYPE.handshake, port: P2P_PORT, isFaulty: IS_FAULTY })
      )
    })
    this.connectToPeers(peers)
    this.connectToCore()

    setInterval(() => {
      const rate = this.blockchain.getOwnShardRate(this.sockets)
      this.broadcastRateToCore(rate)
    }, TIMEOUTS.RATE_BROADCAST_INTERVAL_MS)
  }

  connectSocket(socket, port, isFaulty, isCore = false) {
    if (!isCore) {
      this.sockets[port] = {
        socket,
        isFaulty
      }
      this.idaGossip.setPeerSockets({ peers: this.sockets })
    } else {
      this.coreSocket = socket
      this.idaGossip.setCoreSocket({ core: this.coreSocket })
    }
  }

  waitForWebServer(url, retryInterval = 1000) {
    return new Promise((resolve) => {
      function checkWebServer() {
        axios
          .get(`${url}/health`)
          .then(() => {
            logger.log(`WebServer is open: ${url}`)
            resolve(true)
            return true
          })
          .catch(() => {
            setTimeout(checkWebServer, retryInterval + 1000)
          })
      }

      checkWebServer()
    })
  }

  // connects to the peers passed in command line
  async connectToPeers(nodes) {
    await Promise.all(
      nodes.map((peer) => this.waitForWebServer(peer.replace('ws', 'http').replace(':5', ':3')))
    )
    nodes.forEach((peer) => {
      const peerPort = peer.split(':')[2]
      const connectPeer = () => {
        const socket = new WebSocket(
          `${peer}?port=${P2P_PORT}&isFaulty=${IS_FAULTY ? 'true' : 'false'}&subsetIndex=${SUBSET_INDEX}&httpPort=${process.env.HTTP_PORT}`
        )
        let reconnectScheduled = false
        const scheduleReconnect = () => {
          if (reconnectScheduled) return
          reconnectScheduled = true
          setTimeout(connectPeer, TIMEOUTS.PEER_RECONNECT_DELAY_MS)
        }
        socket.on('error', (error) => {
          logger.error(`Failed to connect to peer ${peerPort}. Retrying in 5s...`, error)
          scheduleReconnect()
        })
        socket.on('close', () => {
          logger.warn(`Peer ${peerPort} disconnected from ${P2P_PORT}, reconnecting in 5s...`)
          delete this.sockets[peerPort]
          this.idaGossip.setPeerSockets({ peers: this.sockets })
          scheduleReconnect()
        })
        socket.on('open', () => {
          logger.log(`new connection from inside ${P2P_PORT} to ${peerPort}`)
          this.connectSocket(socket, peerPort, false)
          this.messageHandler(socket, false)
        })
      }
      connectPeer()
    })
  }

  async connectToCore() {
    const connectCore = () => {
      const socket = new WebSocket(
        `${core}?port=${P2P_PORT}&subsetIndex=${SUBSET_INDEX}&httpPort=${process.env.HTTP_PORT}&isFaulty=${IS_FAULTY}`
      )
      let reconnectScheduled = false
      const scheduleReconnect = () => {
        if (reconnectScheduled) return
        reconnectScheduled = true
        setTimeout(connectCore, TIMEOUTS.PEER_RECONNECT_DELAY_MS)
      }
      socket.on('error', (error) => {
        logger.error(`Failed to connect to core. Retrying in 5s...`, error)
        scheduleReconnect()
      })
      socket.on('close', () => {
        logger.warn(`Core disconnected from ${P2P_PORT}, reconnecting in 5s...`)
        this.coreSocket = null
        this.idaGossip.setCoreSocket({ core: null })
        scheduleReconnect()
      })
      socket.on('open', () => {
        logger.log(`new connection from inside ${P2P_PORT} to ${core.split(':')[2]}`)
        this.connectSocket(socket, core.split(':')[2], false, true)
        this.messageHandler(socket, true)
      })
    }
    connectCore()
  }

  // broadcasts transactions
  broadcastTransaction(senderPort, transaction) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.transaction,
        port: P2P_PORT,
        transaction: transaction,
        isFaulty: IS_FAULTY
      },
      senderPort
    })
  }

  // broadcasts a batch of transactions in a single message
  broadcastTransactions(senderPort, transactions) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.transactions,
        port: P2P_PORT,
        transactions,
        isFaulty: IS_FAULTY
      },
      senderPort
    })
  }

  // broadcasts preprepare
  // eslint-disable-next-line max-params
  broadcastPrePrepare(senderPort, block, blocksCount, previousBlock = undefined, viewOffset = 0) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.pre_prepare,
        port: P2P_PORT,
        data: {
          block,
          previousBlock,
          blocksCount,
          viewOffset
        }
      },
      chunkKey: 'data',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcast prepare
  broadcastPrepare(senderPort, prepare) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.prepare,
        port: P2P_PORT,
        prepare
      },
      chunkKey: 'prepare',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcasts commit
  broadcastCommit(senderPort, commit) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.commit,
        port: P2P_PORT,
        commit
      },
      chunkKey: 'commit',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcasts round change
  broadcastRoundChange(senderPort, message) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.round_change,
        port: P2P_PORT,
        message
      },
      chunkKey: 'message',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcasts a view-change vote — sent by non-proposer nodes on inactivity;
  // _viewOffset only advances once MIN_APPROVALS votes are collected so all
  // shard nodes rotate atomically to the same view.
  broadcastViewChange(senderPort, viewChange) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.view_change,
        port: P2P_PORT,
        viewChange
      },
      chunkKey: 'viewChange',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcasts block to core
  broadcastBlockToCore(block) {
    this.idaGossip.sendToCore({
      message: {
        type: MESSAGE_TYPE.block_to_core,
        block,
        subsetIndex: this.blockchain._subsetIndex
      },
      chunkKey: 'block'
    })
  }

  // broadcasts rate to core
  broadcastRateToCore(rate) {
    // Guard: core WebSocket may not be established yet (race between the
    // setInterval timer and connectToCore's async handshake).  Skip silently —
    // the next interval tick will retry once the connection is ready.
    if (!this.idaGossip.socketGossipCore) return
    this.idaGossip.sendToCore({
      message: {
        type: MESSAGE_TYPE.rate_to_core,
        port: P2P_PORT,
        rate
      }
    })
  }

  _handleTransaction(data) {
    const _exists = this.transactionPool.transactionExists(data.transaction)
    if (
      !_exists &&
      this.transactionPool.verifyTransaction(data.transaction) &&
      this.validators.isValidValidator(data.transaction.from)
    ) {
      if (data.port && data.port in this.sockets) {
        this.sockets[data.port].isFaulty = data.isFaulty
      }
      this.transactionPool.addTransaction(data.transaction)
      logger.debug(
        P2P_PORT,
        'TRANSACTION ADDED, TOTAL NOW:',
        this.transactionPool.transactions.unassigned.length
      )
      this.broadcastTransaction(data.port, data.transaction)
      this.initiateBlockCreation(data.port)
    } else if (_exists) {
      logger.debug(
        P2P_PORT,
        `TX_DUPLICATE_REJECTED id=${data.transaction.id?.slice(0, 8)} shard=${SUBSET_INDEX}` +
          ` seenIndex=${this.transactionPool.transactionIds.size}`
      )
    }
  }

  // handles a batched array of transactions — adds each valid one to the pool
  // then broadcasts all accepted transactions in a single outbound message
  _handleTransactions(data) {
    // When this shard is in redirect mode (broken shard), suppress intra-shard gossip.
    // All peers in a broken shard would otherwise each receive the same TX via gossip
    // and each independently drain it — creating duplicate committed transactions on
    // the healthy target shard (one per broken-shard node) and a drain rate > 100%.
    const { REDIRECT_TO_URL, SHOULD_REDIRECT_FROM_FAULTY_NODES } = config.get()
    const isRedirectMode =
      SHOULD_REDIRECT_FROM_FAULTY_NODES &&
      Array.isArray(REDIRECT_TO_URL) &&
      REDIRECT_TO_URL.length > 0

    const toForward = []
    let _duplicateCount = 0
    for (const transaction of data.transactions) {
      if (
        !this.transactionPool.transactionExists(transaction) &&
        this.transactionPool.verifyTransaction(transaction) &&
        this.validators.isValidValidator(transaction.from)
      ) {
        if (data.port && data.port in this.sockets) {
          this.sockets[data.port].isFaulty = data.isFaulty
        }
        this.transactionPool.addTransaction(transaction)
        logger.debug(
          P2P_PORT,
          'TRANSACTION ADDED, TOTAL NOW:',
          this.transactionPool.transactions.unassigned.length
        )
        toForward.push(transaction)
      } else if (this.transactionPool.transactionExists(transaction)) {
        _duplicateCount++
      }
    }
    if (_duplicateCount > 0) {
      logger.debug(
        P2P_PORT,
        `TX_BATCH_DUPLICATES_REJECTED count=${_duplicateCount} shard=${SUBSET_INDEX}` +
          ` batchSize=${data.transactions.length} accepted=${toForward.length}` +
          ` seenIndex=${this.transactionPool.transactionIds.size}`
      )
    }
    if (toForward.length > 0 && !isRedirectMode) {
      this.broadcastTransactions(data.port, toForward)
      this.initiateBlockCreation(data.port)
    }
  }

  _handlePrePrepare(data) {
    const { block, previousBlock, blocksCount, viewOffset = 0 } = data.data
    // Sync view offset forward so we validate against the same proposer.
    if (viewOffset > (this._viewOffset || 0)) this._viewOffset = viewOffset
    // Proposer is working — cancel the view-change countdown
    clearTimeout(this._blockCreationTimeout)
    this._blockCreationTimeout = null
    if (
      !this.blockPool.existingBlock(block) &&
      this.blockchain.isValidBlock(block, blocksCount, previousBlock, viewOffset)
    ) {
      logger.log(
        P2P_PORT,
        `PRE_PREPARE RECEIVED shard=${SUBSET_INDEX} hash=${block.hash.slice(0, 8)}` +
          ` txCount=${block.data?.length ?? 0}` +
          ` blockNum=${blocksCount} viewOffset=${viewOffset}`
      )
      this.blockPool.addBlock(block)
      this.transactionPool.assignTransactions(block, this._getReassignmentTimeoutMs())
      this.broadcastPrePrepare(data.port, block, blocksCount, previousBlock, viewOffset)

      if (block?.hash) {
        const prepare = this.preparePool.prepare(block, this.wallet)
        this.broadcastPrepare(data.port, prepare)
      }
    }
  }

  _handlePrepare(data) {
    if (
      !this.preparePool.existingPrepare(data.prepare) &&
      this.preparePool.isValidPrepare(data.prepare, this.wallet) &&
      this.validators.isValidValidator(data.prepare.publicKey)
    ) {
      this.preparePool.addPrepare(data.prepare)
      this.broadcastPrepare(data.port, data.prepare)

      if (this.preparePool.list[data.prepare.blockHash].length >= config.get().MIN_APPROVALS) {
        const commit = this.commitPool.commit(data.prepare, this.wallet)
        this.broadcastCommit(data.port, commit)
      }
    }
  }

  async _handleCommit(data) {
    if (
      !this.commitPool.existingCommit(data.commit) &&
      this.commitPool.isValidCommit(data.commit) &&
      this.validators.isValidValidator(data.commit.publicKey)
    ) {
      this.commitPool.addCommit(data.commit)
      this.broadcastCommit(data.port, data.commit)

      const commitReached =
        this.commitPool.list[data.commit.blockHash].length >= config.get().MIN_APPROVALS
      const blockNotInChain = !this.blockchain.existingBlock(data.commit.blockHash)

      if (commitReached && blockNotInChain) {
        const result = await this.blockchain.addUpdatedBlock(
          data.commit.blockHash,
          this.blockPool,
          this.preparePool,
          this.commitPool
        )
        if (result !== false) {
          // Block committed — cancel view-change countdown and reset offset for next round
          clearTimeout(this._blockCreationTimeout)
          this._blockCreationTimeout = null
          this._viewOffset = 0
          this._inactivityViewRotated = false
          this._poolWasFullThisEpoch = false
          this._viewChangeVotes = new Map()
          this.broadcastBlockToCore(result)
          const _committedTxCount = Array.isArray(result.data) ? result.data.length : 0
          const _proposedAt = this._blockProposedAt[data.commit.blockHash]
          const _roundMs = _proposedAt ? Date.now() - _proposedAt : null
          delete this._blockProposedAt[data.commit.blockHash]
          // Update adaptive round-time average (EMA α=0.3 — responsive to changes
          // but smooth enough to avoid oscillation from single outlier rounds).
          if (_roundMs !== null && _roundMs > 0) {
            this._avgRoundMs = 0.7 * this._avgRoundMs + 0.3 * _roundMs
          }
          logger.log(
            P2P_PORT,
            `NEW BLOCK ADDED TO CHAIN shard=${this.blockchain._subsetIndex} blockNum=${this.blockchain.chain[this.blockchain._subsetIndex].length}` +
              ` txCount=${_committedTxCount}` +
              ` hash=${data.commit.blockHash.slice(0, 8)}` +
              ` roundMs=${_roundMs ?? 'n/a'}` +
              ` unassignedAfter=${this.transactionPool.transactions.unassigned.length}` +
              ` inflightAfter=${this.transactionPool.getInflightBlocks().length}` +
              ` seenIndex=${this.transactionPool.transactionIds.size}`
          )
          // Don't wait for a round-change quorum before clearing the pool and
          // starting the next block round. The PBFT commit phase already
          // guarantees 2f+1 agreement — all honest nodes that reach here have
          // already committed.  Clearing immediately eliminates one full P2P
          // gossip round-trip (propose→gossip→ MIN_APPROVALS replies) of dead
          // time between every consecutive block. _handleRoundChange.clear()
          // is idempotent (no-op if the hash bucket is already gone).
          this.transactionPool.clear(data.commit.blockHash, result.data)
          if (this.transactionPool.poolFull()) {
            // Threshold already met after clearing inflight — start next round immediately.
            this.initiateBlockCreation(P2P_PORT, false)
          } else if (this.transactionPool.transactions.unassigned.length > 0) {
            this._handlePostCommitRemainder()
          }
          const message = this.messagePool.createMessage(
            this.blockchain.chain[this.blockchain._subsetIndex][
              this.blockchain.chain[this.blockchain._subsetIndex].length - 1
            ],
            this.wallet
          )
          this.broadcastRoundChange(data.port, message)
        } else {
          logger.error(
            P2P_PORT,
            'NEW BLOCK FAILED TO ADD TO BLOCK CHAIN, TOTAL STILL:',
            this.blockchain.chain[this.blockchain._subsetIndex].length
          )
        }
        // getRate iterates all chain subsets — fire it off the critical path so
        // the commit handler returns quickly and the event loop stays responsive.
        this.blockchain
          .getRate(this.sockets)
          // eslint-disable-next-line promise/always-return
          .then((rate) => {
            const stats = {
              total: this.blockchain.getTotal(),
              rate,
              unassignedTransactions: this.transactionPool.transactions.unassigned.length
            }
            logger.log(P2P_PORT, `P2P STATS FOR #${SUBSET_INDEX}:`, JSON.stringify(stats))
          })
          .catch(() => {})
      }
    }
  }

  _handleViewChange(data) {
    const { targetView, publicKey } = data.viewChange
    if (!this.validators.isValidValidator(publicKey)) return
    if (!this._viewChangeVotes.has(targetView)) this._viewChangeVotes.set(targetView, new Set())
    const votes = this._viewChangeVotes.get(targetView)
    if (votes.has(publicKey)) return // deduplicate
    votes.add(publicKey)
    // Relay so all shard peers receive this vote
    this.broadcastViewChange(data.port, data.viewChange)
    // Quorum reached and this view is ahead of where we are — rotate atomically
    if (votes.size >= config.get().MIN_APPROVALS && targetView > (this._viewOffset || 0)) {
      this._viewOffset = targetView
      // Reset both epoch flags so initiateBlockCreation (called immediately below)
      // can fire another vote right away if the NEW proposer at this view is also
      // faulty — eliminates the 10 s timeout wait for consecutive faulty proposers.
      this._poolWasFullThisEpoch = false
      this._inactivityViewRotated = false
      // Return all TX that are assigned to the abandoned block back to the
      // unassigned pool immediately — new proposer can pick them up at once
      // instead of waiting up to 30 s for the safety-reassignment timers.
      this.transactionPool.releaseAssigned()
      logger.log(
        P2P_PORT,
        `VIEW CHANGE QUORUM shard=${SUBSET_INDEX} — rotating to view ${this._viewOffset}` +
          ` unassignedAfterRelease=${this.transactionPool.transactions.unassigned.length}` +
          ` inflightAfterRelease=${this.transactionPool.getInflightBlocks().length}`
      )
      this.initiateBlockCreation(P2P_PORT, false)
    }
  }

  _handleRoundChange(data) {
    if (
      !this.messagePool.existingMessage(data.message) &&
      this.messagePool.isValidMessage(data.message) &&
      this.validators.isValidValidator(data.message.publicKey)
    ) {
      this.messagePool.addMessage(data.message)
      this.broadcastRoundChange(data.port, data.message)

      if (
        this.messagePool.list[data.message.blockHash] &&
        this.messagePool.list[data.message.blockHash].length >= config.get().MIN_APPROVALS
      ) {
        logger.log(
          P2P_PORT,
          'TRANSACTION POOL TO BE CLEARED, TOTAL NOW:',
          this.transactionPool.transactions[data.message.blockHash]?.length
        )
        this.transactionPool.clear(data.message.blockHash, data.message.data)
        // Re-arm block creation respecting threshold — don't immediately propose a
        // tiny leftover block; only immediately propose when the pool is already full.
        if (this.transactionPool.poolFull()) {
          this.initiateBlockCreation(P2P_PORT, false)
        } else if (this.transactionPool.transactions.unassigned.length > 0) {
          logger.log(
            P2P_PORT,
            `SCHEDULING TIMER shard=${SUBSET_INDEX} reason=post-roundchange` +
              ` unassigned=${this.transactionPool.transactions.unassigned.length}` +
              ` threshold=${config.get().TRANSACTION_THRESHOLD}`
          )
          this._scheduleTimeoutBlockCreation()
        }
      }
    }
  }

  // Cross-shard verification: wrap the entire source shard block as a SINGLE
  // verification transaction (like RapidChain's committee wrapping).  This
  // replaces the old approach of injecting N individual TXs from the block,
  // which doubled the PBFT load on the verifying shard.  Now a whole shard
  // block is validated in one wrapper TX — 1 consensus round for the entire
  // block instead of 1 per-TX.
  //
  // The wrapper TX has _type:'verification' and its input.data contains the
  // full block data + source subsetIndex, so the verified content is immutably
  // signed by this shard's wallet.

  _injectVerificationTransactions(block) {
    // Create ONE wrapper transaction containing the entire block from the source shard.
    // Signature covers the block data + subsetIndex, so the wrapper is tamper-proof.
    const wrapperTx = this.wallet.createTransaction({
      data: block.data,
      subsetIndex: block.subsetIndex
    })
    wrapperTx._type = 'verification'
    if (this.transactionPool.transactionExists(wrapperTx)) return
    this.transactionPool.addTransaction(wrapperTx)
    this.broadcastTransaction(P2P_PORT, wrapperTx)
    this.initiateBlockCreation(P2P_PORT, true)
  }

  async _handleBlockFromCore(data, isCore) {
    const blockNotInChain = !this.blockchain.existingBlock(data.block.hash, data.subsetIndex)
    const isDifferentShard = data.subsetIndex !== this.blockchain._subsetIndex

    if (blockNotInChain && isDifferentShard && isCore === true) {
      this.blockchain.addBlock(data.block, data.subsetIndex)

      if (
        !IS_FAULTY &&
        VERIFICATION_SOURCE_SUBSETS.length > 0 &&
        VERIFICATION_SOURCE_SUBSETS.includes(data.subsetIndex)
      ) {
        this._injectVerificationTransactions({ ...data.block, subsetIndex: data.subsetIndex })
      }
    }
  }

  _handleConfigFromCore(data, isCore) {
    if (isCore === true) {
      data.config.forEach((item) => {
        config.set(item.key, item.value)
      })
      logger.log(P2P_PORT, `CONFIG UPDATE FOR #${SUBSET_INDEX}:`, JSON.stringify(data.config))
    }
  }

  // Core has instructed this node to join a merged shard.
  // We receive: peerWsUrls (new P2P peers), mergedNodesSubset (combined node indices),
  // minApprovals (stays at original shard-size value), and mergedShardIndex.
  _handleMergeShard(data) {
    const {
      peerWsUrls,
      mergedNodesSubset,
      minApprovals,
      mergedShardIndex,
      verificationSourceSubsets
    } = data

    logger.log(
      P2P_PORT,
      `MERGE_SHARD received: joining ${mergedShardIndex}`,
      `peers=${peerWsUrls.length} nodesSubset=[${mergedNodesSubset.join(',')}] minApprovals=${minApprovals}` +
        ` verification=${JSON.stringify(verificationSourceSubsets)}`
    )

    // Update runtime config so consensus uses the merged shard parameters.
    config.set('NODES_SUBSET', mergedNodesSubset)
    config.set('NUMBER_OF_NODES_PER_SHARD', mergedNodesSubset.length)
    config.set('MIN_APPROVALS', minApprovals)
    config.set('SUBSET_INDEX', mergedShardIndex)
    // Update verification ring so merged shards verify each other.
    if (verificationSourceSubsets) {
      VERIFICATION_SOURCE_SUBSETS.length = 0
      VERIFICATION_SOURCE_SUBSETS.push(...verificationSourceSubsets)
    }

    // Rebuild the validator list for the merged shard's node indices.
    this.validators.updateValidators(mergedNodesSubset)
    this.blockchain.validatorList = this.validators.list

    // Create a fresh chain under the merged shard key.  All merged nodes
    // start from an identical genesis so PBFT consensus (which requires
    // agreement on the previous block hash) works from the first round.
    // Old chain data stays under the original key for stats / history.
    this.blockchain.initMergedChain(mergedShardIndex)

    // Remove peers that are NOT part of the merged shard — old faulty peers
    // would waste gossip bandwidth and inflate the node count in getOwnShardRate.
    const mergedPorts = new Set(mergedNodesSubset.map((idx) => String(5001 + idx)))
    for (const port of Object.keys(this.sockets)) {
      if (!mergedPorts.has(port)) {
        const sock = this.sockets[port]?.socket
        if (sock) sock.close()
        delete this.sockets[port]
      }
    }
    this.idaGossip.setPeerSockets({ peers: this.sockets })

    // Connect to the new peers (skips already-connected ones).
    const existingPorts = new Set(Object.keys(this.sockets))
    const newPeers = peerWsUrls.filter((url) => {
      const port = url.split(':')[2]
      return !existingPorts.has(port)
    })
    if (newPeers.length > 0) {
      this.connectToPeers(newPeers)
    }

    logger.log(P2P_PORT, `MERGE_SHARD applied: now in shard ${mergedShardIndex}`)
  }

  messageHandler(socket, isCore = false) {
    socket.on('message', (message) => {
      try {
        if (Buffer.isBuffer(message)) {
          message = message.toString()
        }
        const data = JSON.parse(message)
        // Handle handshake directly before gossip chunking — it is a one-shot
        // direct message (never gossiped) carrying the peer's own IS_FAULTY flag.
        // Corrects outgoing-side entries that were registered with isFaulty=false
        // because we couldn't know the peer's role at connection-open time.
        if (data.type === MESSAGE_TYPE.handshake) {
          if (data.port && this.sockets[data.port]) {
            this.sockets[data.port].isFaulty = data.isFaulty
          }
          // Immediately push the updated shard status to the core so it can
          // act on it (handleFaultyShardRedirection) without waiting for the
          // next RATE_BROADCAST_INTERVAL_MS tick.
          this.broadcastRateToCore(this.blockchain.getOwnShardRate(this.sockets))
          return
        }
        // merge_shard is sent as raw JSON directly from coreserver (not chunked
        // through IDA gossip), so it must be intercepted before handleChunk —
        // otherwise handleChunk returns null and the message is silently dropped.
        if (data.type === MESSAGE_TYPE.merge_shard) {
          this._handleMergeShard(data)
          return
        }
        const processedData = this.idaGossip.handleChunk(data)
        if (processedData) {
          this.parseMessage(processedData, isCore)
        }
      } catch (error) {
        logger.error('Failed to parse message:', error.message)
      }
    })
  }

  _scheduleTimeoutBlockCreation() {
    // Reset the timer when the pool is NOT full — a commit just freed capacity
    // and we should start a fresh countdown from now.  But when the pool IS full
    // (detecting a silent proposer), never reset — the countdown must fire to
    // trigger view-change.  This matches RapidChain's timer strategy.
    const poolFull = this.transactionPool.poolFull()
    if (!poolFull) {
      clearTimeout(this._blockCreationTimeout)
      this._blockCreationTimeout = null
    } else if (this._blockCreationTimeout) {
      return // already counting down for view-change — keep the deadline
    }
    // Adaptive timeout: 2× the smoothed average round time, clamped to [1s, 25s].
    // Small networks (~0.5-1s rounds) get ~1s view-change rotation; 512-node networks
    // (~17-35s rounds) get up to 25s.  Previously floored at 3s, but at 128 nodes
    // with ~400ms actual rounds this meant 3s dead time between every sub-threshold
    // block during the drain phase.  Dead-shard drain TXs trickle into healthy
    // shards keeping them in "active" mode, so every block waited 3s.  Lowering
    // to 1s cuts drain time by ~3x (from ~160s to ~50s).
    const _timeoutMs = Math.max(
      1000,
      Math.min(Math.round(2 * this._avgRoundMs), TIMEOUTS.BLOCK_CREATION_TIMEOUT_MS)
    )
    this._blockCreationTimeout = setTimeout(() => {
      this._blockCreationTimeout = null
      this._onBlockCreationTimeout()
    }, _timeoutMs)
  }

  _onBlockCreationTimeout() {
    const now = new Date()
    const isInactive =
      this.lastTransactionCreatedAt &&
      now - this.lastTransactionCreatedAt >= TIMEOUTS.TRANSACTION_INACTIVITY_THRESHOLD_MS
    const hasTransactions = this.transactionPool.transactions.unassigned.length > 0
    const poolFull = this.transactionPool.poolFull()
    // Use the current _viewOffset so isProposer reflects whoever is actually
    // elected this round, not always the viewOffset=0 slot.
    const proposerObject = this.blockchain.getProposer(undefined, this._viewOffset || 0)
    const isProposer = proposerObject.proposer === this.wallet.getPublicKey()
    const { TRANSACTION_THRESHOLD: _th } = config.get()
    logger.log(
      P2P_PORT,
      `TIMEOUT_FIRED shard=${SUBSET_INDEX} hasTransactions=${hasTransactions}` +
        ` poolFull=${poolFull}` +
        ` isInactive=${!!isInactive}` +
        ` unassigned=${this.transactionPool.transactions.unassigned.length}` +
        ` threshold=${_th}` +
        ` isProposer=${isProposer}` +
        ` viewOffset=${this._viewOffset || 0}` +
        ` inflightBlocks=${this.transactionPool.getInflightBlocks().length}`
    )

    if (hasTransactions && poolFull) {
      this._handlePoolFullTimeout(isProposer)
    } else if (isInactive && hasTransactions) {
      this._handleInactivityTimeout(isProposer)
    } else if (hasTransactions) {
      // Pool has TX but neither full nor inactive yet — reschedule so we keep
      // checking every BLOCK_CREATION_TIMEOUT_MS until conditions are met.
      this._scheduleTimeoutBlockCreation()
    }
  }

  // Pool still full after BLOCK_CREATION_TIMEOUT_MS — proposer still silent.
  // Vote via broadcast so all shard nodes rotate to the same view atomically.
  // Map-level dedup prevents re-broadcasting a vote already cast this epoch.
  _handlePoolFullTimeout(isProposer) {
    if (!isProposer) {
      // Redistribute TXs to the network so the (potentially new) proposer can
      // fill blocks.  Uses a single broadcastTransactions batch message instead
      // of per-tx broadcasts to limit WebSocket overhead under CPU limits.
      const normalTxs = this.transactionPool.transactions.unassigned.filter(
        (tx) => tx._type !== 'verification'
      )
      const toRedistribute = normalTxs.slice(0, config.get().TRANSACTION_THRESHOLD)
      if (toRedistribute.length > 0) {
        logger.log(
          P2P_PORT,
          `REDISTRIBUTE shard=${SUBSET_INDEX} count=${toRedistribute.length}` +
            ` totalUnassigned=${this.transactionPool.transactions.unassigned.length}` +
            ` seenIndex=${this.transactionPool.transactionIds.size}`
        )
        this.broadcastTransactions(P2P_PORT, toRedistribute)
      }
      // Only non-proposers vote — the proposer should be creating blocks,
      // not voting to skip itself. If the proposer is stuck the inactivity
      // path will escalate after TRANSACTION_INACTIVITY_THRESHOLD_MS.
      this._poolWasFullThisEpoch = true
      const targetView = (this._viewOffset || 0) + 1
      if (!this._viewChangeVotes.has(targetView)) this._viewChangeVotes.set(targetView, new Set())
      if (!this._viewChangeVotes.get(targetView).has(this.wallet.getPublicKey())) {
        this._viewChangeVotes.get(targetView).add(this.wallet.getPublicKey())
        logger.log(
          P2P_PORT,
          `VIEW CHANGE VOTE (timeout) shard=${SUBSET_INDEX} — proposing view ${targetView}` +
            ` unassigned=${this.transactionPool.transactions.unassigned.length}` +
            ` inflight=${this.transactionPool.getInflightBlocks().length}` +
            ` viewChangeVotes=${this._viewChangeVotes.get(targetView)?.size ?? 0}`
        )
        this.broadcastViewChange(P2P_PORT, {
          targetView,
          publicKey: this.wallet.getPublicKey()
        })
      }
    }
    this.initiateBlockCreation(P2P_PORT, false)
  }

  // Cast a view-change vote when this node is not the current proposer,
  // the pool-full path has not already rotated this epoch, and this node
  // has not yet broadcast its vote.  The offset only changes once
  // MIN_APPROVALS votes arrive in _handleViewChange so all shard peers
  // rotate atomically to the same view.
  _handleInactivityTimeout(isProposer) {
    if (!isProposer && !this._poolWasFullThisEpoch && !this._inactivityViewRotated) {
      this._inactivityViewRotated = true
      const targetView = (this._viewOffset || 0) + 1
      if (!this._viewChangeVotes.has(targetView)) this._viewChangeVotes.set(targetView, new Set())
      this._viewChangeVotes.get(targetView).add(this.wallet.getPublicKey())
      logger.log(
        P2P_PORT,
        `VIEW CHANGE VOTE (inactivity) shard=${SUBSET_INDEX} — proposing view ${targetView}` +
          ` unassigned=${this.transactionPool.transactions.unassigned.length}` +
          ` inflight=${this.transactionPool.getInflightBlocks().length}`
      )
      this.broadcastViewChange(P2P_PORT, { targetView, publicKey: this.wallet.getPublicKey() })
    }
    // Sub-threshold drain: if this node is the proposer and ready, create a
    // block with whatever TX are available instead of waiting for view-change
    // quorum that can never produce a block (threshold will never be reached).
    if (isProposer && this._canProposeBlock()) {
      logger.log(
        P2P_PORT,
        `PROPOSING BLOCK shard=${SUBSET_INDEX} txCount=${this.transactionPool.transactions.unassigned.length} path=inactivity viewOffset=${this._viewOffset || 0}`
      )
      this._createAndBroadcastBlock(P2P_PORT, this._viewOffset || 0)
    } else {
      // Keep trying with the current offset while waiting for quorum
      this.initiateBlockCreation(P2P_PORT, false)
    }
  }

  _canProposeBlock() {
    const inflightBlocks = this.transactionPool.getInflightBlocks()
    // Pipeline up to 5 concurrent blocks without waiting for PREPARE quorum on
    // prior blocks.  Each block has its own hash-bucketed TX assignment so there
    // is no data dependency between consecutive blocks — only the previousBlock
    // pointer (handled by _createAndBroadcastBlock) needs to be correct.
    // This hides PBFT latency: while block N is in prepare/commit, blocks N+1
    // through N+4 are already being proposed and voted on.  Raised from 3 to 5
    // to match RapidChain's deeper pipeline and better hide consensus latency
    // at all network sizes.
    return inflightBlocks.length <= 5
  }

  // Adaptive reassignment timeout: max(15s, 3 × avgRoundMs), capped at 60s.
  // Small networks recycle stuck TXs in ~15s; large networks stay safe.
  _getReassignmentTimeoutMs() {
    return Math.max(
      15000,
      Math.min(Math.round(3 * this._avgRoundMs), TIMEOUTS.TRANSACTION_REASSIGNMENT_TIMEOUT_MS)
    )
  }

  // Post-commit: TXs remain below threshold.  Three fast-paths avoid waiting
  // for the full adaptive timeout:
  //
  //  1. isDraining (no new TXs for > INACTIVITY_THRESHOLD):  propose immediately
  //     so the drain phase finishes as fast as consensus allows.
  //  2. Pool has ≥ threshold/4 TXs:  propose immediately to utilise the pipeline
  //     (depth 5).  Without this, inflight was always 0 at proposal time — the
  //     pipeline feature was completely wasted.
  //  3. Otherwise:  schedule the adaptive timeout (now floored at 1 s).
  //
  // The threshold/4 gate prevents a cascade of tiny 1-2 TX blocks during active
  // load (where only a few leftover TXs remain after each commit) while still
  // letting the pipeline absorb moderate remainders (25+ TXs at threshold=100).
  //
  // Critical for 128-node performance: dead-shard honest nodes drain TXs to
  // healthy shards via a batch loop, creating a "trickle" that keeps isDraining
  // false even after JMeter stops.  Previously, healthy shards waited 3 s per
  // sub-threshold block during this trickle — now they either propose immediately
  // (if ≥25 TXs) or wait only 1 s (new timeout floor).
  _handlePostCommitRemainder() {
    const sinceLastTx = this.lastTransactionCreatedAt
      ? Date.now() - this.lastTransactionCreatedAt
      : Infinity
    const isDraining = sinceLastTx >= TIMEOUTS.TRANSACTION_INACTIVITY_THRESHOLD_MS
    const isProposer =
      this.blockchain.getProposer(undefined, this._viewOffset || 0).proposer ===
      this.wallet.getPublicKey()
    const unassigned = this.transactionPool.transactions.unassigned.length
    const { TRANSACTION_THRESHOLD: _th } = config.get()
    // Propose immediately when draining OR when pool has a meaningful payload.
    const shouldProposeNow = isDraining || unassigned >= Math.ceil(_th / 4)

    if (shouldProposeNow && isProposer && this._canProposeBlock()) {
      logger.log(
        P2P_PORT,
        `PROPOSING BLOCK shard=${SUBSET_INDEX} txCount=${unassigned}` +
          ` path=${isDraining ? 'drain-fast' : 'pipeline-fast'}` +
          ` inflight=${this.transactionPool.getInflightBlocks().length}`
      )
      clearTimeout(this._blockCreationTimeout)
      this._blockCreationTimeout = null
      this._createAndBroadcastBlock(P2P_PORT, this._viewOffset || 0)
    } else {
      logger.log(
        P2P_PORT,
        `SCHEDULING TIMER shard=${SUBSET_INDEX} reason=post-commit` +
          ` unassigned=${unassigned}` +
          ` threshold=${_th}`
      )
      this._scheduleTimeoutBlockCreation()
    }
  }

  _createAndBroadcastBlock(port, viewOffset = 0) {
    const lastUnpersistedBlock = this.blockPool.blocks[this.blockPool.blocks.length - 1]
    const inflightBlocks = this.transactionPool.getInflightBlocks()
    const previousBlock = inflightBlocks.length > 1 ? lastUnpersistedBlock : undefined
    // Normal TXs take priority — partition in O(n) instead of O(n log n) sort.
    // Normal TXs fill the block first; verification TXs fill remaining capacity.
    const { TRANSACTION_THRESHOLD: _liveThreshold } = config.get()
    // Defence-in-depth: purge any already-committed TXs that landed back in
    // unassigned via the safety-reassignment timer or releaseAssigned().
    if (this.transactionPool.committedTxIds.size > 0) {
      this.transactionPool.transactions.unassigned =
        this.transactionPool.transactions.unassigned.filter(
          (tx) => !this.transactionPool.committedTxIds.has(tx.id)
        )
    }
    const unassigned = this.transactionPool.transactions.unassigned
    const normalTxs = []
    const verificationTxs = []
    for (const tx of unassigned) {
      if (tx._type === 'verification') {
        verificationTxs.push(tx)
      } else {
        normalTxs.push(tx)
      }
    }
    const batchSize = Math.min(_liveThreshold, normalTxs.length + verificationTxs.length)
    const normalTake = Math.min(normalTxs.length, batchSize)
    const verificationTake = Math.min(verificationTxs.length, batchSize - normalTake)
    const transactionsBatch = [
      ...normalTxs.slice(0, normalTake),
      ...verificationTxs.slice(0, verificationTake)
    ]
    // Rebuild unassigned from leftovers (O(n) — replaces sort + splice)
    this.transactionPool.transactions.unassigned = [
      ...normalTxs.slice(normalTake),
      ...verificationTxs.slice(verificationTake)
    ]
    const block = this.blockchain.createBlock(transactionsBatch, this.wallet, previousBlock)

    logger.log(
      P2P_PORT,
      `CREATED BLOCK shard=${SUBSET_INDEX} hash=${block.hash.slice(0, 8)} txCount=${block.data.length}` +
        ` threshold=${_liveThreshold} ema=${this._backlogEma.toFixed(2)}` +
        ` viewOffset=${viewOffset}`
    )
    this._blockProposedAt[block.hash] = Date.now()
    // The proposer must add its own block to blockPool and assign its TXs
    // to the hash bucket BEFORE broadcasting — otherwise when commit quorum
    // arrives (potentially before the PRE_PREPARE relay returns from peers),
    // addUpdatedBlock() cannot find the block and logs "FAILED TO LOCATE BLOCK".
    // The chain then stays behind, every subsequent proposal carries the wrong
    // lastHash, and all proposals are rejected as BLOCK INVALID by peers —
    // permanently losing 100 TXs per proposal (spliced from unassigned but never
    // moved to transactions[hash], so TRANSACTION_REASSIGNMENT_TIMEOUT cannot
    // return them).
    this.blockPool.addBlock(block)
    this.transactionPool.assignTransactions(block, this._getReassignmentTimeoutMs())
    // one shard peer is faulty (only 3 non-faulty nodes, all three must vote).
    const ownPrepare = this.preparePool.prepare(block, this.wallet)
    this.broadcastPrePrepare(
      port,
      block,
      this.blockchain.chain[this.blockchain._subsetIndex].length,
      previousBlock,
      viewOffset
    )
    this.broadcastPrepare(port, ownPrepare)
  }

  // Returns true and arms a 15 s re-check timer when this node is in a dead
  // shard (REDIRECT_TO_URL set by the core). Callers should skip all PBFT work.
  _isDeadShardRedirecting(port) {
    if (IS_FAULTY) return false
    const { REDIRECT_TO_URL, SHOULD_REDIRECT_FROM_FAULTY_NODES } = config.get()
    if (
      !SHOULD_REDIRECT_FROM_FAULTY_NODES ||
      !Array.isArray(REDIRECT_TO_URL) ||
      REDIRECT_TO_URL.length === 0
    )
      return false
    // Arm a re-check timer so we resume PBFT the moment the core clears the URL
    // (shard recovered). The drain loop in appP2p.js keeps forwarding TXs.
    if (!this._blockCreationTimeout) {
      this._blockCreationTimeout = setTimeout(() => {
        this._blockCreationTimeout = null
        this.initiateBlockCreation(port, false)
      }, this._getReassignmentTimeoutMs())
    }
    return true
  }

  initiateBlockCreation(port, _triggeredByTransaction = true) {
    // Dead-shard bypass: running PBFT view-change loops every 5 s on the 340
    // honest dead-shard nodes consumed ~85 % CPU each, pushing the cluster
    // average from RC's 17 % to Enhanced's 59 % and inflating JMeter response
    // time from ~70 ms to ~424 ms. Pause PBFT when redirect is active.
    if (this._isDeadShardRedirecting(port)) return

    // Only update inactivity clock for real incoming transactions.
    // Timeout-path calls (_triggeredByTransaction=false) must not reset the
    // clock or isInactive will always be false during active JMeter load.
    if (_triggeredByTransaction) this.lastTransactionCreatedAt = new Date()

    // Fast path: when this call was triggered by an incoming TX and the pool is
    // still below threshold, skip the EMA + proposer-check entirely — nothing
    // to decide yet.  At 9 TX/s this short-circuits ~90 % of all calls before
    // any O(n) work (getInflightBlocks, config.get, getProposer) runs.
    // The timeout timer is still armed so we never stall: if no further TXs
    // arrive, _onBlockCreationTimeout will drain the sub-threshold remainder.
    if (_triggeredByTransaction && !this.transactionPool.poolFull()) {
      this._scheduleTimeoutBlockCreation()
      return
    }

    // Compute inflight once — reused in the proposal section below.
    const _inflightHashes = this.transactionPool.getInflightBlocks()

    // EMA adaptive block sizing disabled: the fast-path short-circuit above
    // introduces a sampling bias (EMA only runs when poolFull, so every sample
    // has pressure >= 1.0) that ratchets the threshold to 3× BASE.  At the
    // current per-shard TX arrival rate (~21 TX/s), larger blocks increase
    // accumulation latency without improving throughput — 6 blocks/shard vs
    // ~20 at BASE.  Reset threshold to BASE each round so blocks stay at 100.
    {
      const { BASE_TRANSACTION_THRESHOLD: _BASE, TRANSACTION_THRESHOLD: _cur } = config.get()
      if (_cur !== _BASE) config.set('TRANSACTION_THRESHOLD', _BASE)
    }

    const thresholdReached = this.transactionPool.poolFull()
    if (!IS_FAULTY && (thresholdReached || !_triggeredByTransaction)) {
      const readyToPropose = this._canProposeBlock()
      const viewOffset = this._viewOffset || 0
      const proposerObject = this.blockchain.getProposer(undefined, viewOffset)
      const inflightBlocks = _inflightHashes // reuse — no second Object.keys allocation
      const isProposer = proposerObject.proposer === this.wallet.getPublicKey()
      const canCreateBlock = isProposer && readyToPropose && inflightBlocks.length <= 5
      // Check if the elected proposer is already a known-faulty peer (isFaulty set at
      // connection time or via transaction relay). If so, vote to skip immediately
      // instead of waiting 10 s for the timeout — eliminates per-rotation stall.
      const proposerPort =
        proposerObject.proposerIndex !== null ? String(5001 + proposerObject.proposerIndex) : null
      const proposerKnownFaulty =
        proposerPort !== null && this.sockets[proposerPort]?.isFaulty === true

      if (canCreateBlock) {
        logger.log(
          P2P_PORT,
          `PROPOSING BLOCK shard=${SUBSET_INDEX} txCount=${this.transactionPool.transactions.unassigned.length}` +
            ` path=${thresholdReached ? 'threshold' : 'timeout/inactivity'}` +
            ` viewOffset=${viewOffset} inflight=${inflightBlocks.length}` +
            ` proposer=${this.wallet.getPublicKey().slice(0, 8)}`
        )
        // We are the proposer — clear any pending view-change countdown
        clearTimeout(this._blockCreationTimeout)
        this._blockCreationTimeout = null
        this._createAndBroadcastBlock(port, viewOffset)
      } else if (
        thresholdReached &&
        !isProposer &&
        proposerKnownFaulty &&
        !this._poolWasFullThisEpoch &&
        !this._inactivityViewRotated
      ) {
        // Pool is at threshold and proposer is known-faulty — vote to skip immediately
        // regardless of whether this was triggered by an incoming TX or by a view-change
        // quorum handler. This covers drain phase where no new TX arrive but the pool
        // still has 30+ unprocessed TX after releaseAssigned().
        this._poolWasFullThisEpoch = true
        const targetView = viewOffset + 1
        if (!this._viewChangeVotes.has(targetView)) this._viewChangeVotes.set(targetView, new Set())
        this._viewChangeVotes.get(targetView).add(this.wallet.getPublicKey())
        logger.log(
          P2P_PORT,
          'VIEW CHANGE VOTE (known-faulty proposer) — proposing view',
          targetView
        )
        this.broadcastViewChange(port, { targetView, publicKey: this.wallet.getPublicKey() })
        // NOTE: Removed immediate "pool full + _triggeredByTransaction" view-change vote.
        // When redirect is active, all shard-2 nodes reach poolFull() within milliseconds
        // of each other. If non-proposers voted immediately they would form a 3-vote
        // quorum before the proposer's pre-prepare propagates, triggering a view change
        // that discards the proposer's assignTransactions() call — leaving 150 txs stuck
        // in reassignment for 30 s and creating near-empty replacement blocks.
        // The BLOCK_CREATION_TIMEOUT_MS (5 s) path handles silent/faulty proposers;
        // the proposerKnownFaulty path above handles explicitly-flagged ones.
      }
    } else if (!IS_FAULTY) {
      logger.debug(
        P2P_PORT,
        'Transaction Threshold NOT REACHED, TOTAL UNASSIGNED NOW:',
        this.transactionPool.transactions.unassigned.length
      )
    }

    this._scheduleTimeoutBlockCreation()
  }

  async parseMessage(data, isCore) {
    logger.debug(P2P_PORT, 'RECEIVED', data.type, data.port)

    if (IS_FAULTY && ![MESSAGE_TYPE.transaction, MESSAGE_TYPE.transactions].includes(data.type)) {
      return
    }

    switch (data.type) {
      case MESSAGE_TYPE.transaction:
        this._handleTransaction(data)
        break
      case MESSAGE_TYPE.transactions:
        this._handleTransactions(data)
        break
      case MESSAGE_TYPE.pre_prepare:
        this._handlePrePrepare(data)
        break
      case MESSAGE_TYPE.prepare:
        this._handlePrepare(data)
        break
      case MESSAGE_TYPE.commit:
        await this._handleCommit(data)
        break
      case MESSAGE_TYPE.round_change:
        this._handleRoundChange(data)
        break
      case MESSAGE_TYPE.view_change:
        this._handleViewChange(data)
        break
      case MESSAGE_TYPE.block_from_core:
        await this._handleBlockFromCore(data, isCore)
        break
      case MESSAGE_TYPE.config_from_core:
        this._handleConfigFromCore(data, isCore)
        break
      case MESSAGE_TYPE.merge_shard:
        this._handleMergeShard(data)
        break
    }
  }
}

module.exports = P2pserver
