// Protocol Configuration - Deployed Contracts on Base Mainnet

export const ADDRESSES = {
  // Deployed Protocol Tokens
  GGX: '0x483e1E0c3faA7b901d3FFa7a201efD1328309f9d',
  GGXU: '0xedB6A71e10A2Cc3D8bC3f992a1fb8F1e7da0D490',
  BOARDROOM: '0x3Cdf4434aef68E2790f7b130E6CE6053Bcc61FBE',
  FARM: '0xcEBcA374c60877AE2131bDA5E5b34AC280d0381b',
  
  // External tokens on Base Mainnet
  ESHARE: '0xb7C10146bA1b618956a38605AB6496523d450871',
  RAGE: '0xc0df50143EA93AeC63e38A6ED4E92B378079eA15',
  
  // External addresses (configure after deployment)
  BACKING_FUND: '0x0000000000000000000000000000000000000000',
  PARTNER_FUND: '0x0000000000000000000000000000000000000000',
} as const

// Protocol parameters
export const PROTOCOL_PARAMS = {
  EXIT_FEE_BPS: 5000, // 50% exit fee
  TAX_BPS: 600, // 6% mint/redeem tax
  MAX_SUPPLY: 69000, // GGXU max supply
  BOOTSTRAP_EPOCHS: 21, // Bootstrap period
  BOOTSTRAP_EMISSION: 50, // GGX per epoch during bootstrap
  NORMAL_EMISSION: 10, // GGX per epoch after bootstrap
  REWARD_DEADLINE: 69, // Epochs to claim rewards
  BLOCKS_PER_EPOCH: 600, // ~2 hours on Base
} as const

// LP Token addresses (create on Uniswap after launch)
export const LP_TOKENS = {
  GGX_ESHARE: '0x0000000000000000000000000000000000000000',
  GGX_GGXU: '0x0000000000000000000000000000000000000000',
  GGX_RAGE: '0x0000000000000000000000000000000000000000',
} as const

// Farm pool allocation points
export const POOL_ALLOCATIONS = {
  GGX_ESHARE: 30, // 30x multiplier
  GGX_GGXU: 20, // 20x multiplier
  GGX_RAGE: 10, // 10x multiplier
} as const
