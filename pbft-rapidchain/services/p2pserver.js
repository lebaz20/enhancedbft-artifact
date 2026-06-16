const WebSocket = require('ws')
const axios = require('axios')
const MESSAGE_TYPE = require('../constants/message')
const TIMEOUTS = require('../constants/timeouts')
const logger = require('../utils/logger')

const config = require('../config')
const {
  NODES_SUBSET,
  MIN_APPROVALS,
  SUBSET_INDEX,
  TRANSACTION_THRESHOLD,
  BLOCK_THRESHOLD,
  IS_FAULTY,
  CORE,
  PEERS,
  COMMITTEE_PEERS,
  COMMITTEE_SUBSET
} = config.get()

const P2P_PORT = process.env.P2P_PORT || 5001

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
    idaGossip,
    committeeValidators
  ) {
    this.sockets = {
      peers: {},
      committeePeers: {}
    }
    this.coreSocket = {
      core: null,
      committeeCore: null
    }
    this.wallet = wallet
    this.blockchain = blockchain
    this.transactionPool = transactionPool
    this.blockPool = blockPool
    this.preparePool = preparePool
    this.commitPool = commitPool
    this.messagePool = messagePool
    this.validators = validators
    // Committee validators are based on COMMITTEE_SUBSET (all committee node indices).
    // Using shard validators for committee messages causes cross-shard committee
    // transactions to be rejected (shard A rejects keys from shard B committee members).
    this.committeeValidators = committeeValidators || validators
    this.lastTransactionCreatedAt = undefined
    this.lastCommitteeTransactionCreatedAt = undefined
    this.idaGossip = idaGossip
    // View-change: incremented each time the designated proposer fails to act
    this._viewOffset = 0
    this._committeeViewOffset = 0
    this._inactivityViewRotated = false
    this._committeeInactivityViewRotated = false
    this._poolWasFullThisEpoch = false
    this._committeePoolWasFullThisEpoch = false
    // Vote pools for atomic view-change: targetView → Set<publicKey>.
    this._viewChangeVotes = new Map()
    this._committeeViewChangeVotes = new Map()
  }

  listen() {
    const server = new WebSocket.Server({ port: P2P_PORT })
    server.on('connection', (socket, request) => {
      const parsedUrl = new URL(request.url, `http://${request.headers.host}`)
      const port = parsedUrl.searchParams.get('port')
      const isFaulty = parsedUrl.searchParams.get('isFaulty')
      const isCommittee = parsedUrl.searchParams.get('isCommittee')
      const isCommitteeFlag = isCommittee === 'true'
      logger.log(`new connection from ${port} to ${P2P_PORT}`)
      this.connectSocket(socket, port, isFaulty === 'true', false, isCommitteeFlag)
      this.messageHandler(socket, false, isCommitteeFlag)
    })
    this.connectToPeers()
    this.connectToCore(false)
    // Determine committee membership from COMMITTEE_SUBSET (not just COMMITTEE_PEERS).
    // The lowest-indexed committee member has no lower-indexed peers so COMMITTEE_PEERS=[],
    // but it still needs to register with the core as a committee member so the core
    // includes it in committee block broadcasts.
    const currentNodeIndex = Number(P2P_PORT) - 5001
    const isCommitteeMember =
      COMMITTEE_SUBSET.length > 0 && COMMITTEE_SUBSET.includes(currentNodeIndex)
    if (isCommitteeMember) {
      this.connectToCore(true)
    }
    if (COMMITTEE_PEERS.length > 0) {
      this.connectToCommitteePeers()
    }

    setInterval(async () => {
      const rate = await this.blockchain.getRate(this.sockets.peers)
      const total = this.blockchain.getTotal()
      this.broadcastRateToCore(rate, total)
    }, TIMEOUTS.RATE_BROADCAST_INTERVAL_MS)
  }

  // eslint-disable-next-line max-params
  connectSocket(socket, port, isFaulty, isCore = false, isCommittee = false) {
    if (!isCore) {
      if (isCommittee) {
        this.sockets.committeePeers[port] = {
          socket,
          isFaulty
        }
      } else {
        this.sockets.peers[port] = {
          socket,
          isFaulty
        }
      }
      this.idaGossip.setPeerSockets({
        peers: this.sockets.peers,
        committeePeers: this.sockets.committeePeers
      })
    } else {
      if (isCommittee) {
        this.coreSocket.committeeCore = socket
      } else {
        this.coreSocket.core = socket
      }
      this.idaGossip.setCoreSocket({
        core: this.coreSocket.core,
        committeeCore: this.coreSocket.committeeCore
      })
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
            setTimeout(checkWebServer, retryInterval + TIMEOUTS.HEALTH_CHECK_RETRY_MS)
          })
      }

      checkWebServer()
    })
  }

  // connects to the peers passed in command line
  async connectToPeers() {
    await Promise.all(
      PEERS.map((peer) => this.waitForWebServer(peer.replace('ws', 'http').replace(':5', ':3')))
    )
    PEERS.forEach((peer) => {
      const connectPeer = () => {
        const socket = new WebSocket(
          `${peer}?port=${P2P_PORT}&isFaulty=${IS_FAULTY ? 'true' : 'false'}&subsetIndex=${SUBSET_INDEX}&httpPort=${process.env.HTTP_PORT}`
        )
        socket.on('error', (error) => {
          logger.error(`Failed to connect to peer. Retrying in 5s...`, error)
          setTimeout(connectPeer, TIMEOUTS.PEER_RECONNECT_DELAY_MS)
        })
        socket.on('open', () => {
          logger.log(`new connection from inside ${P2P_PORT} to ${peer.split(':')[2]}`)
          this.connectSocket(socket, peer.split(':')[2], false, false, false)
          this.messageHandler(socket, false, false)
        })
      }
      connectPeer()
    })
  }

  async connectToCommitteePeers() {
    await Promise.all(
      COMMITTEE_PEERS.map((committeePeer) =>
        this.waitForWebServer(committeePeer.replace('ws', 'http').replace(':5', ':3'))
      )
    )
    COMMITTEE_PEERS.forEach((committeePeer) => {
      const connectCommitteePeer = () => {
        const socket = new WebSocket(
          `${committeePeer}?port=${P2P_PORT}&isFaulty=${IS_FAULTY ? 'true' : 'false'}&isCommittee=true&subsetIndex=${SUBSET_INDEX}&httpPort=${process.env.HTTP_PORT}`
        )
        socket.on('error', (error) => {
          logger.error(`Failed to connect to committee peer. Retrying in 5s...`, error)
          setTimeout(connectCommitteePeer, TIMEOUTS.PEER_RECONNECT_DELAY_MS)
        })
        socket.on('open', () => {
          logger.log(`new connection from inside ${P2P_PORT} to ${committeePeer.split(':')[2]}`)
          this.connectSocket(socket, committeePeer.split(':')[2], false, false, true)
          this.messageHandler(socket, false, true)
        })
      }
      connectCommitteePeer()
    })
  }

  async connectToCore(isCommittee = false) {
    const connectCore = () => {
      const socket = new WebSocket(
        `${CORE}?port=${P2P_PORT}&isCommittee=${isCommittee ? 'true' : 'false'}&subsetIndex=${SUBSET_INDEX}&httpPort=${process.env.HTTP_PORT}`
      )
      socket.on('error', (error) => {
        logger.error(`Failed to connect to core. Retrying in 5s...`, error)
        setTimeout(connectCore, TIMEOUTS.PEER_RECONNECT_DELAY_MS)
      })
      socket.on('open', () => {
        logger.log(`new connection from inside ${P2P_PORT} to ${CORE.split(':')[2]}`)
        this.connectSocket(socket, CORE.split(':')[2], false, true, isCommittee)
        this.messageHandler(socket, true, isCommittee)
      })
    }
    connectCore()
  }

  // broadcasts transactions
  broadcastTransaction(senderPort, transaction, isCommittee = false) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.transaction,
        port: P2P_PORT,
        transaction: transaction,
        isFaulty: IS_FAULTY
      },
      socketsKey: isCommittee ? 'committeePeers' : 'peers',
      senderPort
    })
  }

  // broadcasts preprepare
  // eslint-disable-next-line max-params
  broadcastPrePrepare(
    senderPort,
    block,
    blocksCount,
    previousBlock = undefined,
    isCommittee = false,
    viewOffset = 0
  ) {
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
      socketsKey: isCommittee ? 'committeePeers' : 'peers',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcast prepare
  broadcastPrepare(senderPort, prepare, isCommittee = false) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.prepare,
        port: P2P_PORT,
        prepare
      },
      chunkKey: 'prepare',
      socketsKey: isCommittee ? 'committeePeers' : 'peers',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcasts commit
  broadcastCommit(senderPort, commit, isCommittee = false) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.commit,
        port: P2P_PORT,
        commit
      },
      chunkKey: 'commit',
      socketsKey: isCommittee ? 'committeePeers' : 'peers',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcasts round change
  broadcastRoundChange(senderPort, message, isCommittee = false) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.round_change,
        port: P2P_PORT,
        message,
        isCommittee
      },
      chunkKey: 'message',
      socketsKey: isCommittee ? 'committeePeers' : 'peers',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcasts a view-change vote — sent by non-proposer nodes on inactivity;
  // _viewOffset only advances once MIN_APPROVALS votes are collected so all
  // shard nodes rotate atomically to the same view.
  broadcastViewChange(senderPort, viewChange, isCommittee = false) {
    this.idaGossip.sendToShardPeers({
      message: {
        type: MESSAGE_TYPE.view_change,
        port: P2P_PORT,
        viewChange,
        isCommittee
      },
      chunkKey: 'viewChange',
      socketsKey: isCommittee ? 'committeePeers' : 'peers',
      senderPort,
      consensusMessage: true
    })
  }

  // broadcasts block to core
  broadcastBlockToCore(block, isCommittee = false) {
    this.idaGossip.sendToCore({
      message: {
        type: MESSAGE_TYPE.block_to_core,
        block,
        subsetIndex: SUBSET_INDEX
      },
      chunkKey: 'block',
      socketsKey: isCommittee ? 'committeeCore' : 'core'
    })
  }

  // broadcasts rate to core
  broadcastRateToCore(rate, total) {
    this.idaGossip.sendToCore({
      message: {
        type: MESSAGE_TYPE.rate_to_core,
        port: P2P_PORT,
        rate,
        total
      }
    })
  }

  messageHandler(socket, isCore = false, isCommittee = false) {
    socket.on('message', (message) => {
      try {
        if (Buffer.isBuffer(message)) {
          message = message.toString()
        }
        const data = JSON.parse(message)
        const processedData = this.idaGossip.handleChunk(data)
        if (processedData) {
          this.parseMessage(processedData, isCore, isCommittee)
        }
      } catch (error) {
        logger.error('Failed to parse message:', error.message)
      }
    })
  }

  _scheduleTimeoutBlockCreation(isCommittee) {
    // Don't reset the timer when the pool is already full — it is being used to
    // detect a silent/faulty proposer. Resetting it on every incoming transaction
    // would prevent it from ever firing under sustained load.
    const poolFull = this.transactionPool.poolFull(isCommittee)
    if (!poolFull) {
      clearTimeout(this._blockCreationTimeout)
    } else if (this._blockCreationTimeout) {
      return // already counting down — keep the existing deadline
    }
    this._blockCreationTimeout = setTimeout(() => {
      // Null the reference immediately so _scheduleTimeoutBlockCreation called from
      // within this callback knows no countdown is active and can schedule a new one.
      this._blockCreationTimeout = null
      const now = new Date()
      const lastTransactionTime = isCommittee
        ? this.lastCommitteeTransactionCreatedAt
        : this.lastTransactionCreatedAt
      const unassignedCount = isCommittee
        ? this.transactionPool.committeeTransactions.unassigned.length
        : this.transactionPool.transactions.unassigned.length
      const currentViewOffset = isCommittee ? this._committeeViewOffset : this._viewOffset
      const proposerObject = this.blockchain.getProposer(undefined, isCommittee, currentViewOffset)
      const isProposer = proposerObject.proposer === this.wallet.getPublicKey()

      const isInactive =
        lastTransactionTime &&
        now - lastTransactionTime >= TIMEOUTS.TRANSACTION_INACTIVITY_THRESHOLD_MS

      // ============================================================================
      // TRANSACTION REDISTRIBUTION MECHANISM (TIMEOUT-BASED WORKAROUND)
      // ============================================================================
      // PROBLEM: In PBFT, only the designated proposer can create blocks. However,
      // load balancers distribute client requests across all nodes. If the proposer
      // doesn't receive enough transactions directly, no blocks are created despite
      // high overall transaction volume across other nodes.
      //
      // SOLUTION: Non-proposer nodes with >= 50 transactions periodically re-broadcast
      // them to the network every 10 seconds, increasing the chance the proposer receives them.
      //
      // RAPIDCHAIN-SPECIFIC: Handles both committee and regular transactions separately.
      //
      // WHY THIS CAUSES ISSUES - CRITICAL TRADE-OFFS:
      // ============================================================================
      // 1. NETWORK OVERHEAD
      //    - Same transactions broadcast multiple times by different nodes
      //    - Bandwidth waste proportional to: (number of non-proposer nodes) * (tx count)
      //    - In 4-node network: 3 nodes might re-broadcast 50 txs each = 150 duplicate messages
      //
      // 2. CPU OVERHEAD
      //    - Each node must re-process duplicate transactions
      //    - Though filtered by transactionExists() check, still CPU cycles wasted
      //    - Can impact overall throughput under high load
      //
      // 3. BREAKS PURE DECENTRALIZATION
      //    - Creates implicit dependency on proposer role availability
      //    - If proposer is down/slow, entire network stalls
      //    - Original PBFT design assumes all nodes receive all transactions
      //
      // 4. TIMING ISSUES & RACE CONDITIONS
      //    - Proposer rotation happens every minute based on block hash
      //    - Might rotate proposer before redistributed txs reach old proposer
      //    - Multiple non-proposers might redistribute simultaneously → message storms
      //
      // 5. DOES NOT SCALE
      //    - With more nodes, more duplicates broadcast
      //    - Network bandwidth grows O(n²) instead of O(n)
      //    - Better solutions needed for production: consistent hashing, mempool sync, etc.
      //
      // BETTER ALTERNATIVES (NOT IMPLEMENTED HERE):
      // ============================================================================
      // A) CONSISTENT HASHING: Route client requests to proposer based on hash
      // B) MEMPOOL SYNC: Explicit transaction pool synchronization protocol
      // C) MULTIPLE PROPOSERS: Allow concurrent block proposals (requires consensus changes)
      // D) GOSSIP PROTOCOL: Structured propagation ensuring all nodes receive all txs
      //
      // This timeout-based approach is a WORKAROUND for load balancing issues, not
      // a proper architectural solution. It sacrifices efficiency for availability.
      // ============================================================================
      if (!isProposer && unassignedCount >= TRANSACTION_THRESHOLD / 2) {
        const _seenSize = isCommittee
          ? this.transactionPool.committeeTransactionIds.size
          : this.transactionPool.transactionIds.size
        logger.log(
          P2P_PORT,
          `REDISTRIBUTE shard=${SUBSET_INDEX} unassigned=${unassignedCount}` +
            ` seenIndex=${_seenSize} isCommittee=${isCommittee}` +
            ` isProposer=${isProposer} isInactive=${isInactive}`
        )
        const txArray = isCommittee
          ? this.transactionPool.committeeTransactions.unassigned
          : this.transactionPool.transactions.unassigned
        const txToRedistribute = txArray.slice(0, 50)
        txToRedistribute.forEach((tx) => {
          this.broadcastTransaction(P2P_PORT, tx, isCommittee)
        })
      }

      // Pool still full after timeout — proposer still silent.
      // Vote via broadcast so all shard nodes rotate atomically.
      // Map-level dedup prevents re-broadcasting a vote already cast this epoch.
      if (unassignedCount >= TRANSACTION_THRESHOLD) {
        if (!isProposer) {
          // Only non-proposers vote — the proposer should be creating blocks,
          // not voting to skip itself.
          const poolFullFlag = isCommittee
            ? '_committeePoolWasFullThisEpoch'
            : '_poolWasFullThisEpoch'
          const votesMap = isCommittee ? '_committeeViewChangeVotes' : '_viewChangeVotes'
          const currentView = isCommittee ? this._committeeViewOffset : this._viewOffset
          this[poolFullFlag] = true
          const targetView = currentView + 1
          if (!this[votesMap].has(targetView)) this[votesMap].set(targetView, new Set())
          if (!this[votesMap].get(targetView).has(this.wallet.getPublicKey())) {
            this[votesMap].get(targetView).add(this.wallet.getPublicKey())
            logger.log(P2P_PORT, 'VIEW CHANGE VOTE (timeout) — proposing view', targetView)
            this.broadcastViewChange(
              P2P_PORT,
              { targetView, publicKey: this.wallet.getPublicKey() },
              isCommittee
            )
          }
        }
        this.initiateBlockCreation(P2P_PORT, false, isCommittee)
      } else if (isInactive && unassignedCount > 0) {
        const rotatedFlag = isCommittee
          ? '_committeeInactivityViewRotated'
          : '_inactivityViewRotated'
        const poolFullFlag = isCommittee
          ? '_committeePoolWasFullThisEpoch'
          : '_poolWasFullThisEpoch'
        const votesMap = isCommittee ? this._committeeViewChangeVotes : this._viewChangeVotes
        const currentOffset = isCommittee ? this._committeeViewOffset : this._viewOffset
        if (!isProposer && !this[poolFullFlag] && !this[rotatedFlag]) {
          this[rotatedFlag] = true
          const targetView = currentOffset + 1
          if (!votesMap.has(targetView)) votesMap.set(targetView, new Set())
          votesMap.get(targetView).add(this.wallet.getPublicKey())
          logger.log(P2P_PORT, 'VIEW CHANGE VOTE — proposing view', targetView)
          this.broadcastViewChange(
            P2P_PORT,
            { targetView, publicKey: this.wallet.getPublicKey() },
            isCommittee
          )
        }
        // Sub-threshold drain: if this node is the proposer and ready, create a
        // block with whatever TX are available.
        if (isProposer && this._canProposeBlock(isCommittee)) {
          this._createAndBroadcastBlock(P2P_PORT, currentOffset, isCommittee)
        } else {
          // Keep trying with the current offset while waiting for quorum
          this.initiateBlockCreation(P2P_PORT, false, isCommittee)
        }
      }
    }, TIMEOUTS.BLOCK_CREATION_TIMEOUT_MS)
  }

  _canProposeBlock(isCommittee) {
    const blocksPool = isCommittee ? this.blockPool.committeeBlocks : this.blockPool.blocks
    const lastUnpersistedBlock = blocksPool[blocksPool.length - 1]
    const inflightBlocks = this.transactionPool.getInflightBlocks(undefined, isCommittee)

    if (inflightBlocks.length > 1) {
      return this.preparePool.isBlockPrepared(lastUnpersistedBlock, this.wallet, isCommittee)
    }
    return true
  }

  _createAndBroadcastBlock(port, isCommittee, viewOffset = 0) {
    const blocksPool = isCommittee ? this.blockPool.committeeBlocks : this.blockPool.blocks
    const lastUnpersistedBlock = blocksPool[blocksPool.length - 1]
    const inflightBlocks = this.transactionPool.getInflightBlocks(undefined, isCommittee)
    const threshold = isCommittee ? BLOCK_THRESHOLD : TRANSACTION_THRESHOLD
    const unassignedTransactions = isCommittee
      ? this.transactionPool.committeeTransactions.unassigned
      : this.transactionPool.transactions.unassigned

    // Defence-in-depth: purge any already-committed TXs that landed back in
    // unassigned via the safety-reassignment timer or releaseAssigned().
    const _committedSet = isCommittee
      ? this.transactionPool.committedCommitteeTxIds
      : this.transactionPool.committedTxIds
    if (_committedSet.size > 0) {
      const pool = isCommittee
        ? this.transactionPool.committeeTransactions
        : this.transactionPool.transactions
      pool.unassigned = pool.unassigned.filter((tx) => !_committedSet.has(tx.id))
    }

    const previousBlock = inflightBlocks.length > 1 ? lastUnpersistedBlock : undefined
    const transactionsBatch = unassignedTransactions.splice(0, threshold)
    const block = this.blockchain.createBlock(
      transactionsBatch,
      this.wallet,
      previousBlock,
      isCommittee
    )

    logger.log(P2P_PORT, 'CREATED BLOCK', block.hash, 'txCount:', block.data.length)

    this.transactionPool.assignTransactions(block, isCommittee)
    const blocksCount = isCommittee
      ? this.blockchain.committeeChain.length
      : this.blockchain.chain[SUBSET_INDEX].length

    // Proposer adds block to its own pool (needed for addUpdatedBlock look-up on commit)
    this.blockPool.addBlock(block, isCommittee)
    // Standard PBFT: the proposer implicitly casts a prepare for its own block.
    // Broadcast it immediately so non-proposer nodes reach MIN_APPROVALS even when
    // one shard peer is faulty (only 3 non-faulty nodes, all three must vote).
    const ownPrepare = this.preparePool.prepare(block, this.wallet, isCommittee)
    this.broadcastPrePrepare(port, block, blocksCount, previousBlock, isCommittee, viewOffset)
    this.broadcastPrepare(port, ownPrepare, isCommittee)
  }

  initiateBlockCreation(port, _triggeredByTransaction = true, isCommittee = false) {
    // Only update inactivity clock for real incoming transactions.
    // Timeout-path calls (_triggeredByTransaction=false) must not reset the
    // clock or isInactive will always be false during active JMeter load.
    if (isCommittee) {
      if (_triggeredByTransaction) this.lastCommitteeTransactionCreatedAt = new Date()
    } else {
      if (_triggeredByTransaction) this.lastTransactionCreatedAt = new Date()
    }
    const thresholdReached = this.transactionPool.poolFull(isCommittee)

    if (IS_FAULTY || !thresholdReached) {
      if (!IS_FAULTY && !thresholdReached) {
        const unassignedCount = isCommittee
          ? this.transactionPool.committeeTransactions.unassigned.length
          : this.transactionPool.transactions.unassigned.length
        logger.debug(
          P2P_PORT,
          'Transaction Threshold NOT REACHED, TOTAL UNASSIGNED NOW:',
          unassignedCount
        )
      }
      this._scheduleTimeoutBlockCreation(isCommittee)
      return
    }

    const unassignedCount = isCommittee
      ? this.transactionPool.committeeTransactions.unassigned.length
      : this.transactionPool.transactions.unassigned.length
    logger.log(P2P_PORT, 'THRESHOLD REACHED, TOTAL NOW:', unassignedCount)

    const viewOffset = isCommittee ? this._committeeViewOffset : this._viewOffset
    const readyToPropose = this._canProposeBlock(isCommittee)
    const proposerObject = this.blockchain.getProposer(undefined, isCommittee, viewOffset)
    const inflightBlocks = this.transactionPool.getInflightBlocks(undefined, isCommittee)
    const isProposer = proposerObject.proposer === this.wallet.getPublicKey()
    const canCreateBlock = isProposer && readyToPropose && inflightBlocks.length <= 4

    logger.log(
      P2P_PORT,
      'PROPOSE BLOCK CONDITION',
      'proposer index:',
      proposerObject.proposerIndex,
      NODES_SUBSET,
      'is proposer:',
      isProposer,
      'is ready to propose:',
      readyToPropose,
      'inflight blocks:',
      inflightBlocks
    )

    if (canCreateBlock) {
      logger.log(P2P_PORT, 'PROPOSING BLOCK')
      // We are the proposer — clear any pending view-change countdown
      clearTimeout(this._blockCreationTimeout)
      this._blockCreationTimeout = null
      this._createAndBroadcastBlock(port, isCommittee, viewOffset)
    } else {
      const unassignedCount = isCommittee
        ? this.transactionPool.committeeTransactions.unassigned.length
        : this.transactionPool.transactions.unassigned.length
      logger.log(
        P2P_PORT,
        'NOT PROPOSER, waiting for proposer or view change. TOTAL UNASSIGNED:',
        unassignedCount
      )
      // Pool is full on a real incoming transaction and the elected proposer is not
      // us — likely faulty/silent. Broadcast a vote immediately.
      // Guard: _triggeredByTransaction=false means we were called from a view-change
      // quorum or timeout handler; the new proposer just got elected and deserves a
      // grace period before we vote to skip them.
      // Note: _inactivityViewRotated intentionally NOT set here so it remains
      // available as a fallback for sub-threshold drain rounds with faulty proposers.
      const poolFullFlag = isCommittee ? '_committeePoolWasFullThisEpoch' : '_poolWasFullThisEpoch'
      const rotatedFlag = isCommittee ? '_committeeInactivityViewRotated' : '_inactivityViewRotated'
      // Check if the elected proposer is already a known-faulty peer.
      // Vote to skip immediately rather than waiting 10 s for the timeout.
      const proposerPort =
        proposerObject.proposerIndex !== null ? String(5001 + proposerObject.proposerIndex) : null
      const proposerKnownFaulty =
        proposerPort !== null && this.sockets.peers[proposerPort]?.isFaulty === true
      if (
        !isProposer &&
        thresholdReached &&
        proposerKnownFaulty &&
        !this[poolFullFlag] &&
        !this[rotatedFlag]
      ) {
        const votesMap = isCommittee ? '_committeeViewChangeVotes' : '_viewChangeVotes'
        this[poolFullFlag] = true
        const targetView = viewOffset + 1
        if (!this[votesMap].has(targetView)) this[votesMap].set(targetView, new Set())
        this[votesMap].get(targetView).add(this.wallet.getPublicKey())
        logger.log(
          P2P_PORT,
          'VIEW CHANGE VOTE (known-faulty proposer) — proposing view',
          targetView
        )
        this.broadcastViewChange(
          port,
          { targetView, publicKey: this.wallet.getPublicKey() },
          isCommittee
        )
      } else if (
        _triggeredByTransaction &&
        !isProposer &&
        !this[poolFullFlag] &&
        !this[rotatedFlag]
      ) {
        this[poolFullFlag] = true
        const targetView = viewOffset + 1
        const votesMap = isCommittee ? '_committeeViewChangeVotes' : '_viewChangeVotes'
        if (!this[votesMap].has(targetView)) this[votesMap].set(targetView, new Set())
        this[votesMap].get(targetView).add(this.wallet.getPublicKey())
        logger.log(P2P_PORT, 'VIEW CHANGE VOTE (pool full) — proposing view', targetView)
        this.broadcastViewChange(
          port,
          { targetView, publicKey: this.wallet.getPublicKey() },
          isCommittee
        )
      }
    }

    this._scheduleTimeoutBlockCreation(isCommittee)
  }

  _handleTransaction(data, isCommittee) {
    const activeValidators = isCommittee ? this.committeeValidators : this.validators
    const _exists = this.transactionPool.transactionExists(data.transaction, isCommittee)
    if (
      !_exists &&
      this.transactionPool.verifyTransaction(data.transaction) &&
      activeValidators.isValidValidator(data.transaction.from)
    ) {
      if (data.port && data.port in this.sockets.peers) {
        this.sockets.peers[data.port].isFaulty = data.isFaulty
      }
      this.transactionPool.addTransaction(data.transaction, isCommittee)
      logger.debug(
        P2P_PORT,
        'TRANSACTION ADDED, TOTAL NOW:',
        isCommittee
          ? this.transactionPool.committeeTransactions.unassigned.length
          : this.transactionPool.transactions.unassigned.length
      )
      this.broadcastTransaction(data.port, data.transaction, isCommittee)
      this.initiateBlockCreation(data.port, false, isCommittee)
    } else if (_exists) {
      logger.debug(
        P2P_PORT,
        `TX_DUPLICATE_REJECTED id=${data.transaction.id?.slice(0, 8)} shard=${SUBSET_INDEX}` +
          ` seenIndex=${isCommittee ? this.transactionPool.committeeTransactionIds.size : this.transactionPool.transactionIds.size}`
      )
    }
  }

  _handlePrePrepare(data, isCommittee) {
    const { block, previousBlock, blocksCount, viewOffset = 0 } = data.data
    // Sync view offset forward so we validate against the same proposer.
    if (!isCommittee && viewOffset > this._viewOffset) this._viewOffset = viewOffset
    if (isCommittee && viewOffset > this._committeeViewOffset)
      this._committeeViewOffset = viewOffset
    // Proposer is working — cancel the view-change countdown
    clearTimeout(this._blockCreationTimeout)
    this._blockCreationTimeout = null
    if (
      !this.blockPool.existingBlock(block, isCommittee) &&
      this.blockchain.isValidBlock(block, blocksCount, previousBlock, isCommittee, viewOffset)
    ) {
      this.blockPool.addBlock(block, isCommittee)
      this.transactionPool.assignTransactions(block, isCommittee)
      this.broadcastPrePrepare(data.port, block, blocksCount, previousBlock, isCommittee)

      if (block?.hash) {
        const prepare = this.preparePool.prepare(block, this.wallet, isCommittee)
        this.broadcastPrepare(data.port, prepare, isCommittee)
      }
    }
  }

  _handlePrepare(data, isCommittee) {
    const activeValidators = isCommittee ? this.committeeValidators : this.validators
    if (
      !this.preparePool.existingPrepare(data.prepare, isCommittee) &&
      this.preparePool.isValidPrepare(data.prepare, this.wallet) &&
      activeValidators.isValidValidator(data.prepare.publicKey)
    ) {
      this.preparePool.addPrepare(data.prepare, isCommittee)
      this.broadcastPrepare(data.port, data.prepare, isCommittee)

      const prepareList = isCommittee
        ? this.preparePool.committeeList[data.prepare.blockHash]
        : this.preparePool.list[data.prepare.blockHash]

      if (prepareList.length >= MIN_APPROVALS) {
        const commit = this.commitPool.commit(data.prepare, this.wallet, isCommittee)
        this.broadcastCommit(data.port, commit, isCommittee)
      }
    }
  }

  async _handleCommit(data, isCommittee) {
    const activeValidators = isCommittee ? this.committeeValidators : this.validators
    if (
      !this.commitPool.existingCommit(data.commit, isCommittee) &&
      this.commitPool.isValidCommit(data.commit) &&
      activeValidators.isValidValidator(data.commit.publicKey)
    ) {
      this.commitPool.addCommit(data.commit, isCommittee)
      this.broadcastCommit(data.port, data.commit, isCommittee)

      const commitList = this.commitPool.getList(data.commit.blockHash, isCommittee)
      const blockNotInChain = !this.blockchain.existingBlock(data.commit.blockHash, isCommittee)

      if (commitList.length >= MIN_APPROVALS && blockNotInChain) {
        const result = await this.blockchain.addUpdatedBlock(
          data.commit.blockHash,
          this.blockPool,
          this.preparePool,
          this.commitPool,
          isCommittee
        )

        if (result !== false) {
          // Block committed — cancel view-change countdown and reset offset for next round
          clearTimeout(this._blockCreationTimeout)
          this._blockCreationTimeout = null
          if (isCommittee) {
            this._committeeViewOffset = 0
            this._committeeInactivityViewRotated = false
            this._committeePoolWasFullThisEpoch = false
            this._committeeViewChangeVotes = new Map()
          } else {
            this._viewOffset = 0
            this._inactivityViewRotated = false
            this._poolWasFullThisEpoch = false
            this._viewChangeVotes = new Map()
          }
          this.broadcastBlockToCore(result, isCommittee)
          const chainLength = isCommittee
            ? this.blockchain.committeeChain.length
            : this.blockchain.chain[SUBSET_INDEX].length

          logger.log(
            P2P_PORT,
            'NEW BLOCK ADDED TO BLOCK CHAIN, TOTAL NOW:',
            chainLength,
            data.commit.blockHash
          )

          const latestBlock = isCommittee
            ? this.blockchain.committeeChain[this.blockchain.committeeChain.length - 1]
            : this.blockchain.chain[SUBSET_INDEX][this.blockchain.chain[SUBSET_INDEX].length - 1]

          const message = this.messagePool.createMessage(latestBlock, this.wallet)
          // Immediately clear pool and start next block — don't wait for round-change quorum.
          // The PBFT commit phase already guarantees 2f+1 agreement — all honest nodes that
          // reach here have already committed. Clearing immediately eliminates one full P2P
          // gossip round-trip of dead time between every consecutive block.
          this.transactionPool.clear(data.commit.blockHash, result.data, isCommittee)
          const _pendingCount = isCommittee
            ? this.transactionPool.committeeTransactions.unassigned.length
            : this.transactionPool.transactions.unassigned.length
          const _seenSize = isCommittee
            ? this.transactionPool.committeeTransactionIds.size
            : this.transactionPool.transactionIds.size
          logger.log(
            P2P_PORT,
            `BLOCK COMMITTED shard=${SUBSET_INDEX} block=#${data.commit.blockHash.slice(0, 8)}` +
              ` txInBlock=${result.data.length} pendingAfter=${_pendingCount}` +
              ` seenIndex=${_seenSize} chainLen=${chainLength}` +
              ` isCommittee=${isCommittee}`
          )
          if (_pendingCount > 0) {
            this.initiateBlockCreation(P2P_PORT, false, isCommittee)
          }
          this.broadcastRoundChange(data.port, message, isCommittee)
        } else {
          const chainLength = isCommittee
            ? this.blockchain.committeeChain.length
            : this.blockchain.chain[SUBSET_INDEX].length

          logger.error(
            P2P_PORT,
            'NEW BLOCK FAILED TO ADD TO BLOCK CHAIN, TOTAL STILL:',
            chainLength
          )
        }

        if (!isCommittee) {
          const rate = await this.blockchain.getRate(this.sockets.peers)
          const stats = {
            total: this.blockchain.getTotal(),
            rate,
            unassignedTransactions: this.transactionPool.transactions.unassigned.length
          }
          logger.log(P2P_PORT, `P2P STATS FOR #${SUBSET_INDEX}:`, JSON.stringify(stats))
        }
      }
    }
  }

  _handleViewChange(data, isCommittee) {
    const activeValidators = isCommittee ? this.committeeValidators : this.validators
    const { targetView, publicKey } = data.viewChange
    if (!activeValidators.isValidValidator(publicKey)) return
    const votesMap = isCommittee ? this._committeeViewChangeVotes : this._viewChangeVotes
    if (!votesMap.has(targetView)) votesMap.set(targetView, new Set())
    const votes = votesMap.get(targetView)
    if (votes.has(publicKey)) return // deduplicate
    votes.add(publicKey)
    // Relay so all shard peers receive this vote
    this.broadcastViewChange(data.port, data.viewChange, isCommittee)
    // Quorum reached and this view is ahead of where we are — rotate atomically
    const currentOffset = isCommittee ? this._committeeViewOffset : this._viewOffset
    if (votes.size >= MIN_APPROVALS && targetView > currentOffset) {
      if (isCommittee) this._committeeViewOffset = targetView
      else this._viewOffset = targetView
      // Reset both epoch flags so initiateBlockCreation (called immediately below)
      // can fire another vote right away if the NEW proposer at this view is also
      // faulty — eliminates the 10 s timeout wait for consecutive faulty proposers.
      const poolFullFlag = isCommittee ? '_committeePoolWasFullThisEpoch' : '_poolWasFullThisEpoch'
      const rotatedFlag = isCommittee ? '_committeeInactivityViewRotated' : '_inactivityViewRotated'
      this[poolFullFlag] = false
      this[rotatedFlag] = false
      // Return all TX that are assigned to the abandoned block back to the
      // unassigned pool immediately — new proposer can pick them up at once
      // instead of waiting up to 30 s for the safety-reassignment timers.
      this.transactionPool.releaseAssigned(isCommittee)
      logger.log(P2P_PORT, 'VIEW CHANGE (quorum) — rotating to view', targetView)
      this.initiateBlockCreation(P2P_PORT, false, isCommittee)
    }
  }

  _handleRoundChange(data, isCommittee) {
    const activeValidators = isCommittee ? this.committeeValidators : this.validators
    if (
      !this.messagePool.existingMessage(data.message, isCommittee) &&
      this.messagePool.isValidMessage(data.message) &&
      activeValidators.isValidValidator(data.message.publicKey)
    ) {
      this.messagePool.addMessage(data.message, isCommittee)
      this.broadcastRoundChange(data.port, data.message, isCommittee)

      const messageList = isCommittee
        ? this.messagePool.committeeList[data.message.blockHash]
        : this.messagePool.list[data.message.blockHash]

      if (messageList && messageList.length >= MIN_APPROVALS) {
        const transactionList = isCommittee
          ? this.transactionPool.committeeTransactions[data.message.blockHash]
          : this.transactionPool.transactions[data.message.blockHash]

        logger.log(P2P_PORT, 'TRANSACTION POOL TO BE CLEARED, TOTAL NOW:', transactionList?.length)
        this.transactionPool.clear(data.message.blockHash, data.message.data, isCommittee)
        // Re-arm block creation if there are still unassigned transactions.
        // Without this, the pool stalls after JMeter stops because no new
        // TRANSACTION_RECEIVED events arrive to call _scheduleTimeoutBlockCreation.
        const remainingUnassigned = isCommittee
          ? this.transactionPool.committeeTransactions.unassigned.length
          : this.transactionPool.transactions.unassigned.length
        if (remainingUnassigned > 0) {
          this.initiateBlockCreation(P2P_PORT, false, isCommittee)
        }
      }
    }
  }

  async _handleBlockFromCore(data, isCore, isCommittee) {
    const blockNotInChain = !this.blockchain.existingBlock(data.block.hash, data.subsetIndex)
    const isDifferentShard = data.subsetIndex !== SUBSET_INDEX

    if (blockNotInChain && isDifferentShard && isCore === true) {
      if (!isCommittee) {
        this.blockchain.addBlock(data.block, data.subsetIndex)
        const rate = await this.blockchain.getRate(this.sockets.peers)
        const stats = { total: this.blockchain.getTotal(), rate }
        logger.log(P2P_PORT, `P2P STATS FOR #${SUBSET_INDEX}:`, JSON.stringify(stats))
      } else {
        const transaction = this.wallet.createTransaction({
          data: data.block.data,
          subsetIndex: data.subsetIndex
        })

        const activeValidators = isCommittee ? this.committeeValidators : this.validators
        if (
          !this.transactionPool.transactionExists(transaction, isCommittee) &&
          this.transactionPool.verifyTransaction(transaction) &&
          activeValidators.isValidValidator(transaction.from)
        ) {
          this.transactionPool.addTransaction(transaction, isCommittee)
          logger.debug(
            P2P_PORT,
            'COMMITTEE TRANSACTION ADDED, TOTAL NOW:',
            this.transactionPool.committeeTransactions.unassigned.length
          )
          this.broadcastTransaction(data.port, transaction, isCommittee)
          this.initiateBlockCreation(data.port, true, isCommittee)
        }
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

  async parseMessage(data, isCore, isCommittee = false) {
    logger.debug(P2P_PORT, 'RECEIVED', data.type, data.port)

    if (IS_FAULTY && ![MESSAGE_TYPE.transaction].includes(data.type)) {
      return
    }

    switch (data.type) {
      case MESSAGE_TYPE.transaction:
        this._handleTransaction(data, isCommittee)
        break
      case MESSAGE_TYPE.pre_prepare:
        this._handlePrePrepare(data, isCommittee)
        break
      case MESSAGE_TYPE.prepare:
        await this._handlePrepare(data, isCommittee)
        break
      case MESSAGE_TYPE.commit:
        await this._handleCommit(data, isCommittee)
        break
      case MESSAGE_TYPE.round_change:
        this._handleRoundChange(data, isCommittee)
        break
      case MESSAGE_TYPE.view_change:
        this._handleViewChange(data, isCommittee)
        break
      case MESSAGE_TYPE.block_from_core:
        await this._handleBlockFromCore(data, isCore, isCommittee)
        break
      case MESSAGE_TYPE.config_from_core:
        this._handleConfigFromCore(data, isCore)
        break
    }
  }
}

module.exports = P2pserver
