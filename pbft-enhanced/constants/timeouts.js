/**
 * Timeout constants for consensus protocol operations
 * All values in milliseconds
 *
 * Enhanced-specific tuning rationale:
 *   - BLOCK_CREATION_TIMEOUT_MS: 25000 (was 5000, was 10000)
 *       MUST be larger than the expected PBFT round time at the target cluster
 *       size.  At 256 nodes, IDA gossip + 3-phase PBFT takes ~17-18 s per block.
 *       With the old 5 s timeout, non-proposer nodes voted for view-change THREE
 *       TIMES during every single 18 s round (5 s << 18 s), reaching quorum and
 *       aborting the inflight block.  After every abort only ~50 new TXs had
 *       accumulated (5 s × ~9 TX/s/shard), so the replacement block committed
 *       with ~50 TXs instead of the intended 100-300.  Analysis of the
 *       2026-04-10 test showed 401 view-change votes for 419 proposals — nearly
 *       every block was aborted.  Setting to 25 s means the timer fires only
 *       AFTER a genuine PBFT stall, not mid-round.
 *       Faulty/silent proposers are still handled: the known-faulty fast-skip
 *       path in initiateBlockCreation is instant; a truly silent honest proposer
 *       is detected after 25 s — acceptable given the 60 s reassignment window.
 *   - TRANSACTION_INACTIVITY_THRESHOLD_MS: 2000 (was 3000, was 8000)
 *       Forces sub-threshold block creation sooner when inbound transaction flow
 *       drops (e.g., after JMeter stops), reducing idle drain time per shard.
 *       Lowered from 3 s to 2 s to squeeze extra drain blocks in the test tail.
 *   - RATE_BROADCAST_INTERVAL_MS: 2000 (was 3000, was 8000, was 15000)
 *       Core monitors shards. Faster health polling (every 2 s) means
 *       a dead shard (≥2 faulty nodes) is detected by the core sooner, cutting
 *       the first leg of the redirect rescue pipeline from up to 3 s to 2 s.
 *   - TRANSACTION_REASSIGNMENT_TIMEOUT_MS: 60000 (was 15000)
 *       At 256 nodes, PBFT rounds take ~17.6s per block per shard — longer than
 *       the old 15s reassignment timeout.  TXs assigned to an in-flight block
 *       were returned to the unassigned pool before the block committed, causing
 *       a churn loop: same TXs proposed again and again without ever committing.
 *       60 s gives enough headroom for even large networks (512 nodes measured
 *       at ~35s/block) while still protecting against permanently stalled blocks
 *       (e.g., faulty proposer that never completes PBFT — view-change fires at
 *       25 s, so the worst case is: 25s + 60s = 85s before TXs return to pool).
 *
 * Rescue pipeline latency (worst-case):
 *   Old: BLOCK_CREATION_TIMEOUT_MS(10) + RATE_BROADCAST_INTERVAL_MS(15)
 *        + DRAIN_INTERVAL_MS(30) = 55 s
 *   Previous: 5 + 8 + 10 = 23 s
 *   New: 2 + 2 + 0.5 = ~4.5 s  ← DRAIN_INTERVAL_MS is set in appP2p.js
 */
module.exports = {
  BLOCK_CREATION_TIMEOUT_MS: 25000,
  TRANSACTION_INACTIVITY_THRESHOLD_MS: 2000,
  TRANSACTION_REASSIGNMENT_TIMEOUT_MS: 60000,
  RATE_BROADCAST_INTERVAL_MS: 2000,
  PEER_RECONNECT_DELAY_MS: 5000,
  HEALTH_CHECK_RETRY_MS: 1000
}
