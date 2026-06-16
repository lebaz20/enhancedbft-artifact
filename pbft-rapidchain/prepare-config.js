const fs = require('fs')
const yaml = require('js-yaml')
// Create a write stream to your desired log file
const logStream = fs.createWriteStream('server.log', { flags: 'a' }) // 'a' = append

// Redirect console.log and console.error
console.log = function (...arguments_) {
  logStream.write(`[LOG ${new Date().toISOString()}] ${arguments_.join(' ')}\n`)
  process.stdout.write(`[LOG] ${arguments_.join(' ')}\n`) // Optional: also log to terminal
}

console.error = function (...arguments_) {
  logStream.write(`[ERROR ${new Date().toISOString()}] ${arguments_.join(' ')}\n`)
  process.stderr.write(`[ERROR] ${arguments_.join(' ')}\n`)
}

// ulimit -n 1228800
// sudo sysctl -w kern.maxfiles=1228800
// sudo sysctl -w kern.maxfilesperproc=614400
// for port in {3001..3032}; do lsof -ti tcp:$port; done | xargs -r kill -9
const NUMBER_OF_NODES = Number(process.env.NUMBER_OF_NODES)
const TRANSACTION_THRESHOLD = Number(process.env.TRANSACTION_THRESHOLD)
const BLOCK_THRESHOLD = Number(process.env.BLOCK_THRESHOLD)
const NUMBER_OF_FAULTY_NODES = Number(process.env.NUMBER_OF_FAULTY_NODES)
const NUMBER_OF_NODES_PER_SHARD = Number(process.env.NUMBER_OF_NODES_PER_SHARD)
const DEFAULT_TTL = Number(process.env.DEFAULT_TTL) || 6
const CPU_LIMIT = Number(process.env.CPU_LIMIT)
const HAS_COMMITTEE_SHARD = Number(process.env.HAS_COMMITTEE_SHARD) === 1 ? 'true' : 'false'
const SHOULD_REDIRECT_FROM_FAULTY_NODES =
  Number(process.env.SHOULD_REDIRECT_FROM_FAULTY_NODES) === 1 ? 'true' : 'false'

const coreServerPort = 4999

const shuffleArray = (array) => {
  const copy = array.slice() // don't modify original
  for (let index = copy.length - 1; index > 0; index--) {
    const index_ = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[index_]] = [copy[index_], copy[index]] // swap
  }
  return copy
}

const splitIntoShardsWithRemaining = (array) => {
  const result = []
  let index = 0

  while (array.length - index >= NUMBER_OF_NODES_PER_SHARD) {
    result.push(array.slice(index, index + NUMBER_OF_NODES_PER_SHARD))
    index += NUMBER_OF_NODES_PER_SHARD
  }

  // Last group with remaining nodes
  result[result.length - 1] = [...result[result.length - 1], ...array.slice(index)]

  return result
}

const getRandomIndicesArrays = (array) => {
  const indices = Array.from({ length: array.length }, (_, index) => index)
  const shuffledArray = shuffleArray(indices)
  const shards = splitIntoShardsWithRemaining(shuffledArray)
  // Adversarial placement: concentrate f+1 faulty nodes into consecutive shards to
  // break the maximum number of shards. For 4-node shards f=floor((4-1)/3)=1, so
  // placing 2 faulty in a shard breaks its consensus — worst case for the protocol.
  const faultyPerShardToBreak = Math.floor(NUMBER_OF_NODES_PER_SHARD / 3) + 1
  const faultyNodes = []
  for (const shard of shards) {
    const toTake = Math.min(faultyPerShardToBreak, NUMBER_OF_FAULTY_NODES - faultyNodes.length)
    if (toTake <= 0) break
    faultyNodes.push(...shard.slice(0, toTake))
  }
  // Identify healthy shards — those with fewer faulty nodes than the break threshold.
  // Honest nodes inside a broken shard cannot make consensus progress, so they are
  // poor committee members: they spend time on shard PBFT that never completes.
  // Restricting the pool to healthy-shard honest nodes maximises committee throughput.
  const healthyShardNodes = new Set(
    shards
      .filter(
        (shard) => shard.filter((n) => faultyNodes.includes(n)).length < faultyPerShardToBreak
      )
      .flat()
      .filter((n) => !faultyNodes.includes(n))
  )
  const committeeShard = HAS_COMMITTEE_SHARD
    ? shuffleArray([...healthyShardNodes]).slice(0, NUMBER_OF_NODES_PER_SHARD)
    : []
  return { shards, faultyNodes, committeeShard }
}

const {
  shards: nodesSubsets,
  faultyNodes,
  committeeShard: committeeSubset
} = getRandomIndicesArrays(Array.from({ length: NUMBER_OF_NODES }, (_, index) => index))
console.log(nodesSubsets, faultyNodes)
const environmentArray = []
// Save environmentVariables to a yml file
const environmentFile = 'nodesEnv.yml'
const kubeFile = 'kubeConfig.yml'
const committeeSubnetIndex = 'SUBSET_COMMITTEE'
nodesSubsets.forEach((nodesSubset, subsetIndex) => {
  console.log(
    'Subset PBFT nodes:',
    nodesSubset.map((index) => parseInt(index, 10) + 5001)
  )
  for (let index = 0; index < NUMBER_OF_NODES; index++) {
    const environmentVariables = {
      // ...process.env, // Keep existing environment variables
      SECRET: `NODE${index}`,
      IS_FAULTY: faultyNodes.includes(index),
      SHOULD_REDIRECT_FROM_FAULTY_NODES,
      P2P_PORT: 5001 + index,
      HTTP_PORT: 3001 + index,
      TRANSACTION_THRESHOLD,
      BLOCK_THRESHOLD,
      NUMBER_OF_NODES_PER_SHARD: NUMBER_OF_NODES_PER_SHARD,
      NUMBER_OF_NODES: NUMBER_OF_NODES,
      NODES_SUBSET: JSON.stringify(nodesSubset),
      SUBSET_INDEX: `SUBSET${subsetIndex + 1}`,
      COMMITTEE_SUBSET_INDEX: committeeSubnetIndex,
      CORE: `ws://core-server:${coreServerPort}`,
      CPU_LIMIT,
      DEFAULT_TTL
    }

    if (index > 0) {
      const peers = Array.from(
        { length: index },
        (_, index_) => `ws://p2p-server-${index_}:${index_ + 5001}`
      )
      const peersSubset = []
      const committeePeersSubset = []
      committeeSubset.forEach((index) => {
        // Check if index is within bounds of peers array
        if (index < peers.length && peers[index]) {
          committeePeersSubset.push(peers[index])
        }
      })
      nodesSubset.forEach((index) => {
        // Check if index is within bounds of peers array
        if (index < peers.length && peers[index]) {
          peersSubset.push(peers[index])
        }
      })
      if (committeePeersSubset.length > 0 && committeeSubset.includes(index)) {
        environmentVariables.COMMITTEE_PEERS = committeePeersSubset.join(',')
      }
      // Set COMMITTEE_SUBSET for ALL committee members regardless of whether they have
      // lower-indexed committee peers. Without this, the lowest-indexed committee member
      // gets COMMITTEE_SUBSET=[] and never calls connectToCore(true), making it invisible
      // to the core's committee broadcast.
      if (committeeSubset.includes(index)) {
        environmentVariables.COMMITTEE_SUBSET = JSON.stringify(committeeSubset)
      }
      if (peersSubset.length > 0 && nodesSubset.includes(index)) {
        environmentVariables.PEERS = peersSubset.join(',')
      }
    }

    if (nodesSubset.includes(index)) {
      environmentArray.push(environmentVariables)
    }
  }
})

environmentArray.sort((a, b) => a.HTTP_PORT - b.HTTP_PORT)

fs.writeFileSync(environmentFile, yaml.dump(environmentArray))

const memory = '256Mi'
const cpu = `${Number(CPU_LIMIT) * 1000}m`
// Build array of individual k8s resources (pods + services).
// Written as multi-document YAML (--- separators) instead of a single kind:List
// so kubectl apply processes each resource individually — avoids API server
// payload size limits that silently drop items at 512+ nodes.
const k8sItems = [
  ...environmentArray.flatMap((environmentVariables, index) => [
    {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: `p2p-server-${index}`,
        labels: { app: 'p2p-server', domain: 'blockchain' }
      },
      spec: {
        ...(process.env.USE_HOST_NETWORK === 'true'
          ? { hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet' }
          : {}),
        containers: [
          {
            name: 'p2p-server',
            image: 'lebaz20/blockchain-rapidchain-p2p-server:latest',
            imagePullPolicy: 'Never',
            resources: {
              limits: {
                memory,
                cpu
              }
            },
            env: Object.entries(environmentVariables).map(([key, value]) => ({
              name: key,
              value: String(value)
            })),
            ports: [
              {
                containerPort: environmentVariables.HTTP_PORT
                  ? Number(environmentVariables.HTTP_PORT)
                  : 3001
              },
              {
                containerPort: environmentVariables.P2P_PORT
                  ? Number(environmentVariables.P2P_PORT)
                  : 5001
              }
            ],
            readinessProbe: {
              httpGet: {
                path: '/health',
                port: environmentVariables.HTTP_PORT ? Number(environmentVariables.HTTP_PORT) : 3001
              },
              initialDelaySeconds: 10,
              periodSeconds: 10,
              timeoutSeconds: 5,
              failureThreshold: 6
            }
          }
        ],
        restartPolicy: 'OnFailure'
      }
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: `p2p-server-${index}`,
        labels: { app: 'p2p-server', domain: 'blockchain' }
      },
      spec: {
        clusterIP: 'None',
        selector: {
          app: 'p2p-server'
        },
        ports: [
          {
            name: environmentVariables.P2P_PORT.toString(),
            protocol: 'TCP',
            port: environmentVariables.P2P_PORT ? Number(environmentVariables.P2P_PORT) : 5001,
            targetPort: environmentVariables.P2P_PORT ? Number(environmentVariables.P2P_PORT) : 5001
          },
          {
            name: environmentVariables.HTTP_PORT.toString(),
            protocol: 'TCP',
            port: environmentVariables.HTTP_PORT ? Number(environmentVariables.HTTP_PORT) : 3001,
            targetPort: environmentVariables.HTTP_PORT
              ? Number(environmentVariables.HTTP_PORT)
              : 3001
          }
        ]
      }
    }
  ]),
  {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `core-server`,
      labels: { app: 'core-server', domain: 'blockchain' }
    },
    spec: {
      ...(process.env.USE_HOST_NETWORK === 'true'
        ? { hostNetwork: true, dnsPolicy: 'ClusterFirstWithHostNet' }
        : {}),
      containers: [
        {
          name: 'core-server',
          image: 'lebaz20/blockchain-rapidchain-core-server:latest',
          imagePullPolicy: 'Never',
          resources: {
            limits: {
              memory,
              cpu
            }
          },
          env: [
            {
              name: 'SHOULD_REDIRECT_FROM_FAULTY_NODES',
              value: String(SHOULD_REDIRECT_FROM_FAULTY_NODES)
            },
            {
              name: 'COMMITTEE_SUBSET_INDEX',
              value: String(committeeSubnetIndex)
            },
            {
              name: 'BLOCK_THRESHOLD',
              value: String(BLOCK_THRESHOLD)
            }
          ],
          ports: [{ containerPort: coreServerPort }]
        }
      ],
      restartPolicy: 'OnFailure'
    }
  },
  {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'core-server',
      labels: { app: 'core-server', domain: 'blockchain' }
    },
    spec: {
      clusterIP: 'None',
      selector: {
        app: 'core-server'
      },
      ports: [
        {
          name: coreServerPort.toString(),
          protocol: 'TCP',
          port: coreServerPort,
          targetPort: coreServerPort
        }
      ]
    }
  }
]
fs.writeFileSync(kubeFile, k8sItems.map((item) => yaml.dump(item)).join('---\n'))

// Exclude faulty nodes from JMeter targeting — they accept TX but never commit
// them, so including them introduces random variance based on how many faulty
// ports happen to get high weights. Filtering them out makes results consistent.
const ports = environmentArray
  .filter((environment) => !environment.IS_FAULTY)
  .map((environment) => environment.HTTP_PORT)
const weights = ports.map(() => Math.floor(Math.random() * 10) + 1) // random weight 1-10

const weightedPorts = []
ports.forEach((endpoint, index) => {
  for (let w = 0; w < weights[index]; w++) {
    weightedPorts.push(endpoint)
  }
})

// Write weighted ports to CSV for JMeter
fs.writeFileSync('jmeter_ports.csv', weightedPorts.join('\n'))
