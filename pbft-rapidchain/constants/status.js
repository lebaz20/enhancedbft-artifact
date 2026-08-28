/* eslint-disable camelcase */
const SHARD_STATUS = {
  normal: 'NORMAL',
  under_utilized: 'UNDER-UTILIZED',
  over_utilized: 'OVER-UTILIZED',
  faulty: 'FAULTY',
  // WARMING: below quorum but no block has ever been committed on this shard.
  // Distinguishes "mesh still forming during startup" from "shard lost quorum
  // after previously producing blocks" (FAULTY). Stabilizer treats WARMING as
  // not-yet-ready; coreserver leaves warming shards alone (no redirect target,
  // no traffic redirected onto them).
  warming: 'WARMING'
}

module.exports = {
  SHARD_STATUS
}
/* eslint-enable camelcase */
