# EnhancedBFT — Reproducibility Artefact

This repository accompanies the paper:

> **EnhancedBFT: Optimizing Byzantine Consensus for Blockchains via Sharding, Pipelining, and Fault-Adaptive Recovery — A Same-Implementation Comparison Against RapidChain on Single-Shard Workloads**
> Mohamed Labib, Heba Aslan, Tamer Arafa.
> Information Technology and Computer Science (ITCS), Nile University, Egypt.

It contains the source code, configuration, and a representative run that produced the headline numbers reported in the paper.

---

## What is in this repository

```
.
├── README.md                  — this file
├── LICENSE                    — MIT
├── CITATION.cff               — citation metadata (rendered by GitHub)
├── .zenodo.json               — Zenodo metadata for the archived release
├── pbft-enhanced/             — EnhancedBFT source code (verification ring,
│                                shard-merge protocol, EMA-adaptive timing,
│                                depth-5 pipelining)
├── pbft-rapidchain/           — Same-implementation RapidChain baseline
│                                (two-tier shard + committee consensus). Audited
│                                line-by-line in Tables III and IV of the paper.
└── representative-run/        — The 512-node AWS EKS run from which the
                                 percentile latencies and event counts in
                                 Section V-E-4 of the paper were extracted.
```

Both `pbft-enhanced/` and `pbft-rapidchain/` have their own `README.md` with build/run instructions.

---

## How to reproduce a run

### Local (single host, small cluster)

```bash
cd pbft-enhanced       # or pbft-rapidchain
npm install            # or pnpm install
node prepare-config.js
./start.sh             # spins up local pods via k3d or kind
./run-performance-test.sh
```

The JMeter test plan (`Test Plan.jmx`) is included in each system folder.

### AWS EKS (the configuration used in the paper)

1. Provision an EKS cluster. The paper used a 512-node cluster with 200 m CPU and 256 MiB memory per pod (`kubeConfig.yml`).
2. Apply the manifests under `pbft-enhanced/` or `pbft-rapidchain/` to deploy.
3. Run the JMeter test plan against the load-balancer endpoint.
4. Collect the per-pod summaries and the comparison markdown that the test harness emits.

Per-scale parameters (16, 32, 64, 128, 256, 512 nodes) are in Table VII of the paper.

---

## What is in `representative-run/`

This is the 512-node run from `2026-04-14` whose numbers appear in:

- Table VIII (Goodput / Confirmed-Transaction Throughput)
- Table IX (HTTP percentile latencies — computed from the `.jtl` files in this folder)
- Section V-E-4 (Protocol-Event Counts)

```
representative-run/
├── performance-comparison-20260414_135311.md   — the head-to-head report
├── comparison-run.log                           — full harness log
├── pods-not-running.txt                         — pod liveness snapshot
├── pbft-enhanced-server.log                     — EnhancedBFT pod log
│                                                  (merge events, view changes, redirects)
├── pbft-rapidchain-server-events.log            — extracted REDISTRIBUTE /
│                                                  view-change / merge events from
│                                                  the RapidChain pod log (full
│                                                  log is 353 MB, omitted here;
│                                                  available on request)
├── pbft-enhanced-config/                        — runtime config snapshot
├── pbft-rapidchain-config/                      — runtime config snapshot
├── pbft-enhanced-results/                       — JMeter outputs
│   ├── pbft-enhanced-20260414_135311.jtl              — raw JTL sample trace
│   ├── pbft-enhanced-20260414_135311-stats.csv        — derived statistics
│   └── pbft-enhanced-20260414_135311-summary.txt      — per-shard summary
└── pbft-rapidchain-results/                     — JMeter outputs (same shape)
```

### Reproducing the percentile latencies in Table IX

The percentiles in the paper's Table IX were computed directly from the `.jtl` files:

```bash
cd representative-run/pbft-enhanced-results
awk -F',' 'NR>1 && $3=="HTTP Request" {print $2}' pbft-enhanced-20260414_135311.jtl \
  | sort -n \
  | python3 -c "
import sys
lats = [int(x) for x in sys.stdin]
n = len(lats)
print(f'p50={lats[int(n*0.5)]}  p90={lats[int(n*0.9)]}  '
      f'p95={lats[int(n*0.95)]}  p99={lats[int(n*0.99)]}  '
      f'mean={sum(lats)/n:.1f}')"
```

Repeat the same on `representative-run/pbft-rapidchain-results/` to get the baseline percentiles. Numbers in the paper match within rounding.

### Reproducing the event counts in Section V-E-4

```bash
# 42 distinct merged shards (84 events: each merge logged once at plan + once at apply)
grep "SHARD MERGE APPLIED" representative-run/pbft-enhanced-server.log | \
  grep -oE "MERGED_[0-9]+" | sort -u | wc -l

# 3 view-change events
grep -c "VIEW CHANGE" representative-run/pbft-enhanced-server.log

# 336 redirect directives
grep -c "REDIRECT" representative-run/pbft-enhanced-server.log

# 14 redistribution events on the baseline
grep -c "REDISTRIBUTE" representative-run/pbft-rapidchain-server-events.log
```

---

## Implementation fidelity audit

The RapidChain reimplementation under `pbft-rapidchain/` is audited row-by-row against the published RapidChain specification (Zamani, Movahedi, Raykova, CCS 2018) in **Tables III and IV** of the paper. The cited line numbers in the audit refer to files in this repository — for example:

| Paper claim                                | File / lines                                                                           |
|--------------------------------------------|----------------------------------------------------------------------------------------|
| Two-tier consensus (shard + committee)     | `pbft-rapidchain/services/coreserver.js` lines 211–244                                 |
| Three-phase PBFT (pre-prepare/prepare/commit) | `pbft-rapidchain/services/p2pserver.js` lines 744, 768, 789                         |
| 2*f*+1 quorum checks                       | `pbft-rapidchain/services/p2pserver.js` lines 782, 802                                 |
| PBFT view-change                           | `pbft-rapidchain/services/p2pserver.js` lines 890–920                                  |
| Chunked-gossip IDA                         | `pbft-rapidchain/services/idaGossip.js`                                                |
| Transaction-redistribution workaround      | `pbft-rapidchain/services/p2pserver.js` lines 401–468                                  |
| 25 s block-creation timeout                | `pbft-rapidchain/constants/timeouts.js`                                                |

Reviewers and follow-up researchers are invited to inspect each cited location and confirm or contest the audit.

---

## Citing this artefact

If you use this artefact, please cite **both** the paper and this Zenodo deposit:

```bibtex
@inproceedings{labib2026enhancedbft,
  title  = {{EnhancedBFT}: Optimizing Byzantine Consensus for Blockchains
            via Sharding, Pipelining, and Fault-Adaptive Recovery},
  author = {Labib, Mohamed and Aslan, Heba and Arafa, Tamer},
  year   = {2026},
  note   = {Submitted}
}

@software{labib2026enhancedbft_artefact,
  author = {Labib, Mohamed and Aslan, Heba and Arafa, Tamer},
  title  = {{EnhancedBFT} Reproducibility Artefact},
  year   = {2026},
  doi    = {10.5281/zenodo.XXXXXXX},
  url    = {https://github.com/<your-username>/enhancedbft-artifact}
}
```

The Zenodo DOI is minted automatically when a release is tagged on GitHub via the [GitHub–Zenodo integration](https://docs.github.com/en/repositories/archiving-a-github-repository/referencing-and-citing-content). Replace `XXXXXXX` once the DOI is available.

---

## License

MIT. See `LICENSE`.

---

## Contact

Mohamed Labib — `moh.labib@nu.edu.eg`
Information Technology and Computer Science (ITCS), Nile University, Giza, Egypt.
