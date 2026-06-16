/**
 * Timeout constants for consensus protocol operations
 * All values in milliseconds
 *
 * Aligned with Enhanced tuning rationale:
 *   - BLOCK_CREATION_TIMEOUT_MS: 25000 (was 5000)
 *       At 128+ nodes, IDA gossip + 3-phase PBFT takes ~17-18s per block.
 *       The old 5s timeout caused non-proposer nodes to vote for view-change
 *       multiple times during every round, aborting inflight blocks.
 *   - TRANSACTION_REASSIGNMENT_TIMEOUT_MS: 60000 (was 15000)
 *       At large networks, PBFT rounds take longer than 15s. TXs assigned to
 *       an inflight block were returned to unassigned before commit, causing
 *       duplicate proposals. 60s gives headroom for 512-node networks (~35s/block).
 */
module.exports = {
  BLOCK_CREATION_TIMEOUT_MS: 25000,
  TRANSACTION_INACTIVITY_THRESHOLD_MS: 2000,
  TRANSACTION_REASSIGNMENT_TIMEOUT_MS: 60000,
  RATE_BROADCAST_INTERVAL_MS: 2000,
  PEER_RECONNECT_DELAY_MS: 5000,
  HEALTH_CHECK_RETRY_MS: 1000
}
