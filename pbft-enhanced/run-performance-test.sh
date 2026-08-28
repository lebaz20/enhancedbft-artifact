#!/bin/bash

# Performance Test Script for PBFT-Enhanced
# This script starts the blockchain using start.sh, runs JMeter tests, and saves performance results

set -e

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a server.log
}

# Phase marker: journal-comparison.sh reads $PHASE_FILE from a background
# heartbeat loop to show "still on <phase> after Ns" every 30s. Safe no-op
# when PHASE_FILE is unset (i.e. when running this script standalone).
write_phase() {
    [ -n "${PHASE_FILE:-}" ] || return 0
    printf '%s\n' "enhanced: $*" > "${PHASE_FILE}" 2>/dev/null || true
}

# Diagnostic snapshot: dumped by the EXIT trap on non-zero exit so it's
# obvious which stage was wedged (which pods weren't Running, recent events,
# top processes, memory pressure).
diag_snapshot() {
    log "${YELLOW}════════ DIAG SNAPSHOT (enhanced: $*) ════════${NC}"
    log "--- phase file ---"
    [ -n "${PHASE_FILE:-}" ] && [ -s "$PHASE_FILE" ] && cat "$PHASE_FILE" | tee -a server.log || true
    log "--- pod status counts (blockchain domain) ---"
    kubectl get pods -l domain=blockchain --no-headers 2>&1 | awk '{print $3}' | sort | uniq -c | tee -a server.log || true
    log "--- non-Running pods (up to 30) ---"
    kubectl get pods -A --no-headers 2>&1 | grep -v -E 'Running|Completed' | head -30 | tee -a server.log || true
    log "--- kubectl events (last 20) ---"
    kubectl get events -A --sort-by=.lastTimestamp 2>&1 | tail -20 | tee -a server.log || true
    log "--- top 10 CPU / RSS ---"
    ps aux --sort=-%cpu 2>/dev/null | head -6 | tee -a server.log || true
    ps aux --sort=-rss  2>/dev/null | head -6 | tee -a server.log || true
    log "--- memory / load ---"
    free -h 2>/dev/null | tee -a server.log || true
    uptime 2>/dev/null | tee -a server.log || true
    log "--- kubectl port-forward count ---"
    ps -ef 2>/dev/null | grep -c '[k]ubectl port-forward' | tee -a server.log || true
    log "${YELLOW}════════ END DIAG SNAPSHOT ════════${NC}"
}

# ── Local-mode preset ────────────────────────────────────────────────────────
# Set LOCAL_MODE=1 to run on a laptop (Rancher Desktop / Docker Desktop k8s).
# Applies conservative defaults: tiny cluster, minimal JMeter load, reduced
# memory caps.  Explicit env vars set before invoking this script always win.
if [ "${LOCAL_MODE:-0}" = "1" ]; then
    : "${NUMBER_OF_NODES:=4}"
    : "${NUMBER_OF_NODES_PER_SHARD:=4}"
    : "${NUMBER_OF_FAULTY_NODES:=0}"
    : "${TRANSACTION_THRESHOLD:=20}"
    : "${CPU_LIMIT:=0.25}"
    : "${JMETER_THREADS:=3}"
    : "${JMETER_DURATION:=30}"
    : "${JMETER_THROUGHPUT:=600}"
    : "${STARTUP_BATCH_SIZE:=4}"
    : "${STARTUP_BATCH_WAIT_SEC:=3}"
    log "${YELLOW}LOCAL_MODE=1: laptop-friendly defaults applied (3 JMeter threads, 30s run, memory auto-scaled by NPS)${NC}"
    log "${YELLOW}  Override any variable before running to change individual settings.${NC}"
fi

# Configuration (use defaults from start.sh if not set)
export NUMBER_OF_NODES=${NUMBER_OF_NODES:-512}
# TRANSACTION_THRESHOLD: healthy-shard block size.
# Set by compare-performance.sh (which scales it adaptively for large networks).
# Falls back to 100 when run standalone.
export TRANSACTION_THRESHOLD=${TRANSACTION_THRESHOLD:-100}
# DRAIN_BATCH_SIZE: TXs forwarded per redirect drain cycle (every 500 ms).
# Matches TRANSACTION_THRESHOLD so each drain cycle contributes one block's worth
# of TXs to the healthy shard.  The larger POOL_CAPACITY (scaled with NUMBER_OF_NODES)
# ensures healthy shards can absorb this without 503-ing under redirect pressure.
export DRAIN_BATCH_SIZE=${DRAIN_BATCH_SIZE:-${TRANSACTION_THRESHOLD}}
export NUMBER_OF_FAULTY_NODES=${NUMBER_OF_FAULTY_NODES:-85}
export NUMBER_OF_NODES_PER_SHARD=${NUMBER_OF_NODES_PER_SHARD:-4}
export SHOULD_REDIRECT_FROM_FAULTY_NODES=${SHOULD_REDIRECT_FROM_FAULTY_NODES:-0}
export ENABLE_SHARD_MERGE=${ENABLE_SHARD_MERGE:-0}
export CPU_LIMIT=${CPU_LIMIT:-0.2}
# POD_MEMORY_MIB: overrides prepare-config.js default of 256 MiB per pod.
# Auto-set by NPS-aware block below when NPS >= 8; explicit env var always wins.
export POD_MEMORY_MIB=${POD_MEMORY_MIB:-}

# ── NPS-aware auto-tuning ─────────────────────────────────────────────────────
# PBFT message count is O(NPS²).  At NPS=4 the original parameters (200 mCPU,
# 256 MiB, threshold=100) work fine.  Each doubling of NPS roughly quadruples
# the per-round message load, so memory and threshold must scale accordingly.
#
# Scaling rules (only applied when VERTICAL_STUDY=1 or NPS >= 8):
#   Memory cap     : 256 × (NPS/4)^1.0   MiB  (linear — empirical: NPS=8 peak
#                    was 715/724 MiB; linear gives 512; we cap at 3584 MiB)
#                    NOTE: the sqrt formula used elsewhere underestimates badly
#                    above NPS=8.  Use ^1.0 here with a safety multiplier.
#   CPU cap        : 0.30 × sqrt(NPS/4)  vCPU (unchanged — CPU is not the
#                    binding constraint; the mesh is)
#   TRANSACTION_THRESHOLD: threshold ≈ (expected req/s per shard) × (round time)
#                    Round time at NPS=k ≈ 0.4 × (k/4)^1.5 seconds.
#                    With 200 threads / 4 shards = 50 req/s per shard:
#                    NPS=8  → ~1.1s → threshold ~55  → use 500 (generous headroom)
#                    NPS=16 → ~3.2s → threshold ~160 → use 1000
#                    NPS=32 → ~9s  → threshold ~450 → use 500 (short blocks for
#                    faster PBFT completion — smaller blocks commit quicker)
#   JMeter threads : 200 for NPS=16, 100 for NPS=32 (reduce connection storm)
#   Stabilize timeout: 600s for NPS=16, 900s for NPS=32 (P2P mesh settle)
#
# All values are DEFAULTS — explicit env vars always override.
_NPS=${NUMBER_OF_NODES_PER_SHARD:-4}
if [ "${_NPS}" -ge 32 ]; then
    : "${TRANSACTION_THRESHOLD:=500}"
    : "${CPU_LIMIT:=$(python3 -c "print(f'{min(4.0, 0.30 * (${_NPS}/4.0)**0.5):.2f}')")}"
    : "${JMETER_THREADS:=100}"
    _NPS_STABILIZE_TIMEOUT=600
    _NPS_MEMORY_MIB=$(python3 -c "print(min(3584, int(256 * (${_NPS}/4.0))))")
    log "${YELLOW}NPS=${_NPS} (≥32): using conservative params — threshold=${TRANSACTION_THRESHOLD}, threads=${JMETER_THREADS}, stabilize=${_NPS_STABILIZE_TIMEOUT}s, memory=${_NPS_MEMORY_MIB}MiB${NC}"
    log "${YELLOW}  PBFT at NPS=32 is beyond its practical regime; treat results as exploratory.${NC}"
elif [ "${_NPS}" -ge 16 ]; then
    : "${TRANSACTION_THRESHOLD:=1000}"
    : "${CPU_LIMIT:=$(python3 -c "print(f'{min(4.0, 0.30 * (${_NPS}/4.0)**0.5):.2f}')")}"
    : "${JMETER_THREADS:=200}"
    _NPS_STABILIZE_TIMEOUT=300
    _NPS_MEMORY_MIB=$(python3 -c "print(min(3584, int(256 * (${_NPS}/4.0))))")
    log "${YELLOW}NPS=${_NPS} (≥16): auto-tuned — threshold=${TRANSACTION_THRESHOLD}, threads=${JMETER_THREADS}, stabilize=${_NPS_STABILIZE_TIMEOUT}s, memory=${_NPS_MEMORY_MIB}MiB${NC}"
elif [ "${_NPS}" -ge 8 ]; then
    _NPS_STABILIZE_TIMEOUT=450
    _NPS_MEMORY_MIB=$(python3 -c "print(min(3584, int(256 * (${_NPS}/4.0))))")
else
    _NPS_STABILIZE_TIMEOUT=300
    _NPS_MEMORY_MIB=256
fi
# Apply computed memory cap if caller hasn't overridden it
: "${POD_MEMORY_MIB:=${_NPS_MEMORY_MIB:-256}}"
export POD_MEMORY_MIB
export TRANSACTION_THRESHOLD
export DRAIN_BATCH_SIZE=${DRAIN_BATCH_SIZE:-${TRANSACTION_THRESHOLD}}

# In LOCAL_MODE, cap pod memory to laptop-friendly limits.
# Formula: max(128, 128 + 8×NPS) → 160/192/256/384 MiB for NPS 4/8/16/32.
# Only kicks in if the NPS-computed (or default) value exceeds the local cap.
if [ "${LOCAL_MODE:-0}" = "1" ]; then
    _LOCAL_MEM_CAP=$(python3 -c "print(max(256, 128 + 8 * ${_NPS}))")
    if [ "${POD_MEMORY_MIB}" -gt "${_LOCAL_MEM_CAP}" ] 2>/dev/null; then
        POD_MEMORY_MIB=${_LOCAL_MEM_CAP}
        export POD_MEMORY_MIB
        log "${YELLOW}LOCAL_MODE: POD_MEMORY_MIB capped to ${POD_MEMORY_MIB}MiB for NPS=${_NPS} (production would be ${_NPS_MEMORY_MIB:-256}MiB)${NC}"
    fi
    # CPU: Kubernetes sets requests=limits when only limits are specified.
    # With 10 vCPU allocatable, cap so all pods fit: min(0.25, 9.0/total_pods).
    # NPS=4→0.25  NPS=8→0.25  NPS=16→0.18  NPS=32→0.09
    _TOTAL_PODS=$((NUMBER_OF_NODES + 1))
    _LOCAL_CPU_CAP=$(python3 -c "print(f'{min(0.25, 9.0 / ${_TOTAL_PODS}):.2f}')")
    if python3 -c "exit(0 if float('${CPU_LIMIT}') <= float('${_LOCAL_CPU_CAP}') else 1)" 2>/dev/null; then
        true
    else
        CPU_LIMIT=${_LOCAL_CPU_CAP}
        export CPU_LIMIT
        log "${YELLOW}LOCAL_MODE: CPU_LIMIT scaled to ${CPU_LIMIT} vCPU for ${_TOTAL_PODS} pods (fits 10-vCPU node)${NC}"
    fi
fi

# JMeter configuration
JMETER_THREADS=${JMETER_THREADS:-5}
JMETER_RAMP_UP=${JMETER_RAMP_UP:-5}
JMETER_DURATION=${JMETER_DURATION:-60}
# Ramp-down: last N seconds of the test window — JMeter stops sending at
# (DURATION - RAMP_DOWN) so the blockchain can drain without new load before
# the drain-wait phase starts. Set to 0 to disable (default: no ramp-down).
JMETER_RAMP_DOWN=${JMETER_RAMP_DOWN:-0}
# ConstantThroughputTimer unit is req/min; 6000 = 100 req/s
JMETER_THROUGHPUT=${JMETER_THROUGHPUT:-6000}

# Output files
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="performance-results"
RESULTS_FILE="${RESULTS_DIR}/pbft-enhanced-${TIMESTAMP}.jtl"
SUMMARY_FILE="${RESULTS_DIR}/pbft-enhanced-${TIMESTAMP}-summary.txt"
STATS_FILE="${RESULTS_DIR}/pbft-enhanced-${TIMESTAMP}-stats.csv"

log "${BLUE}========================================${NC}"
log "${BLUE}PBFT-Enhanced Performance Test${NC}"
log "${BLUE}========================================${NC}"
log "Nodes: ${NUMBER_OF_NODES}"
log "Transaction Threshold: ${TRANSACTION_THRESHOLD}"
log "JMeter Threads: ${JMETER_THREADS}"
log "Test Duration: ${JMETER_DURATION}s"
log "${BLUE}========================================${NC}"
echo

# Create results directory
mkdir -p "${RESULTS_DIR}"

# Cleanup function
cleanup() {
    local _exit=$?
    write_phase "cleanup (exit=$_exit)"
    # On non-zero exit, dump a full diag snapshot BEFORE deleting resources so
    # the state that caused the failure is captured (kubectl delete would wipe
    # the evidence otherwise).
    if [ "$_exit" -ne 0 ]; then
        diag_snapshot "cleanup exit=$_exit"
    fi
    log "\n${YELLOW}Cleaning up...${NC}"

    # Capture pod states BEFORE deletion for diagnostics
    log "Pod states at cleanup:"
    kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | awk '{print $3}' | sort | uniq -c | tee -a server.log || true
    kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | grep -v 'Running' > pods-not-running-detail.txt 2>/dev/null || true

    # Harvest last 200 log lines from a sample of pods before they are deleted.
    # At NPS>=16 the OOMKill or ECONNRESET storm appears in these last lines;
    # once kubectl delete runs the container filesystem is gone.
    _LOG_HARVEST="${RESULTS_DIR}/pod-logs-harvest-${TIMESTAMP}.txt"
    {
        echo "=== Pod log harvest at cleanup $(date '+%Y-%m-%d %H:%M:%S') ==="
        # Sample: core-server + first pod of each shard (step = NPS) up to 8 shards
        _HARVEST_STEP=${NUMBER_OF_NODES_PER_SHARD:-4}
        kubectl logs core-server --tail=100 2>/dev/null && echo "--- end core-server ---" || true
        for ((hi=0; hi<NUMBER_OF_NODES && hi<_HARVEST_STEP*8; hi+=_HARVEST_STEP)); do
            echo "--- p2p-server-${hi} ---"
            kubectl logs "p2p-server-${hi}" --tail=100 2>/dev/null || echo "(no logs)"
        done
        # Also flag any OOMKilled pods
        echo "--- OOMKilled pods ---"
        kubectl get pods -l domain=blockchain -o json 2>/dev/null \
            | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in d.get('items', []):
    name = p['metadata']['name']
    for cs in p.get('status', {}).get('containerStatuses', []):
        if cs.get('lastState', {}).get('terminated', {}).get('reason') == 'OOMKilled':
            print(f'OOMKilled: {name}  restartCount={cs.get(\"restartCount\",0)}')
" 2>/dev/null || true
    } > "$_LOG_HARVEST" 2>&1 &
    _HARVEST_PID=$!

    # Stop port forwarding and background log streaming
    if [ "${USE_HOST_NETWORK:-}" != "true" ]; then
        log "Stopping port forwarding..."
        pkill -f "kubectl port-forward" 2>&1 | tee -a server.log || true
        pkill -f "kubectl proxy" 2>&1 | tee -a server.log || true
    fi
    # Multi-EC2 socat forwarders (safe to run unconditionally — nothing happens
    # if no socat processes are alive)
    pkill -f "socat TCP-LISTEN" 2>/dev/null || true
    pkill -f "kubectl logs" 2>/dev/null || true

    # Wait for log harvest (up to 30s) before deleting pods so the harvest
    # can still read container filesystems.
    if [ -n "${_HARVEST_PID:-}" ]; then
        wait "$_HARVEST_PID" 2>/dev/null || true
        log "Pod log harvest saved: ${_LOG_HARVEST:-}"
    fi
    # Stop background monitors now that pod data is collected
    [ -n "${_HEARTBEAT_PID:-}" ] && kill "$_HEARTBEAT_PID" 2>/dev/null || true
    [ -n "${_OOMKILL_PID:-}" ]   && kill "$_OOMKILL_PID"   2>/dev/null || true

    # Delete Kubernetes resources.
    # --grace-period=0 --force is the "hard kill" combo. Passing --grace-period=1
    # with --force is rejected by kubectl ("--force and --grace-period greater
    # than 0 cannot be specified together") — silent failures here left 100+
    # pods Running after every 100-node test, which pinned the c6i.large master
    # while the outer teardown tried to terminate agents (see start.sh line 59,
    # which uses the correct flags).
    log "Deleting Kubernetes resources..."
    _DELETE_OUT=$(kubectl delete -f kubeConfig.yml --ignore-not-found --grace-period=0 --force 2>&1)
    _DELETE_RC=$?
    echo "$_DELETE_OUT" | tee -a server.log
    if [ "$_DELETE_RC" -ne 0 ]; then
        log "${RED}kubectl delete failed (rc=$_DELETE_RC) — pods likely still running${NC}"
    fi

    # Verify pods are actually gone before returning. If they aren't, the outer
    # driver's `aws ec2 delete-fleets --terminate-instances` will race against
    # a still-active PBFT gossip storm and freeze the master's kube-apiserver.
    log "Waiting for pods to fully terminate..."
    if kubectl wait --for=delete pods -l domain=blockchain --timeout=60s 2>&1 | tee -a server.log; then
        log "${GREEN}✓ All blockchain pods removed${NC}"
    else
        _STUCK=$(kubectl get pods -l domain=blockchain --no-headers 2>/dev/null | wc -l | tr -d ' ')
        log "${RED}⚠ ${_STUCK} pods still present after 60s — forcing kubelet-side termination${NC}"
        # Nuclear option: pull the pod objects out of etcd without waiting for
        # container runtime confirmation. Agents may already be terminating.
        kubectl get pods -l domain=blockchain -o name 2>/dev/null \
            | xargs -r -n 20 -P 4 kubectl delete --grace-period=0 --force --wait=false 2>&1 \
            | tee -a server.log || true
    fi

    log "${GREEN}Cleanup complete${NC}"
}

# Set trap to cleanup on exit
trap cleanup EXIT INT TERM

# Step 1: Start blockchain using existing start.sh
write_phase "step1: start.sh (kubectl apply)"
log "${BLUE}Step 1: Starting blockchain (using start.sh)...${NC}"
# Run start.sh to completion so kubectl apply finishes all resources.
# Previously ran in background and killed early when port 3001 responded,
# but with hostNetwork the first pod responds almost immediately — while
# kubectl is still applying the remaining hundreds of resources.
AUTOMATED_TEST=true ./start.sh 2>&1 | tee -a server.log

# Clean up any port-forwards set up by start.sh (run-performance-test.sh
# manages its own port-forwards with a watchdog in non-hostNetwork mode)
if [ "${USE_HOST_NETWORK:-}" != "true" ]; then
    pkill -f "kubectl port-forward" 2>/dev/null || true
    pkill -f "kubectl proxy" 2>/dev/null || true
    sleep 2
fi

log "${GREEN}✓ Blockchain deployed and ready${NC}"
echo

# Step 2: Wait for ALL pods to pass readiness probes (httpGet /health).
# Memory raised to 256Mi so pods no longer crash under the P2P connection storm.
# Readiness probes are lenient (10s period, 5s timeout, 6 failures) to tolerate
# busy startup without false negatives.
write_phase "step2: waiting for pod readiness"
log "${BLUE}Step 2: Waiting for all nodes to be ready...${NC}"
TOTAL_EXPECTED=$((NUMBER_OF_NODES))  # p2p-server pods only (core-server has no probe)
TIMEOUT=$((NUMBER_OF_NODES * 3))
[ $TIMEOUT -lt 600 ] && TIMEOUT=600
ELAPSED=0

while true; do
    READY=$(kubectl get pods -l app=p2p-server --no-headers 2>/dev/null | grep -c '1/1.*Running' || true)
    TOTAL=$(kubectl get pods -l app=p2p-server --no-headers 2>/dev/null | wc -l | tr -d ' ')
    PCT=0; [ "$TOTAL" -gt 0 ] && PCT=$((READY * 100 / TOTAL))

    if [ "$READY" -ge "$TOTAL_EXPECTED" ] && [ "$TOTAL" -ge "$TOTAL_EXPECTED" ]; then
        log "${GREEN}✓ All $READY/$TOTAL nodes are ready ($PCT%)${NC}"
        break
    fi

    if [ $ELAPSED -ge $TIMEOUT ]; then
        NOT_READY=$(kubectl get pods -l app=p2p-server --no-headers 2>/dev/null | grep -v '1/1.*Running' | awk '{print $3}' | sort | uniq -c | tr '\n' ', ')
        log "${RED}✗ Timeout after ${ELAPSED}s: $READY/$TOTAL ready ($PCT%), need all $TOTAL_EXPECTED${NC}"
        log "  Not ready: $NOT_READY"
        exit 1
    fi

    sleep 5
    ELAPSED=$((ELAPSED + 5))
    if (( ELAPSED % 10 == 0 )); then
        NOT_READY=$(kubectl get pods -l app=p2p-server --no-headers 2>/dev/null | grep -v '1/1.*Running' | awk '{print $3}' | sort | uniq -c | tr '\n' ', ')
        log "[Health] Ready: $READY/$TOTAL ($PCT%) | Need: all $TOTAL_EXPECTED | ${ELAPSED}s"
        [ -n "$NOT_READY" ] && log "  Not ready: $NOT_READY"
    fi
done
echo

# ── Multi-EC2 socat forwarders ──────────────────────────────────────────────
# When pods use hostNetwork AND are spread 1-per-node (multi-EC2 cluster mode),
# each pod lives on a different agent's private IP. `localhost:PORT` on the
# master doesn't reach them, so JMeter and stats collection would fail.
# Spawn one socat TCP-relay per pod, so master's localhost:PORT → agent-IP:PORT.
# Cheap kernel-level TCP splice — negligible CPU vs kubectl port-forward.
if [ "${USE_HOST_NETWORK:-}" = "true" ] && [ "${SPREAD_PODS_ACROSS_NODES:-}" = "true" ]; then
    write_phase "step2c: socat forwarders (multi-EC2)"
    log "${BLUE}Setting up socat forwarders (multi-EC2 hostNetwork bridge)...${NC}"
    if ! command -v socat &>/dev/null; then
        sudo dnf install -y -q socat 2>&1 | tail -1 || true
    fi
    pkill -f "socat TCP-LISTEN" 2>/dev/null || true
    sleep 1
    _SOCAT_STARTED=0
    for ((i=0; i<NUMBER_OF_NODES; i++)); do
        POD=p2p-server-$i
        PORT=$((3001+i))
        AGENT_IP=$(kubectl get pod "$POD" -o jsonpath='{.status.hostIP}' 2>/dev/null)
        if [ -n "$AGENT_IP" ]; then
            nohup socat TCP-LISTEN:$PORT,fork,reuseaddr TCP:$AGENT_IP:$PORT >/dev/null 2>&1 &
            _SOCAT_STARTED=$((_SOCAT_STARTED + 1))
        fi
        if (( (i+1) % 25 == 0 )); then sleep 1; fi
    done
    sleep 3
    _SOCAT_LIVE=$(pgrep -c -f "socat TCP-LISTEN" || echo 0)
    log "  ${GREEN}✓ ${_SOCAT_LIVE}/${_SOCAT_STARTED} socat forwarders active${NC}"
fi

# Step 2b: Wait for P2P mesh to stabilize before JMeter starts.
# Readiness probes only verify the HTTP endpoint is up — they don't check peer
# connectivity. At 512 nodes, ~1536 WebSocket connections fire simultaneously;
# until they all complete, many healthy shards self-report as FAULTY because
# they see fewer than MIN_APPROVALS connected peers. Polling the core-server's
# shard status ensures consensus can actually run before we send transactions.
if [ "${NUMBER_OF_NODES}" -gt 32 ]; then
    # Expected healthy shards = total_shards - broken_shards
    # Adversarial placement breaks floor(FAULTY_NODES / faultyPerShardToBreak) shards
    TOTAL_SHARDS=$((NUMBER_OF_NODES / NUMBER_OF_NODES_PER_SHARD))
    FAULTY_PER_SHARD_TO_BREAK=$(( NUMBER_OF_NODES_PER_SHARD / 3 + 1 ))
    BROKEN_SHARDS=$(( NUMBER_OF_FAULTY_NODES / FAULTY_PER_SHARD_TO_BREAK ))
    EXPECTED_HEALTHY=$(( TOTAL_SHARDS - BROKEN_SHARDS ))
    # Require at least 80% of expected healthy shards to be reporting UNDER-UTILIZED
    MIN_HEALTHY=$(( EXPECTED_HEALTHY * 80 / 100 ))
    [ "$MIN_HEALTHY" -lt 1 ] && MIN_HEALTHY=1
    write_phase "step2b: P2P mesh stabilize (need $MIN_HEALTHY/$EXPECTED_HEALTHY healthy shards)"
    log "${BLUE}Step 2b: Waiting for P2P mesh to stabilize ($MIN_HEALTHY/$EXPECTED_HEALTHY healthy shards needed)...${NC}"
    STABILIZE_TIMEOUT=${_NPS_STABILIZE_TIMEOUT:-300}
    STABILIZE_ELAPSED=0
    while [ $STABILIZE_ELAPSED -lt $STABILIZE_TIMEOUT ]; do
        # Sample at least min(20, NUMBER_OF_NODES) evenly-spaced nodes and count
        # distinct non-FAULTY shard indices. Previously we sampled every
        # NUMBER_OF_NODES_PER_SHARD-th node — at NPS==NUMBER_OF_NODES that meant
        # one sample, so a single non-responsive pod hid the whole shard's
        # health. Sampling ≥20 pods gives redundancy even when NPS is large.
        SAMPLE_COUNT=$(( NUMBER_OF_NODES < 20 ? NUMBER_OF_NODES : 20 ))
        SAMPLE_STRIDE=$(( NUMBER_OF_NODES / SAMPLE_COUNT ))
        [ $SAMPLE_STRIDE -lt 1 ] && SAMPLE_STRIDE=1
        HEALTHY_COUNT=$(
            for ((i=0; i<NUMBER_OF_NODES; i+=SAMPLE_STRIDE)); do
                PORT=$((3001 + i))
                curl -s --max-time 30 http://localhost:$PORT/stats 2>/dev/null || true
                echo  # newline delimiter so Python parses each response as a separate line
            done | python3 -c "
import sys, json
healthy = set()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        shard = d.get('rate',{}).get('shardIndex','')
        status = d.get('rate',{}).get('shardStatus','FAULTY')
        if status != 'FAULTY' and shard:
            healthy.add(shard)
    except: pass
print(len(healthy))" 2>/dev/null || echo 0
        )
        if [ "${HEALTHY_COUNT:-0}" -ge "$MIN_HEALTHY" ]; then
            log "${GREEN}✓ P2P mesh stabilized: $HEALTHY_COUNT healthy shards (need $MIN_HEALTHY)${NC}"
            break
        fi
        sleep 5
        STABILIZE_ELAPSED=$((STABILIZE_ELAPSED + 5))
        if (( STABILIZE_ELAPSED % 15 == 0 )); then
            log "[P2P] Healthy shards: ${HEALTHY_COUNT:-0}/$EXPECTED_HEALTHY (need $MIN_HEALTHY) | ${STABILIZE_ELAPSED}s"
        fi
    done
    if [ $STABILIZE_ELAPSED -ge $STABILIZE_TIMEOUT ]; then
        log "${YELLOW}⚠ P2P stabilization timeout (${STABILIZE_TIMEOUT}s) — proceeding with ${HEALTHY_COUNT:-0} healthy shards${NC}"
    fi
fi

# Set up port-forwards for JMeter (skip in hostNetwork mode — pods bind directly)
if [ "${USE_HOST_NETWORK:-}" = "true" ]; then
    log "Skipping port-forwards (hostNetwork mode — pods bind directly to host ports)"
else
    write_phase "setup: kubectl port-forward for $NUMBER_OF_NODES nodes"
    log "Setting up port-forwards for JMeter..."
    # Raise file-descriptor and inotify limits
    ulimit -n 65536 2>/dev/null || true
    if [ -f /proc/sys/fs/inotify/max_user_instances ]; then
        sudo sysctl -w fs.inotify.max_user_instances=8192 2>/dev/null || true
        sudo sysctl -w fs.inotify.max_user_watches=524288 2>/dev/null || true
    fi
    # Start in batches to avoid overwhelming the API server
    PF_BATCH=50
    for ((i=0; i<NUMBER_OF_NODES; i++)); do
        nohup kubectl port-forward pod/p2p-server-$i $((3001+i)):$((3001+i)) >> server.log 2>&1 &
        if (( (i+1) % PF_BATCH == 0 )); then sleep 2; fi
    done
    # Scale settle time with node count
    PF_SETTLE=$((NUMBER_OF_NODES / 10))
    [ $PF_SETTLE -lt 10 ] && PF_SETTLE=10
    [ $PF_SETTLE -gt 60 ] && PF_SETTLE=60
    log "Waiting ${PF_SETTLE}s for port-forwards to stabilize..."
    sleep $PF_SETTLE
fi

# Step 3: Run JMeter test
# Start diagnostic pod log streaming BEFORE JMeter — captures block commits,
# clears, redistributions, and duplicate rejections for post-test analysis.
# start.sh may have already started this, but if it crashed early (e.g. kubectl
# apply --server-side conflict), there are no background kubectl-log processes.
# Kill any stale ones first, then start fresh.
pkill -f "kubectl logs" 2>/dev/null || true
sleep 1
if [ -f nodesEnv.yml ]; then
    DIAG_PODS=$(python3 - <<'PYEOF'
import re, collections
text = open("nodesEnv.yml").read()
entries = []
for block in re.split(r'\n(?=- )', text.strip()):
    entry = {}
    for line in block.splitlines():
        m = re.match(r"[ -]*(\w+):\s*'?([^']+?)'?\s*$", line.strip())
        if m:
            entry[m.group(1)] = m.group(2).strip("'\"")
    if "P2P_PORT" in entry:
        entries.append(entry)
by_shard = collections.defaultdict(list)
for e in entries:
    by_shard[e.get("SUBSET_INDEX","")].append(e)
healthy_pod_indices = []
dead_pod_indices    = []
for subset, nodes in by_shard.items():
    faulty_count = sum(1 for n in nodes if n.get("IS_FAULTY","false").lower() == "true")
    pod_indices  = [int(n["P2P_PORT"]) - 5001 for n in nodes]
    if faulty_count == 0 and not healthy_pod_indices:
        healthy_pod_indices = pod_indices
    elif faulty_count >= 2 and not dead_pod_indices:
        dead_pod_indices = pod_indices
    if healthy_pod_indices and dead_pod_indices:
        break
# Cap the number of streamed pods. At NPS >= 100, streaming logs from every
# healthy shard pod triggered N concurrent `kubectl logs -f` SPDY connections
# to the k3s API server, which saturated the master (SSH banner exchange
# timed out for the full duration of the run). Three pods per role gives
# enough signal for diagnostics without overwhelming the control plane.
_MAX_PER_ROLE = 3
all_indices = healthy_pod_indices[:_MAX_PER_ROLE] + dead_pod_indices[:_MAX_PER_ROLE]
print(" ".join(f"p2p-server-{i}" for i in all_indices))
PYEOF
)
    if [ -n "$DIAG_PODS" ]; then
        log "Diagnostic log streaming: core-server $DIAG_PODS"
        kubectl logs core-server -f --prefix >> server.log 2>&1 &
        for _POD in $DIAG_PODS; do
            kubectl logs "$_POD" -f --prefix >> server.log 2>&1 &
        done
    fi
fi

write_phase "step3: JMeter (threads=${JMETER_THREADS}, dur=${JMETER_DURATION}s)"
log "${BLUE}Step 3: Running JMeter performance test...${NC}"
log "  Duration: ${JMETER_DURATION}s (active load: $((JMETER_DURATION - JMETER_RAMP_DOWN))s + ramp-down: ${JMETER_RAMP_DOWN}s)"
log "  Threads: ${JMETER_THREADS}"
log "  Ramp-up: ${JMETER_RAMP_UP}s"
log "  Ramp-down: ${JMETER_RAMP_DOWN}s"
echo

# ── Pre-exhaustion monitoring ─────────────────────────────────────────────────
# Heartbeat: snapshot aggregated /stats (blockchain totals) every 60s.
# If JMeter or drain crashes before step 4, this file holds the last good state.
_HEARTBEAT_FILE="${RESULTS_DIR}/heartbeat-stats-${TIMESTAMP}.jsonl"
_HB_USE_EXEC="${USE_HOST_NETWORK:-}"
_HB_SPREAD="${SPREAD_PODS_ACROSS_NODES:-}"

# Build pod→IP map once (hostNetwork: pod IP = host IP, directly reachable via VPC).
# Avoids kubectl exec → kubelet (port 10250) which fails with 502 on multi-EC2 k3s.
_POD_IP_MAP_FILE=$(mktemp)
if [ "${USE_HOST_NETWORK:-}" = "true" ] && [ "${SPREAD_PODS_ACROSS_NODES:-}" = "true" ]; then
    kubectl get pods -o wide --no-headers 2>/dev/null \
        | awk '/^p2p-server-/{print $1, $6}' > "$_POD_IP_MAP_FILE"
fi
(
    _hb_interval=60
    while true; do
        sleep $_hb_interval
        _ts=$(date +%s)
        _hb_tmp=$(mktemp -d)
        if [ "$_HB_USE_EXEC" = "true" ] && [ "$_HB_SPREAD" = "true" ]; then
            # Refresh map each heartbeat: pods may have gotten IPs since last build.
            kubectl get pods -o wide --no-headers 2>/dev/null \
                | awk '/^p2p-server-/{print $1, $6}' > "$_POD_IP_MAP_FILE"
            for ((i=0; i<NUMBER_OF_NODES; i++)); do
                PORT=$((3001+i))
                _pod_ip=$(grep "^p2p-server-$i " "$_POD_IP_MAP_FILE" 2>/dev/null | awk '{print $2}')
                if [ -n "$_pod_ip" ]; then
                    curl -s --max-time 3 "http://${_pod_ip}:${PORT}/stats" > "$_hb_tmp/$i.json" 2>/dev/null &
                fi
            done
        else
            for ((i=0; i<NUMBER_OF_NODES; i++)); do
                PORT=$((3001+i))
                curl -s --max-time 3 "http://localhost:$PORT/stats" > "$_hb_tmp/$i.json" 2>/dev/null &
            done
        fi
        wait
        _snap=$(python3 - "$_hb_tmp" "$NUMBER_OF_NODES" "$_ts" << 'HB_PY'
import sys, json, os
stats_dir, num_nodes, ts_str = sys.argv[1], int(sys.argv[2]), sys.argv[3]
totals = {}; responded = 0; round_ms_list = []
for i in range(num_nodes):
    fpath = os.path.join(stats_dir, f"{i}.json")
    if not os.path.exists(fpath) or os.path.getsize(fpath) == 0: continue
    try:
        d = json.loads(open(fpath).read())
        if d.get('isFaulty'): continue
        responded += 1
        for k,v in d.get('total',{}).items():
            totals[k] = {'tx': max(totals.get(k,{}).get('tx',0), v.get('transactions',0)),
                         'blocks': max(totals.get(k,{}).get('blocks',0), v.get('blocks',0))}
        arm = d.get('avgRoundMs')
        if arm and arm > 0: round_ms_list.append(arm)
    except: pass
total_tx = sum(v['tx'] for v in totals.values())
total_bl = sum(v['blocks'] for v in totals.values())
med_rm = sorted(round_ms_list)[len(round_ms_list)//2] if round_ms_list else 0
print(json.dumps({'ts': int(ts_str), 'responded': responded, 'total_tx': total_tx,
                  'total_blocks': total_bl, 'median_round_ms': med_rm}))
HB_PY
) 2>/dev/null || echo '{"ts":'$_ts',"error":"snap_failed"}'
        rm -rf "$_hb_tmp"
        echo "$_snap" >> "$_HEARTBEAT_FILE"
    done
) &
_HEARTBEAT_PID=$!

# OOMKill detector: polls every 30s; logs pods that transition to OOMKilled.
# Captures the last 50 log lines from the victim before they are evicted.
_OOMKILL_LOG="${RESULTS_DIR}/oomkill-events-${TIMESTAMP}.txt"
_OOMKILL_SEEN=""
(
    while true; do
        sleep 30
        _victims=$(kubectl get pods -l domain=blockchain -o json 2>/dev/null \
            | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in d.get('items', []):
    name = p['metadata']['name']
    for cs in p.get('status', {}).get('containerStatuses', []):
        if cs.get('lastState', {}).get('terminated', {}).get('reason') == 'OOMKilled':
            print(name)
" 2>/dev/null || true)
        for _victim in $_victims; do
            if ! echo "$_OOMKILL_SEEN" | grep -qF "$_victim"; then
                _OOMKILL_SEEN="$_OOMKILL_SEEN $_victim"
                {
                    echo "=== OOMKill detected: $_victim at $(date '+%Y-%m-%d %H:%M:%S') ==="
                    kubectl logs "$_victim" --tail=50 2>/dev/null || echo "(logs unavailable)"
                    echo "=== kubectl top (current) ==="
                    kubectl top pods -l domain=blockchain --no-headers 2>/dev/null | sort -k3 -rh | head -10 || true
                } >> "$_OOMKILL_LOG" 2>&1
                log "${RED}⚠ OOMKill detected: $_victim — last 50 lines saved to $( basename "$_OOMKILL_LOG" )${NC}"
            fi
        done
    done
) &
_OOMKILL_PID=$!

# Start port-forward watchdog (only when not using hostNetwork)
if [ "${USE_HOST_NETWORK:-}" != "true" ]; then
(
    while true; do
        sleep 3
        for ((i=0; i<NUMBER_OF_NODES; i++)); do
            PORT=$((3001+i))
            if ! pgrep -f "port-forward pod/p2p-server-$i $PORT" > /dev/null 2>&1; then
                nohup kubectl port-forward pod/p2p-server-$i $PORT:$PORT >> server.log 2>&1 &
            fi
        done
    done
) &
WATCHDOG_PID=$!
fi

# Active load duration = total duration minus ramp-down quiet phase
JMETER_ACTIVE_DURATION=$(( JMETER_DURATION - JMETER_RAMP_DOWN ))
if [ "${JMETER_ACTIVE_DURATION}" -le 0 ]; then
    log "${RED}✗ JMETER_RAMP_DOWN (${JMETER_RAMP_DOWN}s) must be less than JMETER_DURATION (${JMETER_DURATION}s)${NC}"
    exit 1
fi

TEST_START_TIME=$(date +%s)
jmeter -n -t "Test Plan.jmx" \
    -Jthreads=${JMETER_THREADS} \
    -Jrampup=${JMETER_RAMP_UP} \
    -Jduration=${JMETER_ACTIVE_DURATION} \
    -Jthroughput=${JMETER_THROUGHPUT} \
    -l "${RESULTS_FILE}" \
    -e -o "${RESULTS_DIR}/pbft-enhanced-${TIMESTAMP}-report" 2>&1 | tee -a server.log

# Kill watchdog and monitors
if [ -n "${WATCHDOG_PID:-}" ]; then kill $WATCHDOG_PID 2>/dev/null || true; fi
# Keep heartbeat and OOMKill detector running through drain so they capture post-JMeter state.
# They are killed in cleanup() after pod log harvest completes.

log "${GREEN}✓ JMeter test completed${NC}"

# Intermediate save: write JMeter-only partial stats immediately so they survive
# even if the drain phase or stats collection later crashes.
_PARTIAL_STATS="${RESULTS_DIR}/pbft-enhanced-${TIMESTAMP}-partial.csv"
if [ -f "${RESULTS_FILE}" ]; then
    {
        echo "Metric,Value"
        awk -F',' 'NR>1 {count++} END {print "Total Samples," count+0}' "${RESULTS_FILE}"
        awk -F',' 'NR>1 {sum+=$2;count++} END {print "Average Response Time (ms)," int(sum/(count?count:1))}' "${RESULTS_FILE}"
        awk -F',' 'NR>1 && $8=="true" {ok++} NR>1 {tot++} END {printf "Success Rate (%%),%s\n", (tot>0?ok*100/tot:0)}' "${RESULTS_FILE}"
        echo "Partial Save At,$(date '+%Y-%m-%d %H:%M:%S')"
    } > "$_PARTIAL_STATS" 2>/dev/null || true
    log "Intermediate JMeter stats saved: $(basename "$_PARTIAL_STATS")"
fi

# Ramp-down quiet phase: no new transactions; blockchain completes in-flight blocks
if [ "${JMETER_RAMP_DOWN}" -gt 0 ]; then
    log "${YELLOW}Ramp-down: ${JMETER_RAMP_DOWN}s quiet phase (no new TXs)...${NC}"
    sleep "${JMETER_RAMP_DOWN}"
    log "${GREEN}✓ Ramp-down complete${NC}"
fi
echo

# Re-establish port-forwarding before stats collection (only when not using hostNetwork)
if [ "${USE_HOST_NETWORK:-}" != "true" ]; then
    pkill -f "kubectl port-forward" 2>/dev/null || true
    sleep 1
    for ((i=0; i<NUMBER_OF_NODES; i++)); do
        nohup kubectl port-forward pod/p2p-server-$i $((3001+i)):$((3001+i)) >> server.log 2>&1 &
    done
fi

# Wait for transaction pool to drain (wait until unassigned hits 0)
write_phase "drain: waiting for TX pool to drain"
log "${BLUE}Waiting for transaction pool to drain...${NC}"
# Scale drain timeout with network size and topology:
#   - At 256 nodes, PBFT blocks take ~18s each due to O(n²) message complexity.
#     With TRANSACTION_REASSIGNMENT_TIMEOUT_MS=60s a single block round can consume
#     60s before TXs return to pool, so we need at least 180s to drain the backlog.
#   - No dead shards → less backlog, 90s is sufficient.
if [ "${BROKEN_SHARDS:-0}" -gt 0 ]; then
    # Extra time proportional to node count: large networks have slower PBFT rounds.
    # Base 180s covers up to ~300 nodes; +60s for every 128 nodes above 256.
    _SIZE_FACTOR=$(( (${NUMBER_OF_NODES:-256} - 128) / 128 ))
    [ $_SIZE_FACTOR -lt 0 ] && _SIZE_FACTOR=0
    DRAIN_TIMEOUT=$(( 180 + _SIZE_FACTOR * 60 ))
else
    DRAIN_TIMEOUT=90
fi
log "Drain timeout: ${DRAIN_TIMEOUT}s (nodes=${NUMBER_OF_NODES:-?}, broken_shards=${BROKEN_SHARDS:-0})"
# Rebuild pod IP map: all pods are now Running, so all IPs should be available.
if [ "${USE_HOST_NETWORK:-}" = "true" ] && [ "${SPREAD_PODS_ACROSS_NODES:-}" = "true" ]; then
    kubectl get pods -o wide --no-headers 2>/dev/null \
        | awk '/^p2p-server-/{print $1, $6}' > "$_POD_IP_MAP_FILE"
fi
DRAIN_ELAPSED=0
PREV_UNASSIGNED=-1
UNCHANGED_COUNT=0
DRAIN_END_TIME=
while [ $DRAIN_ELAPSED -lt $DRAIN_TIMEOUT ]; do
    sleep 5
    DRAIN_ELAPSED=$((DRAIN_ELAPSED + 5))
    # Step by NODES_PER_SHARD to sample exactly one representative node per shard,
    # then SUM the per-shard unassigned counts.
    # MIN was wrong: a drained shard returns 0 and would falsely signal completion
    # while other shards still had stuck transactions.
    STEP=${NUMBER_OF_NODES_PER_SHARD}
    [ $STEP -lt 1 ] && STEP=1
    SUM_UNASSIGNED=0
    VALID_SAMPLES=0
    OFFSET=0
    while [ $(( OFFSET * STEP )) -lt $NUMBER_OF_NODES ]; do
        IDX_BASE=$(( OFFSET * STEP ))
        _SHARD_GOT_SAMPLE=0
        # Try up to 3 nodes per shard: if the first (e.g. OOM-killed) is unreachable,
        # fall through to its neighbours which should still be honest and responding.
        _MAX_SHARD_TRIES=$(( STEP < 3 ? STEP : 3 ))
        for ((_SHARD_TRY=0; _SHARD_TRY<_MAX_SHARD_TRIES && _SHARD_GOT_SAMPLE==0; _SHARD_TRY++)); do
            IDX=$(( IDX_BASE + _SHARD_TRY ))
            [ $IDX -ge $NUMBER_OF_NODES ] && break
            PORT=$((3001+IDX))
            if [ "${USE_HOST_NETWORK:-}" = "true" ] && [ "${SPREAD_PODS_ACROSS_NODES:-}" = "true" ]; then
                _drain_ip=$(grep "^p2p-server-$IDX " "$_POD_IP_MAP_FILE" 2>/dev/null | awk '{print $2}')
                DRAIN_STATS=$(curl -s --max-time 5 "http://${_drain_ip}:${PORT}/stats" 2>/dev/null || echo '')
            else
                DRAIN_STATS=$(curl -s --max-time 5 http://localhost:$PORT/stats 2>/dev/null || echo '')
            fi
            if [ -n "$DRAIN_STATS" ]; then
                NODE_UNASSIGNED=$(echo "$DRAIN_STATS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('isFaulty', False):
        print(-1)
    else:
        total = sum(v.get('unassignedTransactions', 0) for v in d.get('total', {}).values())
        print(total)
except: print(-1)
" 2>/dev/null || echo -1)
                if [ "$NODE_UNASSIGNED" != "-1" ]; then
                    SUM_UNASSIGNED=$(( SUM_UNASSIGNED + NODE_UNASSIGNED ))
                    VALID_SAMPLES=$(( VALID_SAMPLES + 1 ))
                    _SHARD_GOT_SAMPLE=1
                fi
            fi
        done
        OFFSET=$(( OFFSET + 1 ))
    done
    # No valid samples means all polled nodes were unreachable/faulty — treat as unknown
    [ $VALID_SAMPLES -eq 0 ] && SUM_UNASSIGNED=-1
    CUR_UNASSIGNED=${SUM_UNASSIGNED}
    echo -ne "  Drain wait ${DRAIN_ELAPSED}s — unassigned: ${CUR_UNASSIGNED}\r"
    if [ "$CUR_UNASSIGNED" = "0" ]; then
        echo ""
        DRAIN_END_TIME=$(date +%s)
        log "${GREEN}✓ All transactions processed (unassigned=0)${NC}"
        break
    else
        # Treat as stalled only when the pool is not decreasing at all.
        # Using ±tolerance caused premature exit when draining slowly (~30 TXs/5s).
        # Threshold is 6 polls (30s) not 3 (15s): at 256 nodes, PBFT blocks take
        # ~18s so a single round can span 3+ polls without the unassigned count
        # moving — stall would fire mid-block and exit prematurely.
        if [ "$CUR_UNASSIGNED" != "-1" ] && [ "$PREV_UNASSIGNED" != "-1" ] && [ $CUR_UNASSIGNED -ge $PREV_UNASSIGNED ]; then
            UNCHANGED_COUNT=$(( UNCHANGED_COUNT + 1 ))
            if [ $UNCHANGED_COUNT -ge 6 ]; then
                echo ""
                DRAIN_END_TIME=$(date +%s)
                log "${YELLOW}Pool stalled at ${CUR_UNASSIGNED} unassigned (not decreasing for 30s) — stopping drain wait${NC}"
                break
            fi
        else
            UNCHANGED_COUNT=0
        fi
    fi
    PREV_UNASSIGNED=$CUR_UNASSIGNED
done
DRAIN_END_TIME=${DRAIN_END_TIME:-$(date +%s)}
TOTAL_ELAPSED=$(( DRAIN_END_TIME - TEST_START_TIME ))

# Step 4: Collect blockchain statistics
write_phase "step4: collecting blockchain stats"
log "${BLUE}Step 4: Collecting blockchain statistics...${NC}"
{
    echo "PBFT-Enhanced Performance Test Results"
    echo "========================================"
    echo "Timestamp: ${TIMESTAMP}"
    echo "Configuration:"
    echo "  - Number of Nodes: ${NUMBER_OF_NODES}"
    echo "  - Transaction Threshold: ${TRANSACTION_THRESHOLD}"
    echo "  - Faulty Nodes: ${NUMBER_OF_FAULTY_NODES}"
    echo "  - CPU Limit: ${CPU_LIMIT}"
    echo ""
    echo "JMeter Configuration:"
    echo "  - Threads: ${JMETER_THREADS}"
    echo "  - Ramp-up: ${JMETER_RAMP_UP}s"
  echo "  - Ramp-down: ${JMETER_RAMP_DOWN}s"
  echo "  - Duration: ${JMETER_DURATION}s (active: $((JMETER_DURATION - JMETER_RAMP_DOWN))s)"
    echo "  - Target Throughput: ${JMETER_THROUGHPUT} req/s"
    echo ""
    echo "Blockchain Statistics (By Shard):"
    echo "========================================"
    
    # Helper: parse a scalar value from JSON using jq or python3
    json_val() {
        local json="$1"
        local jq_expr="$2"
        local py_expr="$3"
        if command -v jq &> /dev/null; then
            echo "$json" | jq -r "$jq_expr" 2>/dev/null
        else
            echo "$json" | python3 -c "import sys,json; data=json.load(sys.stdin); print($py_expr)" 2>/dev/null
        fi
    }

    TOTAL_BLOCKS=0
    TOTAL_TX_IN_BLOCKS=0
    TOTAL_UNASSIGNED_TX=0
    TOTAL_VERIFICATION_UNASSIGNED_TX=0
    TOTAL_VERIFICATION_TX=0
    NODES_RESPONDED=0

    # Fetch all node stats in parallel. In multi-EC2 hostNetwork mode, use direct
    # curl to pod IP (= host IP) — bypasses kubectl exec → kubelet (502 on k3s).
    STATS_TMP=$(mktemp -d)
    trap "rm -rf $STATS_TMP" RETURN 2>/dev/null || true
    # Refresh pod IP map before final stats (pods may have moved since heartbeat build).
    if [ "${USE_HOST_NETWORK:-}" = "true" ] && [ "${SPREAD_PODS_ACROSS_NODES:-}" = "true" ]; then
        kubectl get pods -o wide --no-headers 2>/dev/null \
            | awk '/^p2p-server-/{print $1, $6}' > "$_POD_IP_MAP_FILE"
        for ((i=0; i<NUMBER_OF_NODES; i++)); do
            PORT=$((3001+i))
            _stats_ip=$(grep "^p2p-server-$i " "$_POD_IP_MAP_FILE" 2>/dev/null | awk '{print $2}')
            if [ -n "$_stats_ip" ]; then
                curl -s --max-time 30 "http://${_stats_ip}:${PORT}/stats" > "$STATS_TMP/$i.json" 2>/dev/null &
            fi
        done
    else
        for ((i=0; i<NUMBER_OF_NODES; i++)); do
            PORT=$((3001+i))
            curl -s --max-time 30 "http://localhost:$PORT/stats" > "$STATS_TMP/$i.json" 2>/dev/null &
        done
    fi
    wait

    # Single python3 invocation processes all node responses and produces
    # shell-eval-safe output (replaces ~1000 python3 process spawns).
    AGGREGATED=$(python3 - "$STATS_TMP" "$NUMBER_OF_NODES" << 'PYAGG'
import sys, json, os
stats_dir = sys.argv[1]
num_nodes = int(sys.argv[2])

shard_max = {}   # shard_idx -> {blocks, normalBlocks, verificationBlocks, tx, vtx, unassigned, vunassigned}
nodes_responded = 0
per_shard_text = []
round_ms_vals = []

for i in range(num_nodes):
    fpath = os.path.join(stats_dir, f"{i}.json")
    if not os.path.exists(fpath) or os.path.getsize(fpath) == 0:
        continue
    try:
        with open(fpath) as f:
            d = json.load(f)
    except (json.JSONDecodeError, IOError):
        continue
    if d.get("isFaulty", False):
        continue
    if d.get("rate", {}).get("shardStatus", "") == "FAULTY":
        continue
    nodes_responded += 1
    v = d.get("avgRoundMs")
    if v and v > 0:
        round_ms_vals.append(v)
    for shard_idx, vals in d.get("total", {}).items():
        blocks = vals.get("blocks", 0)
        nb = vals.get("normalBlocks", 0)
        vb = vals.get("verificationBlocks", 0)
        tx = vals.get("transactions", 0)
        vtx = vals.get("verificationTransactions", 0)
        ua = vals.get("unassignedTransactions", 0)
        vua = vals.get("verificationUnassignedTransactions", 0)
        prev = shard_max.get(shard_idx)
        if prev is None:
            shard_max[shard_idx] = {"blocks": blocks, "nb": nb, "vb": vb, "tx": tx, "vtx": vtx, "ua": ua, "vua": vua}
        else:
            if blocks > prev["blocks"]:
                prev["blocks"] = blocks; prev["nb"] = nb; prev["vb"] = vb
                prev["ua"] = ua; prev["vua"] = vua
            if tx > prev["tx"]:
                prev["tx"] = tx
            if vtx > prev["vtx"]:
                prev["vtx"] = vtx

total_blocks = 0; total_tx = 0; total_vtx = 0; total_ua = 0; total_vua = 0
for idx in sorted(shard_max.keys()):
    s = shard_max[idx]
    per_shard_text.append(f"Shard {idx} (max across shard nodes):")
    per_shard_text.append("----------------------------------------")
    per_shard_text.append(f"  Normal Blocks Created: {s['nb']}")
    per_shard_text.append(f"  Verification Blocks Created: {s['vb']}")
    per_shard_text.append(f"  Normal Transactions in Blocks: {s['tx']}")
    per_shard_text.append(f"  Verification Transactions in Blocks: {s['vtx']}")
    per_shard_text.append(f"  Unassigned Transactions: {s['ua']}")
    per_shard_text.append(f"  Verification Unassigned Transactions: {s['vua']}")
    per_shard_text.append("")
    total_blocks += s["nb"]; total_tx += s["tx"]; total_vtx += s["vtx"]
    total_ua += s["ua"]; total_vua += s["vua"]

# Median avgRoundMs across honest nodes (robust against outlier proposers)
median_round_ms = 0
if round_ms_vals:
    s = sorted(round_ms_vals)
    n = len(s)
    median_round_ms = (s[n//2] + s[(n-1)//2]) / 2

# Output in a format the shell can parse
print(f"NODES_RESPONDED={nodes_responded}")
print(f"TOTAL_BLOCKS={total_blocks}")
print(f"TOTAL_TX_IN_BLOCKS={total_tx}")
print(f"TOTAL_VERIFICATION_TX={total_vtx}")
print(f"TOTAL_UNASSIGNED_TX={total_ua}")
print(f"TOTAL_VERIFICATION_UNASSIGNED_TX={total_vua}")
print(f"MEDIAN_ROUND_MS={median_round_ms:.1f}")
print("---SHARDS---")
print("\n".join(per_shard_text) if per_shard_text else "  (No node responded to /stats query)")
PYAGG
    )
    rm -rf "$STATS_TMP"

    # Parse the aggregated output (captures NODES_RESPONDED, TOTAL_BLOCKS, ..., MEDIAN_ROUND_MS)
    # Save raw PYAGG output for debugging (overwritten each run, harmless)
    echo "$AGGREGATED" > "${RESULTS_DIR}/pyagg-debug-${TIMESTAMP}.txt" 2>/dev/null || true
    eval "$(echo "$AGGREGATED" | sed -n '/^[A-Z_]*=[0-9.]*$/p')"
    SHARD_TEXT=$(echo "$AGGREGATED" | sed '1,/^---SHARDS---$/d')

    echo "$SHARD_TEXT"
    
    echo ""
    echo "========================================"
    echo "TOTAL (All Shards):"
    echo "========================================"
    echo "Total Normal Blocks Created: $TOTAL_BLOCKS"
    echo "Total Transactions in Blocks: $TOTAL_TX_IN_BLOCKS"
    echo "Total Verification Transactions in Blocks: $TOTAL_VERIFICATION_TX"
    echo "Total Unassigned Transactions: $TOTAL_UNASSIGNED_TX"
    echo "Total Verification Unassigned Transactions: $TOTAL_VERIFICATION_UNASSIGNED_TX"
    echo "Nodes Responded: $NODES_RESPONDED"
    echo "Nodes Total: $NUMBER_OF_NODES"
    if [ "$NODES_RESPONDED" -lt "$NUMBER_OF_NODES" ]; then
        MISSED=$(( NUMBER_OF_NODES - NODES_RESPONDED ))
        echo "WARNING: $MISSED node(s) did not respond"
    fi
    echo ""
    echo "UNASSIGNED TRANSACTION REASONS:"
    echo "  - Transaction pool not full (threshold: ${TRANSACTION_THRESHOLD})"
    echo "  - Consensus not reached for pending blocks"
    echo "  - Block creation in progress"
    echo "  - Test duration ended before block finalization"
} | tee "${SUMMARY_FILE}" | tee -a server.log > /dev/null

# MEDIAN_ROUND_MS was eval'd inside the pipeline subshell above, so it didn't
# propagate.  Recover it from the debug file written inside the same subshell.
if [ -f "${RESULTS_DIR}/pyagg-debug-${TIMESTAMP}.txt" ]; then
    _MRM=$(grep '^MEDIAN_ROUND_MS=' "${RESULTS_DIR}/pyagg-debug-${TIMESTAMP}.txt" | cut -d= -f2)
    [ -n "${_MRM}" ] && MEDIAN_ROUND_MS="${_MRM}"
fi

# ── Heartbeat floor: guard against OOM-killed nodes restarting and returning 0 ──
if [ -f "${_HEARTBEAT_FILE}" ] && [ -f "${SUMMARY_FILE}" ]; then
    _HB_RESULT=$(python3 - "${_HEARTBEAT_FILE}" << 'HBPYEOF'
import json, sys
try:
    lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
    best = max(lines, key=lambda l: l.get('total_blocks', 0), default={})
    print(best.get('total_blocks', 0))
    print(best.get('total_tx', 0))
except Exception:
    print(0); print(0)
HBPYEOF
    )
    _HB_MAX_BLOCKS=$(echo "$_HB_RESULT" | sed -n '1p')
    _HB_MAX_TX=$(echo "$_HB_RESULT" | sed -n '2p')
    _SUMMARY_BLOCKS=$(grep "Total Normal Blocks Created:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
    if [ "${_HB_MAX_BLOCKS:-0}" -gt "${_SUMMARY_BLOCKS:-0}" ]; then
        log "WARN: HTTP stats reported ${_SUMMARY_BLOCKS} blocks but heartbeat captured ${_HB_MAX_BLOCKS} — using heartbeat floor (OOM kills likely reset node counters)"
        sed -i "s/Total Normal Blocks Created: ${_SUMMARY_BLOCKS}/Total Normal Blocks Created: ${_HB_MAX_BLOCKS}/" "${SUMMARY_FILE}"
        _SUMMARY_TX=$(grep "Total Transactions in Blocks:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
        if [ "${_HB_MAX_TX:-0}" -gt "${_SUMMARY_TX:-0}" ]; then
            sed -i "s/Total Transactions in Blocks: ${_SUMMARY_TX}/Total Transactions in Blocks: ${_HB_MAX_TX}/" "${SUMMARY_FILE}"
        fi
    fi
fi

log "${GREEN}✓ Statistics collected${NC}"
echo

# Step 5: Parse JMeter results
write_phase "step5: parsing JMeter results"
log "${BLUE}Step 5: Parsing JMeter results...${NC}"
if [ -f "${RESULTS_FILE}" ]; then
    {
        echo "Metric,Value"
        TOTAL=$(awk -F',' 'NR>1 {count++} END {print count+0}' "${RESULTS_FILE}")
        echo "Total Samples,$TOTAL"
        
        # Calculate average response time
        AVG_TIME=$(awk -F',' 'NR>1 {sum+=$2; count++} END {if(count>0) print int(sum/count); else print 0}' "${RESULTS_FILE}")
        echo "Average Response Time (ms),$AVG_TIME"
        
        # Calculate success rate
        SUCCESS=$(awk -F',' 'NR>1 && $8=="true" {count++} END {print count+0}' "${RESULTS_FILE}")
        if [ "$TOTAL" -gt 0 ]; then
            SUCCESS_RATE=$(echo "scale=2; $SUCCESS * 100 / $TOTAL" | bc)
        else
            SUCCESS_RATE=0
        fi
        echo "Success Rate (%),$SUCCESS_RATE"
        
        # Calculate throughput over the full test window (including ramp-down) so
        # comparisons across runs with different ramp-down settings stay fair.
        if [ "$JMETER_DURATION" -gt 0 ]; then
            THROUGHPUT=$(echo "scale=2; $TOTAL / $JMETER_DURATION" | bc)
        else
            THROUGHPUT=0
        fi
        echo "Throughput (req/s),$THROUGHPUT"
        
        # Add blockchain metrics from summary
        if [ -f "${SUMMARY_FILE}" ]; then
            # Count /transaction requests: use label col (col 3) since TCP-refused
            # requests never reach the server so the URL col (col 14) is empty for them.
            # This gives the true total fired count including failed connections.
            JMETER_FIRED=$(awk -F',' 'NR>1 && $3 ~ /HTTP Request/ {count++} END {print count+0}' "${RESULTS_FILE}")
            BLOCKS=$(grep "Total Normal Blocks Created:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            TX_IN_BLOCKS=$(grep "Total Transactions in Blocks:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            VERIFICATION_TX_IN_BLOCKS=$(grep "Total Verification Transactions in Blocks:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            UNASSIGNED=$(grep "Total Unassigned Transactions:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            VERIFICATION_UNASSIGNED=$(grep "Total Verification Unassigned Transactions:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            BLOCKS=${BLOCKS:-0}
            TX_IN_BLOCKS=${TX_IN_BLOCKS:-0}
            VERIFICATION_TX_IN_BLOCKS=${VERIFICATION_TX_IN_BLOCKS:-0}
            UNASSIGNED=${UNASSIGNED:-0}
            VERIFICATION_UNASSIGNED=${VERIFICATION_UNASSIGNED:-0}
            NODES_RESPONDED_VAL=$(grep "Nodes Responded:" "${SUMMARY_FILE}" | tail -1 | awk '{print $NF}')
            NODES_RESPONDED_VAL=${NODES_RESPONDED_VAL:-0}

            # No duplicate correction needed: verification transactions are tracked
            # separately (verificationTransactions in getTotal()) and excluded from
            # TX_IN_BLOCKS, so the raw count is already the true normal TX count.

            echo "Transactions Fired by Test,${JMETER_FIRED:-0}"
            echo "Total Blocks Created,${BLOCKS:-0}"
            echo "Transactions in Blocks,${TX_IN_BLOCKS}"
            echo "Verification Transactions in Blocks,${VERIFICATION_TX_IN_BLOCKS}"
            echo "Unassigned Transactions,${UNASSIGNED}"
            echo "Verification Unassigned Transactions,${VERIFICATION_UNASSIGNED}"

            # Drain Rate: fraction of fired transactions that made it into blocks.
            # Broken-shard nodes are excluded from stats collection above, so TX_IN_BLOCKS
            # only counts healthy-shard commits and stays within [0, 100].
            if [ "${JMETER_FIRED:-0}" -gt 0 ]; then
                DRAIN_RATE=$(echo "scale=2; ${TX_IN_BLOCKS:-0} * 100 / ${JMETER_FIRED}" | bc)
                echo "Drain Rate (%),${DRAIN_RATE}"
            fi
            
            # Calculate block efficiency
            if [ "${BLOCKS:-0}" -gt 0 ] && [ "${TX_IN_BLOCKS:-0}" -gt 0 ]; then
                AVG_TX_PER_BLOCK=$(echo "scale=2; $TX_IN_BLOCKS / $BLOCKS" | bc)
                echo "Avg Transactions per Block,$AVG_TX_PER_BLOCK"
            fi
            
            # Blockchain transaction rate over total test+drain time
            if [ "${TOTAL_ELAPSED:-0}" -gt 0 ] && [ "${TX_IN_BLOCKS:-0}" -gt 0 ]; then
                BLOCKCHAIN_TX_RATE=$(echo "scale=2; ${TX_IN_BLOCKS} / ${TOTAL_ELAPSED}" | bc)
                echo "Total Test Elapsed (s),${TOTAL_ELAPSED}"
                echo "Blockchain TX Rate (tx/s),${BLOCKCHAIN_TX_RATE}"
                # Effective TX Rate = Blockchain TX Rate × Drain Fraction
                # = TX_IN_BLOCKS² / (JMETER_FIRED × TOTAL_ELAPSED)
                # Penalizes implementations that score high TX rate by leaving transactions unconfirmed
                if [ "${JMETER_FIRED:-0}" -gt 0 ]; then
                    EFFECTIVE_TX_RATE=$(echo "scale=2; ${TX_IN_BLOCKS} * ${TX_IN_BLOCKS} / (${JMETER_FIRED} * ${TOTAL_ELAPSED})" | bc)
                    echo "Effective TX Rate (tx/s),${EFFECTIVE_TX_RATE}"
                fi
            fi
        fi
        # Per-shard TX rate: confirmed tx/s divided across the number of active shards.
        # Supports the reviewer's request for per-shard throughput comparison to CCS'18.
        NUM_SHARDS=$(( NUMBER_OF_NODES / NUMBER_OF_NODES_PER_SHARD ))
        if [ "${NUM_SHARDS:-0}" -gt 0 ] && [ "${TOTAL_ELAPSED:-0}" -gt 0 ] && [ "${TX_IN_BLOCKS:-0}" -gt 0 ]; then
            PER_SHARD_TX_RATE=$(echo "scale=2; ${TX_IN_BLOCKS} / ${TOTAL_ELAPSED} / ${NUM_SHARDS}" | bc)
            echo "Per-Shard TX Rate (tx/s),${PER_SHARD_TX_RATE}"
        fi
        # Median EMA round time across honest nodes — backs the finality bounds claim.
        echo "Median Round Time (ms),${MEDIAN_ROUND_MS:-0}"
        # Config metadata — read back by compare-performance.sh for the report
        echo "Number of Nodes Used,${NUMBER_OF_NODES}"
        echo "Nodes Per Shard,${NUMBER_OF_NODES_PER_SHARD}"
        echo "Faulty Nodes,${NUMBER_OF_FAULTY_NODES}"
        echo "Nodes Responded,${NODES_RESPONDED_VAL:-${NUMBER_OF_NODES}}"
    } > "${STATS_FILE}"
    
    log "${GREEN}✓ Results parsed${NC}"
    echo
fi

# Display summary
log "${BLUE}========================================${NC}"
log "${BLUE}Performance Test Complete!${NC}"
log "${BLUE}========================================${NC}"
log "Results saved to:"
log "  - Summary: ${SUMMARY_FILE}"
log "  - Stats: ${STATS_FILE}"
log "  - Raw data: ${RESULTS_FILE}"
log "  - HTML Report: ${RESULTS_DIR}/pbft-enhanced-${TIMESTAMP}-report/index.html"
echo

if [ -f "${STATS_FILE}" ]; then
    log "${GREEN}Quick Stats:${NC}"
    cat "${STATS_FILE}" | tee -a server.log
fi

log "${BLUE}========================================${NC}"
