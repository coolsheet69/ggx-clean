'use client'

// ============ ASSET PATHS ============
// Logos: place rage-logo.webp and eshare-logo.webp in your /public folder (not project root)
// They are referenced as /eshare-logo.webp and /rage-logo.webp

// ============ RPC FALLBACK CONFIG ============
// If you're seeing loading issues, update your wagmi config (wagmi.ts / providers.tsx) to use:
//   import { http, fallback } from 'wagmi'
//   transport: fallback([
//     http('https://base-rpc.publicnode.com'),
//     http('https://mainnet.base.org'),
//   ])
// =============================================

import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract, useWaitForTransactionReceipt, useSwitchChain, useBalance, useWatchContractEvent, usePublicClient } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { parseUnits, formatUnits, parseAbiItem } from 'viem'
import { base } from 'wagmi/chains'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useChartHistory } from './useChartHistory'
import { 
  TrendingUp, Wallet, Zap, ArrowUpRight, Flame, 
  RefreshCw, Settings, Shield, AlertTriangle, Pause, Play,
  Trash2, DollarSign, MessageCircle, FileText, Copy, Check
} from 'lucide-react'

// ============ LEGACY BURNT VALUES (v1 + v2 + v3 + v4 contracts) ============
// These amounts were burned in the old contracts and must be included in totals
const LEGACY_BURNT = {
  eshare: parseUnits('0.5183', 18),
  rage: parseUnits('0.5183', 18),
}

// ============ CONTRACT ADDRESSES ============
const CONTRACTS = {
  GGX: '0x328f20857c19cC72b5AeD37b301C129fC2CD8f0A' as `0x${string}`,  // GGX v5 — slippage-protected mint + 48h timelocked emergency drain
  GGXZap: '0x6F4a8C77E7a9b697C443d0f24D3f38a679D7a06b' as `0x${string}`,  // ERAGEZapV5_Optimized — QuoterV2 intelligent split + optional rebalance + 0.69% ETH tax
  ESHARE: '0xb7C10146bA1b618956a38605AB6496523d450871' as `0x${string}`,
  RAGE: '0xc0df50143EA93AeC63e38A6ED4E92B378079eA15' as `0x${string}`,
  WETH: '0x4200000000000000000000000000000000000006' as `0x${string}`,
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
  V3_ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481' as `0x${string}`, // Uniswap V3 SwapRouter on Base
  ADMIN: '0x2BDFDd894D0CD04017b7dAb3D4C25E788FDEfd47',
  // LP Pairs for price feeds (Uniswap V3)
  RAGE_LP: '0xd474B32a5a2BF93453996287D361a00f661E04FF' as `0x${string}`,
  ESHARE_LP: '0x0656CDF4539f412F542A8D8a029f7c6c5cE90d7B' as `0x${string}`,
  GGX_LP: '0x4a3a2fB49D1dDe37E8903E99003F74c9e53af421' as `0x${string}`,        // ERAGE-ETH V3 0.3% pool
  GGX_RAGE_LP: '0xE9704Fdc0f184ceD4218DFafF2A302A2D59a0265' as `0x${string}`,   // GGX-RAGE V3 1% side pool
  GGX_ESHARE_LP: '0x1638378e4510FBf274a4a882c7765718359ac28A' as `0x${string}`, // GGX-ESHARE V3 1% side pool
  WETH_USDC_LP: '0x6c561b446416e1a00e8e93e221854d6ea4171372' as `0x${string}`, // WETH/USDC Uniswap V3 on Base (correct pool)
  QUOTER_V2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as `0x${string}`,   // Uniswap V3 QuoterV2 on Base (used by Optimized Zap for intelligent splits)
  ERAGE_RAGE_LP: '0x9e7C2Ce84346d57EdCE3f38A9e6585d4d0317F7d' as `0x${string}`,  // ERAGE-RAGE V3 1% pool
  ERAGE_ESHARE_LP: '0x2CFD00bf5B36C7b4Ff8D45eC3D7254ABA34c881f' as `0x${string}`, // ERAGE-ESHARE V3 1% pool
}

// V3 Fee tiers (in basis points)
const V3_FEES = {
  LOWEST: 100,   // 0.01%
  LOW: 500,      // 0.05% - WETH/USDC common
  MEDIUM: 3000,  // 0.3% - Most common
  HIGH: 10000    // 1%
}

// Pool fee configuration (V3 pools)
const POOL_FEES = {
  WETH_USDC: 500,      // 0.05% - Major pair, typically lowest fee
  WETH_ESHARE: 10000,  // 1% - ESHARE/WETH pool
  USDC_RAGE: 10000,    // 1% - RAGE/USDC pool
  // Note: No direct ESHARE/USDC pool exists. ESHARE↔RAGE routing must go through WETH:
  //   ESHARE → WETH (1%) → USDC (0.05%) → RAGE (1%)
  //   RAGE → USDC (1%) → WETH (0.05%) → ESHARE (1%)
}

/**
 * Encode a V3 swap path
 * @param tokens Array of token addresses in order
 * @param fees Array of fee tiers between each pair
 * @returns Encoded path as hex string
 */
function encodeV3Path(tokens: `0x${string}`[], fees: number[]): `0x${string}` {
  if (tokens.length !== fees.length + 1) {
    throw new Error('Tokens array must be fees.length + 1')
  }
  
  let encoded = '0x'
  
  for (let i = 0; i < tokens.length; i++) {
    // Add token address (20 bytes)
    encoded += tokens[i].slice(2).toLowerCase()
    
    // Add fee between pairs (3 bytes as uint24)
    if (i < fees.length) {
      const fee = fees[i].toString(16).padStart(6, '0')
      encoded += fee
    }
  }
  
  return encoded as `0x${string}`
}

// Pre-computed common paths
const V3_PATHS = {
  // ETH → ESHARE (single hop via WETH)
  ETH_TO_ESHARE: encodeV3Path([CONTRACTS.WETH, CONTRACTS.ESHARE], [POOL_FEES.WETH_ESHARE]),
  
  // ETH → RAGE (multi-hop via USDC): WETH → USDC → RAGE
  ETH_TO_RAGE: encodeV3Path(
    [CONTRACTS.WETH, CONTRACTS.USDC, CONTRACTS.RAGE],
    [POOL_FEES.WETH_USDC, POOL_FEES.USDC_RAGE]
  ),
  
  // ESHARE → RAGE (multi-hop via WETH → USDC) — matches contract's getCommonPaths()
  // There is NO direct ESHARE/USDC pool, must route through WETH first
  ESHARE_TO_RAGE: encodeV3Path(
    [CONTRACTS.ESHARE, CONTRACTS.WETH, CONTRACTS.USDC, CONTRACTS.RAGE],
    [POOL_FEES.WETH_ESHARE, POOL_FEES.WETH_USDC, POOL_FEES.USDC_RAGE]
  ),
  
  // RAGE → ESHARE (multi-hop via USDC → WETH) — matches contract's getCommonPaths()
  // There is NO direct USDC/ESHARE pool, must route through WETH
  RAGE_TO_ESHARE: encodeV3Path(
    [CONTRACTS.RAGE, CONTRACTS.USDC, CONTRACTS.WETH, CONTRACTS.ESHARE],
    [POOL_FEES.USDC_RAGE, POOL_FEES.WETH_USDC, POOL_FEES.WETH_ESHARE]
  ),
}

// ============ ABIs ============
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'Transfer', type: 'event', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
] as const

const PAIR_ABI = [
  // Uniswap V3 Pool ABI
  { name: 'slot0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' }, { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint32' }, { name: 'unlocked', type: 'bool' }] },
  { name: 'liquidity', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

const GGX_ABI = [
  // View functions
  { name: 'getBackingRatio', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'esharePerGGX', type: 'uint256' }, { name: 'ragePerGGX', type: 'uint256' }] },
  { name: 'getBackingBalances', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'eshareBalance', type: 'uint256' }, { name: 'rageBalance', type: 'uint256' }] },
  { name: 'getMintRate', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'mintRate', type: 'uint256' }] },  // MAX(ratio, ggxPerPair) — v4 key function
  { name: 'getMintOutput', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenAmount', type: 'uint256' }], outputs: [{ name: 'ggxOut', type: 'uint256' }, { name: 'mintRate', type: 'uint256' }, { name: 'fixedTax', type: 'uint256' }, { name: 'linearTax', type: 'uint256' }, { name: 'eshareBurnAmt', type: 'uint256' }, { name: 'rageBurnAmt', type: 'uint256' }] },
  { name: 'getRedeemOutput', type: 'function', stateMutability: 'view', inputs: [{ name: 'ggxAmount', type: 'uint256' }], outputs: [{ name: 'eshareOut', type: 'uint256' }, { name: 'rageOut', type: 'uint256' }, { name: 'fixedTaxE', type: 'uint256' }, { name: 'fixedTaxR', type: 'uint256' }, { name: 'linearTaxE', type: 'uint256' }, { name: 'linearTaxR', type: 'uint256' }, { name: 'eshareBurnAmt', type: 'uint256' }, { name: 'rageBurnAmt', type: 'uint256' }] },
  { name: 'ggxPerPair', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'eshareToken', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'rageToken', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'paused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  
  // Tax configuration - SYMMETRIC (same on mint and redeem)
  { name: 'fixedBackingTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },     // 0.12% guaranteed floor creep
  { name: 'linearBackingTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },    // 1.00% primary ratio growth
  { name: 'eshareBurnTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },       // 0.69% ES deflation
  { name: 'rageBurnTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },         // 0.69% RA deflation
  { name: 'totalTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },            // 2.50% total
  { name: 'getRatioPremium', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'esharePremium', type: 'uint256' }, { name: 'ragePremium', type: 'uint256' }] },
  
  // Analytics
  { name: 'totalEshareBackingAdded', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalRageBackingAdded', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalEshareBurned', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalRageBurned', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalMintCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalRedeemCount', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  
  // User functions
  { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenAmount', type: 'uint256' }, { name: 'minGgxOut', type: 'uint256' }], outputs: [{ name: 'ggxOut', type: 'uint256' }] },
  { name: 'redeem', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'ggxAmount', type: 'uint256' }], outputs: [{ name: 'eshareOut', type: 'uint256' }, { name: 'rageOut', type: 'uint256' }] },
  { name: 'burn', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },

  // Admin functions
  { name: 'setGGXPerPair', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_ratio', type: 'uint256' }], outputs: [] },
  { name: 'pause', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'unpause', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'setFixedBackingTaxBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_bps', type: 'uint256' }], outputs: [] },
  { name: 'setLinearBackingTaxBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_bps', type: 'uint256' }], outputs: [] },
  { name: 'setEshareBurnTaxBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_bps', type: 'uint256' }], outputs: [] },
  { name: 'setRageBurnTaxBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_bps', type: 'uint256' }], outputs: [] },
  { name: 'setAllTaxes', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_fixedBps', type: 'uint256' }, { name: '_linearBps', type: 'uint256' }, { name: '_eshareBurnBps', type: 'uint256' }, { name: '_rageBurnBps', type: 'uint256' }], outputs: [] },
  { name: 'rescueToken', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },

  // v5: 3-step emergency drain with 48h timelock
  { name: 'EMERGENCY_DRAIN_DELAY', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'emergencyDrainExecutableAt', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'initiateEmergencyDrain', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'cancelEmergencyDrain', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'executeEmergencyDrain', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

const ZAP_ABI = [
  // ERAGEZapV5_Optimized — QuoterV2 intelligent split + optional rebalance + 0.69% ETH tax
  { name: 'zapFromETH', type: 'function', stateMutability: 'payable', inputs: [{ name: 'esharePath', type: 'bytes' }, { name: 'ragePath', type: 'bytes' }, { name: 'rebalancePath', type: 'bytes' }, { name: 'minErageOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'erageOut', type: 'uint256' }] },
  { name: 'zapFromEshare', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'eshareAmount', type: 'uint256' }, { name: 'ragePath', type: 'bytes' }, { name: 'rebalancePath', type: 'bytes' }, { name: 'minErageOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'erageOut', type: 'uint256' }] },
  { name: 'zapFromRage', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'rageAmount', type: 'uint256' }, { name: 'esharePath', type: 'bytes' }, { name: 'rebalancePath', type: 'bytes' }, { name: 'minErageOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'erageOut', type: 'uint256' }] },
  { name: 'zapFromToken', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'esharePath', type: 'bytes' }, { name: 'ragePath', type: 'bytes' }, { name: 'rebalancePath', type: 'bytes' }, { name: 'minErageOut', type: 'uint256' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'erageOut', type: 'uint256' }] },
  { name: 'zapFromBothTokens', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'eshareAmount', type: 'uint256' }, { name: 'rageAmount', type: 'uint256' }, { name: 'minErageOut', type: 'uint256' }], outputs: [{ name: 'erageOut', type: 'uint256' }] },
  { name: 'getCommonPaths', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'ethToEsharePath', type: 'bytes' }, { name: 'ethToRagePath', type: 'bytes' }, { name: 'eshareToRagePath', type: 'bytes' }, { name: 'rageToEsharePath', type: 'bytes' }] },
  // View functions
  { name: 'erage', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'eshare', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'rage', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'uniswapV3Router', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'quoter', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'weth', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'usdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'adminWallet', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'TAX_BPS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'quoteRefBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'minQuoteRef', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'rebalanceThresholdBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // Preview function (non-view due to quoter, use via eth_call)
  { name: 'previewOptimalSplit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'esharePath', type: 'bytes' }, { name: 'ragePath', type: 'bytes' }, { name: 'ethAmount', type: 'uint256' }], outputs: [{ name: 'ethForEshare', type: 'uint256' }, { name: 'ethForRage', type: 'uint256' }, { name: 'eshareQuote', type: 'uint256' }, { name: 'rageQuote', type: 'uint256' }] },
  // Admin functions
  { name: 'setRouter', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_router', type: 'address' }], outputs: [] },
  { name: 'setQuoter', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_quoter', type: 'address' }], outputs: [] },
  { name: 'setUsdc', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_usdc', type: 'address' }], outputs: [] },
  { name: 'setAdminWallet', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_adminWallet', type: 'address' }], outputs: [] },
  { name: 'setQuoteRefBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_bps', type: 'uint256' }], outputs: [] },
  { name: 'setMinQuoteRef', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_min', type: 'uint256' }], outputs: [] },
  { name: 'setRebalanceThresholdBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_bps', type: 'uint256' }], outputs: [] },
  { name: 'emergencyWithdraw', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'rescueToken', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'rescueETH', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

// ============ UTILITY FUNCTIONS ============
const formatNum = (val: bigint | undefined, dec = 18): string => {
  if (!val) return '0.00'
  const num = parseFloat(formatUnits(val, dec))
  if (num < 0.000001) return '0.000000'
  if (num < 0.01) return num.toFixed(6)
  if (num < 1) return num.toFixed(4)
  if (num < 1000) return num.toFixed(2)
  if (num < 1000000) return `${(num / 1000).toFixed(2)}K`
  return `${(num / 1000000).toFixed(2)}M`
}

const formatRatio = (ratio: bigint | undefined): string => {
  if (!ratio) return '1.0000'
  const num = parseFloat(formatUnits(ratio, 18))
  return num.toFixed(4)
}

const formatPrice = (price: number): string => {
  if (price === 0) return '—'
  if (price < 0.000001) return price.toExponential(2)
  if (price < 0.01) return price.toFixed(6)
  if (price < 1) return price.toFixed(4)
  return price.toFixed(2)
}

// ============ COPY ADDRESS BUTTON ============
function CopyAddr({ address, color }: { address: string; color: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button
      onClick={handleCopy}
      className="absolute top-1 left-1.5 text-[9px] flex items-center gap-0.5 transition-colors z-10"
      style={{ color: copied ? '#10B981' : `${color}99` }}
      title={`Copy ${address}`}
    >
      {copied ? <Check size={8} /> : <Copy size={8} />}
      {copied ? 'Copied' : 'Addr'}
    </button>
  )
}

// ============ RATIO CHART COMPONENT ============
type TimeRange = '4h' | '1d' | '1w' | '2w'

function RatioChart({ 
  history, 
  priceEfficiencyHistory,
  timeRange,
  currentRatio
}: { 
  history: { time: number; ratio: number }[]
  priceEfficiencyHistory?: { time: number; ratio: number }[]
  timeRange: TimeRange
  currentRatio?: number | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dotPosition, setDotPosition] = useState<{ x: number; y: number } | null>(null)
  const animFrameRef = useRef<number>(0)
  
  // Filter history based on time range
  const filteredHistory = useMemo(() => {
    const now = Date.now()
    const cutoff = timeRange === '4h' ? now - 4 * 60 * 60 * 1000 
                 : timeRange === '1d' ? now - 24 * 60 * 60 * 1000 
                 : timeRange === '1w' ? now - 7 * 24 * 60 * 60 * 1000
                 : now - 14 * 24 * 60 * 60 * 1000
    return history.filter(h => h.time >= cutoff)
  }, [history, timeRange])
  
  const filteredPriceEfficiency = useMemo(() => {
    if (!priceEfficiencyHistory) return []
    const now = Date.now()
    const cutoff = timeRange === '4h' ? now - 4 * 60 * 60 * 1000 
                 : timeRange === '1d' ? now - 24 * 60 * 60 * 1000 
                 : timeRange === '1w' ? now - 7 * 24 * 60 * 60 * 1000
                 : now - 14 * 24 * 60 * 60 * 1000
    const filtered = priceEfficiencyHistory.filter(h => h.time >= cutoff)
    
    // Downsample for rendering performance — max ~400 points on the chart
    // Canvas can't resolve more than ~1 point per pixel anyway
    const MAX_RENDER_POINTS = 400
    if (filtered.length <= MAX_RENDER_POINTS) return filtered
    
    const step = filtered.length / MAX_RENDER_POINTS
    const downsampled: { time: number; ratio: number }[] = []
    for (let i = 0; i < MAX_RENDER_POINTS; i++) {
      downsampled.push(filtered[Math.floor(i * step)])
    }
    // Always include the very last point (current value)
    downsampled.push(filtered[filtered.length - 1])
    return downsampled
  }, [priceEfficiencyHistory, timeRange])
  
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || filteredPriceEfficiency.length < 2) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    let pulsePhase = 0

    const drawChart = (phase: number) => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      
      // Guard against zero dimensions
      if (rect.width === 0 || rect.height === 0) return
      
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      
      const width = rect.width
      const height = rect.height
      const padding = { top: 15, right: 50, bottom: 25, left: 50 }
      
      ctx.clearRect(0, 0, width, height)
      
      // Calculate Y range from price efficiency data only
      if (filteredPriceEfficiency.length === 0) return
      
      // For price efficiency, ensure 1.0 and action zones are visible
      const priceEffMin = Math.min(...filteredPriceEfficiency.map(h => h.ratio))
      const priceEffMax = Math.max(...filteredPriceEfficiency.map(h => h.ratio))
      
      // Include action zone thresholds in the range
      let minRatio = Math.min(priceEffMin, 0.95) * 0.98
      let maxRatio = Math.max(priceEffMax, 1.10) * 1.02
      const ratioRange = maxRatio - minRatio || 1
      
      const chartWidth = width - padding.left - padding.right
      const chartHeight = height - padding.top - padding.bottom

      // ── Zone thresholds ──
      const GREEN_ZONE = 1.035
      const RED_ZONE = 0.975

      // ── Green Zone (top): above 1.035 — "Greenzone Efficiency Strategy" ──
      if (filteredPriceEfficiency.length > 0 && maxRatio > GREEN_ZONE) {
        const greenY = padding.top + chartHeight - ((GREEN_ZONE - minRatio) / ratioRange) * chartHeight
        const topY = padding.top
        if (greenY > topY) {
          const gradient = ctx.createLinearGradient(0, topY, 0, greenY)
          gradient.addColorStop(0, 'rgba(16, 185, 129, 0.25)')
          gradient.addColorStop(1, 'rgba(16, 185, 129, 0.06)')
          ctx.fillStyle = gradient
          ctx.fillRect(padding.left, topY, chartWidth, greenY - topY)

          // Green zone label
          ctx.fillStyle = 'rgba(16, 185, 129, 0.85)'
          ctx.textAlign = 'center'
          ctx.font = 'bold 10px sans-serif'
          ctx.fillText('\u{1F7E2} Greenzone Efficiency Strategy', padding.left + chartWidth / 2, topY + 16)
        }
      }

      // ── Blue Neutral Zone: between 0.975 and 1.035 ──
      if (filteredPriceEfficiency.length > 0) {
        const upperY = padding.top + chartHeight - ((GREEN_ZONE - minRatio) / ratioRange) * chartHeight
        const lowerY = padding.top + chartHeight - ((RED_ZONE - minRatio) / ratioRange) * chartHeight
        const topBound = Math.max(upperY, padding.top)
        const bottomBound = Math.min(lowerY, padding.top + chartHeight)
        if (bottomBound > topBound) {
          const gradient = ctx.createLinearGradient(0, topBound, 0, bottomBound)
          gradient.addColorStop(0, 'rgba(59, 130, 246, 0.10)')
          gradient.addColorStop(0.5, 'rgba(59, 130, 246, 0.15)')
          gradient.addColorStop(1, 'rgba(59, 130, 246, 0.10)')
          ctx.fillStyle = gradient
          ctx.fillRect(padding.left, topBound, chartWidth, bottomBound - topBound)
        }
      }

      // ── Red Zone (bottom): below 0.975 — "Redzone Efficiency Strategy" ──
      if (filteredPriceEfficiency.length > 0 && minRatio < RED_ZONE) {
        const redY = padding.top + chartHeight - ((RED_ZONE - minRatio) / ratioRange) * chartHeight
        const bottomY = padding.top + chartHeight
        if (redY < bottomY) {
          const gradient = ctx.createLinearGradient(0, redY, 0, bottomY)
          gradient.addColorStop(0, 'rgba(239, 68, 68, 0.06)')
          gradient.addColorStop(1, 'rgba(239, 68, 68, 0.25)')
          ctx.fillStyle = gradient
          ctx.fillRect(padding.left, redY, chartWidth, bottomY - redY)

          // Red zone label
          ctx.fillStyle = 'rgba(239, 68, 68, 0.85)'
          ctx.textAlign = 'center'
          ctx.font = 'bold 10px sans-serif'
          ctx.fillText('\u{1F534} Redzone Efficiency Strategy', padding.left + chartWidth / 2, bottomY - 8)
        }
      }

      // Draw horizontal grid lines and Y-axis labels
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'
      ctx.lineWidth = 1
      ctx.fillStyle = '#6B7280'
      ctx.font = '9px monospace'
      ctx.textAlign = 'right'
      
      for (let i = 0; i <= 4; i++) {
        const y = padding.top + chartHeight * (i / 4)
        const ratioVal = maxRatio - (ratioRange * i / 4)
        
        ctx.beginPath()
        ctx.moveTo(padding.left, y)
        ctx.lineTo(width - padding.right, y)
        ctx.stroke()
        
        // Skip auto grid labels between 0.95 and 1.05 — we have static labels
        // for 0.975, 1.000, and 1.035 already, so no need for numbers in that range
        if (ratioVal >= 0.95 && ratioVal <= 1.05) continue
        ctx.fillText(ratioVal.toFixed(3), padding.left - 4, y + 3)
      }

      // ── Parity line at 1.000 in blue with dotted line ──
      if (filteredPriceEfficiency.length > 0 && minRatio < 1 && maxRatio > 1) {
        const parityY = padding.top + chartHeight - ((1 - minRatio) / ratioRange) * chartHeight
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)'
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(padding.left, parityY)
        ctx.lineTo(width - padding.right, parityY)
        ctx.stroke()
        ctx.setLineDash([])

        // Blue "1.000" label on left y-axis
        ctx.fillStyle = '#3B82F6'
        ctx.textAlign = 'right'
        ctx.font = 'bold 10px monospace'
        ctx.fillText('1.000', padding.left - 4, parityY + 3)
      }

      // ── 1.035 threshold line (orange dashed) ──
      if (filteredPriceEfficiency.length > 0 && minRatio < 1.035 && maxRatio > 1.035) {
        const threshY = padding.top + chartHeight - ((1.035 - minRatio) / ratioRange) * chartHeight
        ctx.strokeStyle = 'rgba(249, 115, 22, 0.4)'
        ctx.setLineDash([8, 4])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(padding.left, threshY)
        ctx.lineTo(width - padding.right, threshY)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineWidth = 1

        // Label on left side
        ctx.fillStyle = '#F97316'
        ctx.textAlign = 'right'
        ctx.font = '9px sans-serif'
        ctx.fillText('1.035', padding.left - 4, threshY + 3)
      }

      // ── 0.975 threshold line (orange dashed) ──
      if (filteredPriceEfficiency.length > 0 && minRatio < 0.975 && maxRatio > 0.975) {
        const threshY = padding.top + chartHeight - ((0.975 - minRatio) / ratioRange) * chartHeight
        ctx.strokeStyle = 'rgba(249, 115, 22, 0.4)'
        ctx.setLineDash([8, 4])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(padding.left, threshY)
        ctx.lineTo(width - padding.right, threshY)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineWidth = 1

        // Label on left side
        ctx.fillStyle = '#F97316'
        ctx.textAlign = 'right'
        ctx.font = '9px sans-serif'
        ctx.fillText('0.975', padding.left - 4, threshY + 3)
      }

      // Draw X-axis time labels
      ctx.fillStyle = '#6B7280'
      ctx.textAlign = 'center'
      const times = filteredPriceEfficiency.map(h => h.time)
      const minTime = Math.min(...times)
      const maxTime = Math.max(...times)
      
      // Format labels based on time range
      for (let i = 0; i <= 4; i++) {
        const x = padding.left + chartWidth * (i / 4)
        const timeVal = minTime + (maxTime - minTime) * (i / 4)
        const date = new Date(timeVal)
        let label = ''
        if (timeRange === '4h') {
          label = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
        } else if (timeRange === '1d') {
          label = `${date.getHours()}:00`
        } else {
          label = `${date.getMonth() + 1}/${date.getDate()}`
        }
        ctx.fillText(label, x, height - 5)
      }
      
      // ── Draw price efficiency line with pulsing glow ──
      if (filteredPriceEfficiency.length >= 2) {
        const data = filteredPriceEfficiency
        const pulse = 0.5 + 0.5 * Math.sin(phase) // oscillates 0..1

        // Draw gradient fill under the line
        const fillGradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom)
        fillGradient.addColorStop(0, 'rgba(16, 185, 129, 0.2)')
        fillGradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
        
        ctx.beginPath()
        ctx.moveTo(padding.left, height - padding.bottom)
        data.forEach((point, i) => {
          const x = padding.left + chartWidth * (i / (data.length - 1))
          const y = padding.top + chartHeight - ((point.ratio - minRatio) / ratioRange) * chartHeight
          ctx.lineTo(x, y)
        })
        ctx.lineTo(padding.left + chartWidth, height - padding.bottom)
        ctx.closePath()
        ctx.fillStyle = fillGradient
        ctx.fill()

        // Pulsing glow layer (wider, semi-transparent)
        ctx.save()
        ctx.shadowColor = '#10B981'
        ctx.shadowBlur = 4 + 10 * pulse
        ctx.beginPath()
        ctx.strokeStyle = `rgba(16, 185, 129, ${0.15 + 0.25 * pulse})`
        ctx.lineWidth = 4 + 4 * pulse
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        data.forEach((point, i) => {
          const x = padding.left + chartWidth * (i / (data.length - 1))
          const y = padding.top + chartHeight - ((point.ratio - minRatio) / ratioRange) * chartHeight
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.stroke()
        ctx.restore()

        // Core line (solid, always visible)
        ctx.beginPath()
        ctx.strokeStyle = '#10B981'
        ctx.lineWidth = 2
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        data.forEach((point, i) => {
          const x = padding.left + chartWidth * (i / (data.length - 1))
          const y = padding.top + chartHeight - ((point.ratio - minRatio) / ratioRange) * chartHeight
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.stroke()

        // Pulsing dot at the end of the line
        const lastPoint = data[data.length - 1]
        const lastX = padding.left + chartWidth
        const lastY = padding.top + chartHeight - ((lastPoint.ratio - minRatio) / ratioRange) * chartHeight
        
        // Store position for overlay
        setDotPosition({ x: lastX, y: lastY })

        // Outer glow ring (pulsing)
        ctx.save()
        ctx.shadowColor = '#10B981'
        ctx.shadowBlur = 8 + 12 * pulse
        ctx.beginPath()
        ctx.arc(lastX, lastY, 4 + 3 * pulse, 0, 2 * Math.PI)
        ctx.fillStyle = `rgba(16, 185, 129, ${0.3 + 0.4 * pulse})`
        ctx.fill()
        ctx.restore()

        // Core dot
        ctx.beginPath()
        ctx.arc(lastX, lastY, 4, 0, 2 * Math.PI)
        ctx.fillStyle = '#10B981'
        ctx.fill()

        // Inner bright dot
        ctx.beginPath()
        ctx.arc(lastX, lastY, 2, 0, 2 * Math.PI)
        ctx.fillStyle = '#ffffff'
        ctx.fill()

        // Current ratio label — positioned at the FAR RIGHT edge of the canvas
        const ratioText = lastPoint.ratio.toFixed(3)
        ctx.font = 'bold 11px monospace'
        const textWidth = ctx.measureText(ratioText).width
        const pillPadX = 6
        const pillPadY = 4
        const labelY = lastY - 2

        // Pill extends from right edge of canvas leftward
        const pillR = 4
        const pillW = textWidth + pillPadX * 2
        const pillH = 16 + pillPadY
        const pillRightEdge = width - 4
        const pillX = pillRightEdge - pillW
        const pillY = labelY - 8 - pillPadY

        // Background pill
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)'
        ctx.beginPath()
        ctx.moveTo(pillX + pillR, pillY)
        ctx.lineTo(pillX + pillW - pillR, pillY)
        ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + pillR)
        ctx.lineTo(pillX + pillW, pillY + pillH - pillR)
        ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - pillR, pillY + pillH)
        ctx.lineTo(pillX + pillR, pillY + pillH)
        ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - pillR)
        ctx.lineTo(pillX, pillY + pillR)
        ctx.quadraticCurveTo(pillX, pillY, pillX + pillR, pillY)
        ctx.closePath()
        ctx.fill()

        // Border
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)'
        ctx.lineWidth = 1
        ctx.stroke()

        // Text — left-aligned within pill
        ctx.fillStyle = '#10B981'
        ctx.textAlign = 'left'
        ctx.fillText(ratioText, pillX + pillPadX, labelY)
      }
    }
    
    // Animation loop for pulsing effect
    const animate = () => {
      pulsePhase += 0.04
      drawChart(pulsePhase)
      animFrameRef.current = requestAnimationFrame(animate)
    }
    animFrameRef.current = requestAnimationFrame(animate)
    
    // Handle resize
    const handleResize = () => drawChart(pulsePhase)
    window.addEventListener('resize', handleResize)
    return () => {
      cancelAnimationFrame(animFrameRef.current)
      window.removeEventListener('resize', handleResize)
    }
  }, [filteredHistory, filteredPriceEfficiency, timeRange])
  
  // Show placeholder if not enough price efficiency data
  if (filteredPriceEfficiency.length < 2) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 text-xs">
        {priceEfficiencyHistory && priceEfficiencyHistory.length === 0 
          ? 'Waiting for Uniswap price data...' 
          : 'Collecting more data points...'}
      </div>
    )
  }
  
  return (
    <div ref={containerRef} className="relative w-full h-full">
      <canvas ref={canvasRef} className="w-full h-full" style={{ width: '100%', height: '100%' }} />
      {/* Pulsing dot */}
      {dotPosition && currentRatio !== null && currentRatio !== undefined && (
        <div 
          className="absolute pointer-events-none"
          style={{ 
            left: dotPosition.x, 
            top: dotPosition.y,
            transform: 'translate(-50%, -50%)'
          }}
        >
          <div className="relative">
            <div className="w-3.5 h-3.5 rounded-full bg-[#10B981] animate-ping absolute top-0 left-0" />
            <div className="w-3.5 h-3.5 rounded-full bg-[#10B981] relative" />
          </div>
        </div>
      )}
    </div>
  )
}

// ============ SWAP WIDGET ============
function UniswapWidget({ ggxAddress }: { ggxAddress: string }) {
  return (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden', borderRadius: '12px', position: 'relative' }}>
      <iframe
        src={`https://switch.win/widget?network=base&background_color=0a0a0b&font_color=ffffff&secondary_font_color=6b7280&border_color=FF6B35&backdrop_color=transparent&from=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee&to=${ggxAddress}`}
        allow="clipboard-read; clipboard-write"
        style={{
          border: 'none',
          width: '125%',
          height: '760px',
          transform: 'scale(0.80)',
          transformOrigin: 'top left',
          borderRadius: '12px',
        }}
      />
    </div>
  )
}

// ============ MAIN COMPONENT ============
export default function Dashboard() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
    // Set tab title & favicon
    document.title = 'ERAGE Protocol'
    const existingFavicon = document.querySelector("link[rel*='icon']")
    if (existingFavicon) {
      existingFavicon.setAttribute('href', '/ERAGE-logo.webp')
    } else {
      const link = document.createElement('link')
      link.rel = 'icon'
      link.href = '/ERAGE-logo.webp'
      document.head.appendChild(link)
    }
  }, [])
  
  const { address, isConnected, chain } = useAccount()
  const { connectors, connect, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  
  useEffect(() => {
    if (mounted && isConnected && chain?.id !== base.id) {
      switchChain?.({ chainId: base.id })
    }
  }, [mounted, isConnected, chain, switchChain])
  
  const isAdmin = useMemo(() => 
    address?.toLowerCase() === CONTRACTS.ADMIN.toLowerCase(), 
    [address]
  )
  
  // ============ STATE ============
  const [inputToken, setInputToken] = useState<'ETH' | 'ESHARE_RAGE' | 'GGX'>('ETH')
  const [inputAmount, setInputAmount] = useState('')
  const [eshareInput, setEshareInput] = useState('')
  const [rageInput, setRageInput] = useState('')

  // Slippage tolerance for mint/zap — v5.1 auto-slippage
  // Computed per-trade based on trade size vs pool liquidity. Hard capped at 15%.
  // Users can override via the "Adjust" input. Auto uses MAX(11%, 11% + pool_consumption_pct).
  const SLIPPAGE_MAX_PCT = 15
  const SLIPPAGE_MIN_PCT = 11
  const [slippageMode, setSlippageMode] = useState<'auto' | 'manual'>('auto')
  const [slippageManual, setSlippageManual] = useState('11')

  const [showAdmin, setShowAdmin] = useState(false)
  const [adminTab, setAdminTab] = useState<'ggx' | 'zap' | 'rescue'>('ggx')
  
  // Admin inputs
  const [newRatio, setNewRatio] = useState('')
  const [newFixedBackingTax, setNewFixedBackingTax] = useState('')
  const [newLinearBackingTax, setNewLinearBackingTax] = useState('')
  const [newEshareBurnTax, setNewEshareBurnTax] = useState('')
  const [newRageBurnTax, setNewRageBurnTax] = useState('')
  const [rescueToken, setRescueToken] = useState('')
  const [rescueAmount, setRescueAmount] = useState('')
  const [burnErageAmount, setBurnErageAmount] = useState('')
  
  // Chart history — stored in separate hook for persistence across page.tsx updates
  const {
    priceEfficiencyHistory,
    backingRatioHistory,
    historyLoaded,
    addPriceEfficiencyPoint,
    addBackingRatioPoint,
  } = useChartHistory()

  const [timeRange, setTimeRange] = useState<TimeRange>('1d')
  
  // Chart history loading/clearing is handled by useChartHistory hook above
  // No more inline localStorage logic here — data persists across page.tsx updates
  
  // Burnt amounts - v4 tracks burns directly on-chain + includes legacy burns
  const [burntAmounts, setBurntAmounts] = useState<{ eshare: bigint; rage: bigint }>({ eshare: 0n, rage: 0n })
  
  // ERAGE burn tracking — watch Transfer events to address(0) on the ERAGE contract
  // The contract's burn() function doesn't track totalErageBurned, so we monitor on-chain events.
  // We initialize from localStorage cache instantly, then fetch full history from chain.
  const [erageBurnt, setErageBurnt] = useState<bigint>(() => {
    if (typeof window === 'undefined') return 0n
    try {
      const cached = localStorage.getItem('erageBurnt')
      return cached ? BigInt(cached) : 0n
    } catch { return 0n }
  })
  
  // ============ CONTRACT READS ============
  const { data: ggxBal } = useReadContract({ address: CONTRACTS.GGX, abi: ERC20_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, query: { enabled: !!address } })
  const { data: eshareBal } = useReadContract({ address: CONTRACTS.ESHARE, abi: ERC20_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, query: { enabled: !!address } })
  const { data: rageBal } = useReadContract({ address: CONTRACTS.RAGE, abi: ERC20_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, query: { enabled: !!address } })
  const { data: ethBal } = useBalance({ address })
  
  const { data: ggxSupply } = useReadContract({ address: CONTRACTS.GGX, abi: ERC20_ABI, functionName: 'totalSupply', query: { refetchInterval: 20000 } })
  
  // GGX contract data — refetch frequently to keep ratio/balances fresh after mints/redeems
  const { data: backingRatio } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'getBackingRatio', query: { refetchInterval: 20000 } })
  const { data: backingBalances } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'getBackingBalances', query: { refetchInterval: 20000 } })
  const { data: ggxPerPair } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'ggxPerPair', query: { refetchInterval: 8000 } })
  const { data: mintRate } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'getMintRate', query: { refetchInterval: 20000 } })

  // v5: emergency drain timelock countdown (0 = no drain pending, else unix timestamp when executable)
  const { data: emergencyDrainExecutableAt } = useReadContract({
    address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'emergencyDrainExecutableAt',
    query: { refetchInterval: 10000 }
  })
  // Mint output for ESHARE+RAGE (uses eshareInput) — v4 returns: [ggxOut, mintRate, fixedTax, linearTax, esBurn, raBurn]
  const { data: mintOutputEshare, isFetching: isFetchingMintOutput } = useReadContract({ 
    address: CONTRACTS.GGX, 
    abi: GGX_ABI, 
    functionName: 'getMintOutput', 
    args: eshareInput && parseFloat(eshareInput) > 0 ? [parseUnits(eshareInput, 18)] : undefined, 
    query: { 
      enabled: !!eshareInput && parseFloat(eshareInput) > 0 && inputToken === 'ESHARE_RAGE',
      refetchInterval: 20000,
      retry: 3,
      retryDelay: 1000,
    } 
  })
  
  // Redeem output preview
  const { data: redeemOutput, isFetching: isFetchingRedeemOutput } = useReadContract({ 
    address: CONTRACTS.GGX, 
    abi: GGX_ABI, 
    functionName: 'getRedeemOutput', 
    args: inputAmount && inputToken === 'GGX' ? [parseUnits(inputAmount, 18)] : undefined, 
    query: { 
      enabled: !!inputAmount && parseFloat(inputAmount) > 0 && inputToken === 'GGX',
      refetchInterval: 20000,
      retry: 3,
      retryDelay: 1000,
    } 
  })
  
  // LP Price Feeds - RAGE (V3 Pool)
  const { data: rageSlot0 } = useReadContract({ address: CONTRACTS.RAGE_LP, abi: PAIR_ABI, functionName: 'slot0', query: { refetchInterval: 8000 } })
  const { data: rageLiquidity } = useReadContract({ address: CONTRACTS.RAGE_LP, abi: PAIR_ABI, functionName: 'liquidity' })
  const { data: rageT0 } = useReadContract({ address: CONTRACTS.RAGE_LP, abi: PAIR_ABI, functionName: 'token0' })
  const { data: rageT1 } = useReadContract({ address: CONTRACTS.RAGE_LP, abi: PAIR_ABI, functionName: 'token1' })
  
  // LP Price Feeds - ESHARE (V3 Pool)
  const { data: eshareSlot0 } = useReadContract({ address: CONTRACTS.ESHARE_LP, abi: PAIR_ABI, functionName: 'slot0', query: { refetchInterval: 8000 } })
  const { data: eshareLiquidity } = useReadContract({ address: CONTRACTS.ESHARE_LP, abi: PAIR_ABI, functionName: 'liquidity' })
  const { data: eshareT0 } = useReadContract({ address: CONTRACTS.ESHARE_LP, abi: PAIR_ABI, functionName: 'token0' })
  const { data: eshareT1 } = useReadContract({ address: CONTRACTS.ESHARE_LP, abi: PAIR_ABI, functionName: 'token1' })
  
  // LP Price Feeds - GGX (V3 Pool)
  const { data: ggxSlot0 } = useReadContract({ address: CONTRACTS.GGX_LP, abi: PAIR_ABI, functionName: 'slot0', query: { refetchInterval: 20000 } })
  const { data: ggxLiquidity } = useReadContract({ address: CONTRACTS.GGX_LP, abi: PAIR_ABI, functionName: 'liquidity' })
  const { data: ggxT0 } = useReadContract({ address: CONTRACTS.GGX_LP, abi: PAIR_ABI, functionName: 'token0' })
  const { data: ggxT1 } = useReadContract({ address: CONTRACTS.GGX_LP, abi: PAIR_ABI, functionName: 'token1' })
  
  // GGX-ETH V3 Pool balances (for TVL calculation and price)
  const { data: ggxPoolWethBal } = useReadContract({ 
    address: CONTRACTS.WETH, 
    abi: ERC20_ABI, 
    functionName: 'balanceOf', 
    args: [CONTRACTS.GGX_LP],
    query: { 
      enabled: true,
      refetchInterval: 20000 
    }
  })
  const { data: ggxPoolGgxBal } = useReadContract({ 
    address: CONTRACTS.GGX, 
    abi: ERC20_ABI, 
    functionName: 'balanceOf', 
    args: [CONTRACTS.GGX_LP],
    query: { 
      enabled: true,
      refetchInterval: 20000 
    }
  })


  // GGX-RAGE side pool balances (for protocol TVL)
  const { data: ggxRagePoolGgxBal } = useReadContract({ address: CONTRACTS.GGX, abi: ERC20_ABI, functionName: 'balanceOf', args: [CONTRACTS.GGX_RAGE_LP], query: { refetchInterval: 20000 } })
  const { data: ggxRagePoolRageBal } = useReadContract({ address: CONTRACTS.RAGE, abi: ERC20_ABI, functionName: 'balanceOf', args: [CONTRACTS.GGX_RAGE_LP], query: { refetchInterval: 20000 } })

  // GGX-ESHARE side pool balances (for protocol TVL)
  const { data: ggxEsharePoolGgxBal } = useReadContract({ address: CONTRACTS.GGX, abi: ERC20_ABI, functionName: 'balanceOf', args: [CONTRACTS.GGX_ESHARE_LP], query: { refetchInterval: 20000 } })
  const { data: ggxEsharePoolEshareBal } = useReadContract({ address: CONTRACTS.ESHARE, abi: ERC20_ABI, functionName: 'balanceOf', args: [CONTRACTS.GGX_ESHARE_LP], query: { refetchInterval: 20000 } })

  // ERAGE-RAGE V3 1% pool (0x9e7C...) — calculate RAGE side only for TVL
  const { data: erageRagePoolRageBal } = useReadContract({ address: CONTRACTS.RAGE, abi: ERC20_ABI, functionName: 'balanceOf', args: [CONTRACTS.ERAGE_RAGE_LP], query: { refetchInterval: 20000 } })

  // ERAGE-ESHARE V3 1% pool (0x2CFD...) — calculate ESHARE side only for TVL
  const { data: erageEsharePoolEshareBal } = useReadContract({ address: CONTRACTS.ESHARE, abi: ERC20_ABI, functionName: 'balanceOf', args: [CONTRACTS.ERAGE_ESHARE_LP], query: { refetchInterval: 20000 } })

  // Liquidity reads used by auto-slippage. The ESHARE leg is the tighter pool
  // in practice; the RAGE leg routes via USDC so its binding liquidity is the
  // USDC side of the RAGE-USDC pool.
  const { data: eshareLpWethBal } = useReadContract({ address: CONTRACTS.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [CONTRACTS.ESHARE_LP], query: { refetchInterval: 20000 } })
  const { data: rageLpUsdcBal } = useReadContract({ address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [CONTRACTS.RAGE_LP], query: { refetchInterval: 20000 } })
  // WETH/USDC pool for ETH price in USD
  const { data: wethUsdcSlot0 } = useReadContract({ address: CONTRACTS.WETH_USDC_LP, abi: PAIR_ABI, functionName: 'slot0', query: { refetchInterval: 8000 } })
  const { data: wethUsdcT0 } = useReadContract({ address: CONTRACTS.WETH_USDC_LP, abi: PAIR_ABI, functionName: 'token0' })

  // WETH/USDC pool balances for price calculation (more reliable than sqrtPriceX96)
  const { data: wethUsdcPoolWethBal } = useReadContract({
    address: CONTRACTS.WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [CONTRACTS.WETH_USDC_LP],
    query: { refetchInterval: 8000 }
  })
  const { data: wethUsdcPoolUsdcBal } = useReadContract({
    address: CONTRACTS.USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [CONTRACTS.WETH_USDC_LP],
    query: { refetchInterval: 8000 }
  })

  // Admin reads - Symmetric taxes (v4 — _burnRage fixed)
  const { data: isPaused } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'paused' })
  const { data: fixedBackingTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'fixedBackingTaxBps' })
  const { data: linearBackingTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'linearBackingTaxBps' })
  const { data: eshareBurnTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'eshareBurnTaxBps' })
  const { data: rageBurnTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'rageBurnTaxBps' })
  const { data: totalTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalTaxBps' })
  const { data: ratioPremium } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'getRatioPremium' })
  
  // Read total backing added and burned (v4 has direct burn tracking — _burnRage fixed)
  const { data: totalEshareBackingAdded } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalEshareBackingAdded', query: { refetchInterval: 20000 } })
  const { data: totalRageBackingAdded } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalRageBackingAdded', query: { refetchInterval: 20000 } })
  const { data: totalEshareBurned } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalEshareBurned', query: { refetchInterval: 20000 } })
  const { data: totalRageBurned } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalRageBurned', query: { refetchInterval: 20000 } })
  const { data: totalMintCount } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalMintCount', query: { refetchInterval: 20000 } })
  const { data: totalRedeemCount } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalRedeemCount', query: { refetchInterval: 20000 } })
  
  // Use direct burn tracking from v4 contract + include old v1/v2/v3 burnt amounts
  useEffect(() => {
    setBurntAmounts({
      eshare: (totalEshareBurned || 0n) + LEGACY_BURNT.eshare,
      rage: (totalRageBurned || 0n) + LEGACY_BURNT.rage
    })
  }, [totalEshareBurned, totalRageBurned])
  
  // ── ERAGE Burn Tracking ──
  // The contract's burn() function doesn't increment a totalErageBurned counter,
  // so we watch for ERC20 Transfer events to address(0) on the ERAGE contract.
  // This captures voluntary burns via burn() AND ERAGE destroyed during redeem().
  //
  // Persistence strategy:
  // 1. Instant load from localStorage cache (survives page reuploads)
  // 2. On mount, fetch full historical Transfer(to=0) logs from chain → authoritative
  // 3. useWatchContractEvent catches new burns in real-time
  //
  // Every user gets accurate numbers regardless of localStorage:
  // - Cached value shows instantly (from their own localStorage)
  // - Chain query overwrites with the true on-chain total within seconds
  // - New users with no cache: see "—" briefly, then accurate number once getLogs returns
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as `0x${string}`
  const publicClient = usePublicClient()
  
  // ERAGE first burn block on Base — narrows the query range for speed & reliability
  // First ERAGE burn occurred at block 45386361, no need to scan earlier blocks
  const ERAGE_DEPLOY_BLOCK = 45386361n

  // Fetch historical burn events on mount — chunked to avoid RPC limits
  useEffect(() => {
    if (!publicClient) return
    const fetchHistoricalBurns = async () => {
      try {
        const latestBlock = await publicClient.getBlockNumber()
        const CHUNK = 10000n
        let total = 0n
        
        for (let from = ERAGE_DEPLOY_BLOCK; from <= latestBlock; from += CHUNK) {
          const to = from + CHUNK > latestBlock ? latestBlock : from + CHUNK
          const logs = await publicClient.getLogs({
            address: CONTRACTS.GGX,
            event: {
              type: 'event',
              name: 'Transfer',
              inputs: [
                { name: 'from', type: 'address', indexed: true },
                { name: 'to', type: 'address', indexed: true },
                { name: 'value', type: 'uint256', indexed: false },
              ],
            },
            args: { to: ZERO_ADDR },
            fromBlock: from,
            toBlock: to,
          })
          for (const log of logs) {
            const value = log.args.value ?? 0n
            if (value > 0n) total += value
          }
        }
        setErageBurnt(total)
        localStorage.setItem('erageBurnt', total.toString())
      } catch (err) {
        console.warn('Failed to fetch historical ERAGE burn logs:', err)
      }
    }
    fetchHistoricalBurns()
  }, [publicClient])

  // Persist to localStorage on every change
  useEffect(() => {
    try { localStorage.setItem('erageBurnt', erageBurnt.toString()) } catch {}
  }, [erageBurnt])
  
  useWatchContractEvent({
    address: CONTRACTS.GGX,
    abi: ERC20_ABI,
    eventName: 'Transfer',
    onLogs(logs) {
      for (const log of logs) {
        if (log.args.to?.toLowerCase() === ZERO_ADDR) {
          const value = log.args.value ?? 0n
          if (value > 0n) {
            setErageBurnt(prev => prev + value)
          }
        }
      }
    },
  })
  
  const { data: zapRouter } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'uniswapV3Router' })
  const { data: zapWeth } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'weth' })
  const { data: zapErage } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'erage' })
  const { data: zapUsdc } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'usdc' })
  const { data: zapAdminWallet } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'adminWallet' })  // V4
  const { data: zapQuoter } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'quoter' })
  const { data: zapQuoteRefBps } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'quoteRefBps' })
  const { data: zapRebalanceThresholdBps } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'rebalanceThresholdBps' })
  
  // Zap estimates
  // Note: V3 Zap doesn't have estimate functions - would need V3 Quoter
  // For now, we show estimated output as "~" since it requires complex calculation
  
  // Allowances
  const { data: eshareAllowGGX } = useReadContract({ address: CONTRACTS.ESHARE, abi: ERC20_ABI, functionName: 'allowance', args: address ? [address, CONTRACTS.GGX] : undefined, query: { enabled: !!address, refetchInterval: 10000 } })
  const { data: rageAllowGGX } = useReadContract({ address: CONTRACTS.RAGE, abi: ERC20_ABI, functionName: 'allowance', args: address ? [address, CONTRACTS.GGX] : undefined, query: { enabled: !!address, refetchInterval: 10000 } })
  const { data: eshareAllowZap } = useReadContract({ address: CONTRACTS.ESHARE, abi: ERC20_ABI, functionName: 'allowance', args: address ? [address, CONTRACTS.GGXZap] : undefined, query: { enabled: !!address, refetchInterval: 10000 } })
  const { data: rageAllowZap } = useReadContract({ address: CONTRACTS.RAGE, abi: ERC20_ABI, functionName: 'allowance', args: address ? [address, CONTRACTS.GGXZap] : undefined, query: { enabled: !!address, refetchInterval: 10000 } })
  
  // Contract writes
  const { writeContract, data: txHash, isPending } = useWriteContract()
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash: txHash })
  const queryClient = useQueryClient()
  
  // Loading state for transactions
  const isLoading = isPending || isConfirming
  
  // Track previous txHash to detect new transactions
  const prevTxHashRef = useRef<string | undefined>(undefined)
  
  // Refetch all balances after transaction confirms
  useEffect(() => {
    // Only trigger when txHash changes and is confirmed
    if (isConfirmed && txHash && txHash !== prevTxHashRef.current) {
      prevTxHashRef.current = txHash
      // Force refetch all queries immediately + staggered to catch block updates
      queryClient.invalidateQueries()
      setTimeout(() => queryClient.invalidateQueries(), 500)
      setTimeout(() => queryClient.invalidateQueries(), 2000)
      setTimeout(() => queryClient.invalidateQueries(), 5000)
      setTimeout(() => queryClient.invalidateQueries(), 8000)
    }
  }, [isConfirmed, txHash, queryClient])
  
  // Auto-refresh every 15 seconds for contract data
  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries()
    }, 30000)
    return () => clearInterval(interval)
  }, [queryClient])
  
  // Manual refresh function - force refetch everything
  const handleRefresh = () => {
    queryClient.invalidateQueries()
  }
  
  // ============ DERIVED VALUES ============
  // Stored ratio from contract (ggxPerPair values)
  const currentRatio = useMemo(() => {
    if (!backingRatio) return 1
    const [esharePer, ragePer] = backingRatio
    return parseFloat(formatUnits(esharePer + ragePer, 18))
  }, [backingRatio])

  // Track backing ratio history for APR calculation
  useEffect(() => {
    if (!historyLoaded || currentRatio <= 1) return
    addBackingRatioPoint(currentRatio)
  }, [currentRatio, historyLoaded, addBackingRatioPoint])

  // ===== APR Calculation =====
  // The backing ratio started at 2.0 when the contract was deployed.
  // All growth calculations must use 2.0 as the baseline, NOT 1.0.
  // Using 1.0 would massively inflate the APR (e.g. 2.0→2.14 would show 14% growth
  // instead of the correct ~7% growth from the 2.0 starting point).
  const INITIAL_BACKING_RATIO = 2.0

  // ===== Live APR — focuses on 24-hour price action =====
  // Responsive to recent volume: spikes on high-activity days, drops on quiet days.
  // Always prefers the 24hr-ago data point so it reflects the LAST day of price action,
  // not an average over the entire tracking period.
  const estimatedAPR = useMemo<{ rate: number; minutesElapsed: number } | null>(() => {
    // ===== Method 1: Real observed growth — 24hr rolling window =====
    if (backingRatioHistory.length >= 2) {
      const now = Date.now()
      const oneDayAgo = now - 24 * 60 * 60 * 1000

      // Find the closest entry to exactly 24hr ago
      const pastEntry = backingRatioHistory.reduce((best, entry) => {
        const diff = Math.abs(entry.time - oneDayAgo)
        const bestDiff = Math.abs(best.time - oneDayAgo)
        return diff < bestDiff ? entry : best
      })

      // LIVE APR: Always prefer the 24hr-ago entry — this makes it responsive to
      // the last day of price action. Only fall back to the oldest entry if we
      // have less than 24hr of data.
      const oldestEntry = backingRatioHistory[0]
      const have24hrData = (now - oldestEntry.time) >= 24 * 60 * 60 * 1000
      const useEntry = have24hrData ? pastEntry : oldestEntry

      // Must have at least 5 minutes of data for a meaningful rate
      const minDataAge = 5 * 60 * 1000
      if (now - useEntry.time >= minDataAge) {
        const currentVal = currentRatio
        const pastVal = useEntry.ratio
        const minutesElapsed = Math.round((now - useEntry.time) / (60 * 1000))

        if (pastVal > 0 && currentVal > pastVal) {
          // Annualize the REAL observed growth over the actual elapsed time
          const growthRate = (currentVal - pastVal) / pastVal
          const hoursElapsed = (now - useEntry.time) / (60 * 60 * 1000)
          const annualizedRate = growthRate * (24 / hoursElapsed) * 365 * 100

          if (annualizedRate > 0 && annualizedRate <= 99999) {
            return { rate: annualizedRate, minutesElapsed }
          }
        }
      }
    }

    // ===== Method 2: ggxPerPair ratchet floor =====
    // Use estimated elapsed time from first tracked history point
    if (ggxPerPair) {
      const floorVal = parseFloat(formatUnits(ggxPerPair, 18))
      if (floorVal > INITIAL_BACKING_RATIO) {
        const growthFromFloor = (floorVal - INITIAL_BACKING_RATIO) / INITIAL_BACKING_RATIO
        // Estimate how long the contract has been active from our history
        let estimatedDays = 30
        if (backingRatioHistory.length >= 2) {
          const elapsedMs = Date.now() - backingRatioHistory[0].time
          estimatedDays = Math.max(elapsedMs / (24 * 60 * 60 * 1000), 1)
        }
        const annualizedRate = (growthFromFloor / estimatedDays) * 365 * 100
        if (annualizedRate > 0 && annualizedRate <= 99999) {
          const minutesElapsed = backingRatioHistory.length >= 2
            ? Math.round((Date.now() - backingRatioHistory[0].time) / (60 * 1000))
            : -1
          return { rate: annualizedRate, minutesElapsed }
        }
      }
    }

    // ===== Method 3: Backing ratio on-chain estimate =====
    if (currentRatio > INITIAL_BACKING_RATIO && (totalMintCount || totalRedeemCount)) {
      const totalEvents = Number(totalMintCount || 0n) + Number(totalRedeemCount || 0n)
      if (totalEvents > 0) {
        const growthFromStart = (currentRatio - INITIAL_BACKING_RATIO) / INITIAL_BACKING_RATIO
        // Estimate elapsed time from history
        let estimatedDays = 30
        if (backingRatioHistory.length >= 2) {
          const elapsedMs = Date.now() - backingRatioHistory[0].time
          estimatedDays = Math.max(elapsedMs / (24 * 60 * 60 * 1000), 1)
        }
        const annualizedRate = (growthFromStart / estimatedDays) * 365 * 100
        if (annualizedRate > 0 && annualizedRate <= 99999) {
          const minutesElapsed = backingRatioHistory.length >= 2
            ? Math.round((Date.now() - backingRatioHistory[0].time) / (60 * 1000))
            : -1
          return { rate: annualizedRate, minutesElapsed }
        }
      }
    }

    return null
  }, [backingRatioHistory, currentRatio, ggxPerPair, totalMintCount, totalRedeemCount])
  
  // ===== 30-Day APR Projection =====
  // Stable, smoothed APR — uses ALL tracked data (not just last 24hr) and projects
  // over a 30-day period. Less volatile than Live APR because it averages over
  // the entire tracking history rather than just the last day of price action.
  const estimated30dAPR = useMemo<{ rate: number } | null>(() => {
    // Method 1: Real observed growth using ALL history, projected over 30 days
    if (backingRatioHistory.length >= 2) {
      const now = Date.now()
      const oldestEntry = backingRatioHistory[0]
      if (now - oldestEntry.time >= 1 * 60 * 1000) { // at least 1 min of data
        const pastVal = oldestEntry.ratio
        if (pastVal > 0 && currentRatio > pastVal) {
          const growthRate = (currentRatio - pastVal) / pastVal
          // Scale observed growth to 30 days regardless of actual tracking time
          const hoursElapsed = (now - oldestEntry.time) / (60 * 60 * 1000)
          const growthPer30Days = growthRate * (720 / hoursElapsed) // 720 hrs = 30 days
          const annualizedRate = growthPer30Days * (365 / 30) * 100
          if (annualizedRate > 0 && annualizedRate <= 99999) {
            return { rate: annualizedRate }
          }
        }
      }
    }

    // Method 2: ggxPerPair ratchet floor — always 30-day assumption
    if (ggxPerPair) {
      const floorVal = parseFloat(formatUnits(ggxPerPair, 18))
      if (floorVal > INITIAL_BACKING_RATIO) {
        const growthFromFloor = (floorVal - INITIAL_BACKING_RATIO) / INITIAL_BACKING_RATIO
        const annualizedRate = (growthFromFloor / 30) * 365 * 100
        if (annualizedRate > 0 && annualizedRate <= 99999) {
          return { rate: annualizedRate }
        }
      }
    }

    // Method 3: Backing ratio on-chain estimate — always 30-day assumption
    if (currentRatio > INITIAL_BACKING_RATIO && (totalMintCount || totalRedeemCount)) {
      const totalEvents = Number(totalMintCount || 0n) + Number(totalRedeemCount || 0n)
      if (totalEvents > 0) {
        const growthFromStart = (currentRatio - INITIAL_BACKING_RATIO) / INITIAL_BACKING_RATIO
        const annualizedRate = (growthFromStart / 30) * 365 * 100
        if (annualizedRate > 0 && annualizedRate <= 99999) {
          return { rate: annualizedRate }
        }
      }
    }

    return null
  }, [backingRatioHistory, currentRatio, ggxPerPair, totalMintCount, totalRedeemCount])
  
  // ACTUAL backing ratio calculated from balances/supply
  // This shows the real backing per GGX based on what's in the contract
  const actualBackingRatio = useMemo(() => {
    if (!backingBalances || !ggxSupply || ggxSupply === 0n) return null
    const [eshareBal, rageBal] = backingBalances
    const supply = parseFloat(formatUnits(ggxSupply, 18))
    const esharePer = parseFloat(formatUnits(eshareBal, 18)) / supply
    const ragePer = parseFloat(formatUnits(rageBal, 18)) / supply
    return { esharePer, ragePer, total: esharePer + ragePer }
  }, [backingBalances, ggxSupply])
  
  // Selected token balance (for single-input modes)
  const selectedBalance = useMemo(() => {
    switch (inputToken) {
      case 'ETH': return ethBal ? parseFloat(formatUnits(ethBal.value, ethBal.decimals)) : 0
      case 'GGX': return ggxBal ? parseFloat(formatUnits(ggxBal, 18)) : 0
      case 'ESHARE_RAGE': return 0 // Not used for dual-input
      default: return 0
    }
  }, [inputToken, ethBal, ggxBal])
  
  // Check if approval is needed (per-token)
  const needsEshareApproval = useMemo(() => {
    if (inputToken !== 'ESHARE_RAGE') return false
    const eshareWei = eshareInput ? parseUnits(eshareInput, 18) : 0n
    return eshareWei > 0n && (!eshareAllowGGX || eshareAllowGGX < eshareWei)
  }, [inputToken, eshareInput, eshareAllowGGX])

  const needsRageApproval = useMemo(() => {
    if (inputToken !== 'ESHARE_RAGE') return false
    const rageWei = rageInput ? parseUnits(rageInput, 18) : 0n
    return rageWei > 0n && (!rageAllowGGX || rageAllowGGX < rageWei)
  }, [inputToken, rageInput, rageAllowGGX])

  const needsApproval = needsEshareApproval || needsRageApproval
  
  // Action button text
  const actionButtonText = useMemo(() => {
    if (isLoading) return 'Confirming...'
    if (inputToken === 'GGX') {
      if (!inputAmount || parseFloat(inputAmount) === 0) return 'Enter ERAGE Amount'
      return 'Redeem ERAGE'
    }
    if (inputToken === 'ETH') {
      if (!inputAmount || parseFloat(inputAmount) === 0) return 'Enter ETH Amount'
      return 'Mint ERAGE'
    }
    if (inputToken === 'ESHARE_RAGE') {
      const hasEshare = eshareInput && parseFloat(eshareInput) > 0
      const hasRage = rageInput && parseFloat(rageInput) > 0
      if (!hasEshare && !hasRage) return 'Enter Amounts'
      return 'Mint ERAGE'
    }
    return 'Enter Amount'
  }, [inputAmount, inputToken, isLoading, eshareInput, rageInput])
  
  // Calculate prices from V3 pools (sqrtPriceX96)
  const prices = useMemo(() => {
    // V3 price formula: price = (sqrtPriceX96 / 2^96)^2
    const Q96 = BigInt(2) ** BigInt(96)
    
    // Helper to extract sqrtPriceX96 from slot0 (handles both array and object)
    const getSqrtPriceX96 = (slot0: unknown): bigint | null => {
      if (!slot0) return null
      // Try object access first
      if (typeof slot0 === 'object' && slot0 !== null && 'sqrtPriceX96' in slot0) {
        return (slot0 as { sqrtPriceX96: bigint }).sqrtPriceX96
      }
      // Try array access (viem sometimes returns tuples as arrays)
      if (Array.isArray(slot0) && slot0[0] !== undefined) {
        return slot0[0] as bigint
      }
      return null
    }
    
    // RAGE price (from RAGE/USDC V3 Pool - need to convert to ETH)
    let ragePrice = 0
    let ragePair = ''
    let rageLpExists = false
    let ragePriceInUsdc = false  // Flag to track if price is in USDC
    const rageSqrtPrice = getSqrtPriceX96(rageSlot0)
    if (rageSqrtPrice !== null && rageLiquidity && rageT0 && rageT1) {
      rageLpExists = rageSqrtPrice > 0n && rageLiquidity > 0n

      if (rageLpExists) {
        const isRageT0 = rageT0.toLowerCase() === CONTRACTS.RAGE.toLowerCase()
        const isRageT1 = rageT1.toLowerCase() === CONTRACTS.RAGE.toLowerCase()
        const pairAddr = isRageT0 ? rageT1 : rageT0
        const pairLower = pairAddr.toLowerCase()

        if (pairLower === CONTRACTS.WETH.toLowerCase()) ragePair = 'ETH'
        else if (pairLower === CONTRACTS.USDC.toLowerCase()) {
          ragePair = 'USDC'
          ragePriceInUsdc = true
        }
        else if (pairLower === CONTRACTS.GGX.toLowerCase()) ragePair = 'GGX'
        else if (pairLower === CONTRACTS.ESHARE.toLowerCase()) ragePair = 'ESHARE'
        else ragePair = 'LP'

        // V3 price = (sqrtPriceX96 / 2^96)^2
        const priceRatio = Number(rageSqrtPrice) / Number(Q96)
        const rawPrice = priceRatio * priceRatio

        // IMPORTANT: V3 pools need decimal adjustment!
        // rawPrice = token1/token0 in smallest units
        // RAGE (18 decimals), USDC (6 decimals)
        const RAGE_DECIMALS = 18
        const USDC_DECIMALS = 6
        const decimalAdjustment = Math.pow(10, RAGE_DECIMALS - USDC_DECIMALS) // 10^12

        // token0 = USDC, token1 = RAGE
        // rawPrice = RAGE_wei per USDC_micro
        // To get USDC per RAGE: decimalAdjustment / rawPrice
        if (isRageT1) {
          // RAGE is token1, USDC is token0
          // rawPrice = RAGE per USDC (in smallest units)
          // USDC per RAGE = decimalAdjustment / rawPrice
          ragePrice = decimalAdjustment / rawPrice
        } else if (isRageT0) {
          // RAGE is token0, pair is token1
          // rawPrice = token1 per RAGE (in smallest units)
          ragePrice = rawPrice / decimalAdjustment
        }
      }
    }
    
    // ESHARE price (from ESHARE/ETH V3 Pool)
    let esharePrice = 0
    let esharePair = ''
    let eshareLpExists = false
    const eshareSqrtPrice = getSqrtPriceX96(eshareSlot0)
    if (eshareSqrtPrice !== null && eshareLiquidity && eshareT0 && eshareT1) {
      eshareLpExists = eshareSqrtPrice > 0n && eshareLiquidity > 0n
      
      if (eshareLpExists) {
        const isEshareT0 = eshareT0.toLowerCase() === CONTRACTS.ESHARE.toLowerCase()
        const pairAddr = isEshareT0 ? eshareT1 : eshareT0
        const pairLower = pairAddr.toLowerCase()
        
        if (pairLower === CONTRACTS.WETH.toLowerCase()) esharePair = 'ETH'
        else if (pairLower === CONTRACTS.GGX.toLowerCase()) esharePair = 'GGX'
        else if (pairLower === CONTRACTS.RAGE.toLowerCase()) esharePair = 'RAGE'
        else esharePair = 'LP'
        
        const priceRatio = Number(eshareSqrtPrice) / Number(Q96)
        const rawPrice = priceRatio * priceRatio
        
        if (isEshareT0) {
          esharePrice = rawPrice
        } else {
          esharePrice = 1 / rawPrice
        }
      }
    }
    
    // GGX price (from GGX/ETH V3 Pool)
    // Primary: Calculate from sqrtPriceX96 (CORRECT for V3 pools)
    // Fallback: Calculate from pool balances
    // NOTE: V3 pools have concentrated liquidity, so pool balances don't accurately
    // represent price — sqrtPriceX96 from slot0 is the reliable source.
    // Using balances as primary caused wild spikes (e.g. 0.282) especially with
    // 0.3% fee tier pools where LPs concentrate in tight ranges.
    let ggxPrice = 0
    let ggxPair = ''
    let ggxLpExists = false
    
    // Method 1: Use sqrtPriceX96 from V3 slot0 (CORRECT for V3 pools)
    const ggxSqrtPrice = getSqrtPriceX96(ggxSlot0)
    if (ggxSqrtPrice !== null && ggxSqrtPrice > 0n && ggxT0 && ggxT1) {
      ggxLpExists = true
      
      const isGgxT0 = ggxT0.toLowerCase() === CONTRACTS.GGX.toLowerCase()
      const pairAddr = isGgxT0 ? ggxT1 : ggxT0
      const pairLower = pairAddr.toLowerCase()
      
      if (pairLower === CONTRACTS.WETH.toLowerCase()) ggxPair = 'ETH'
      else ggxPair = 'LP'
      
      // Calculate price from sqrtPriceX96
      const priceRatio = Number(ggxSqrtPrice) / Number(Q96)
      const rawPrice = priceRatio * priceRatio
      
      // sqrtPriceX96 represents price of token1 in terms of token0
      if (isGgxT0) {
        ggxPrice = rawPrice  // ETH per GGX
      } else {
        ggxPrice = 1 / rawPrice  // ETH per GGX
      }
    }
    
    // Method 2: Fallback to pool balances (NOT reliable for V3 — only used when
    // sqrtPriceX96 is unavailable, e.g. during refetch gaps)
    // NEVER use pool-balance price for the price efficiency chart — it produces
    // wild spikes in concentrated-liquidity pools (0.3% fee tier especially).
    if (ggxPrice === 0) {
      if (ggxPoolWethBal && ggxPoolGgxBal && ggxPoolWethBal > 0n && ggxPoolGgxBal > 0n) {
        const wethInPool = parseFloat(formatUnits(ggxPoolWethBal, 18))
        const ggxInPool = parseFloat(formatUnits(ggxPoolGgxBal, 18))
        if (ggxInPool > 0 && wethInPool > 0) {
          ggxPrice = wethInPool / ggxInPool  // ETH per GGX
          ggxLpExists = true
          ggxPair = 'ETH'
        }
      }
    }
    
    // ETH price in USD (from WETH/USDC V3 Pool) - CALCULATE FIRST for conversions
    let ethPriceUsd = 0

    // Method 1: Use sqrtPriceX96 from V3 slot0 (CORRECT for V3 pools)
    // V3 pools have concentrated liquidity, so pool balances don't accurately represent price
    const wethUsdcSqrtPrice = getSqrtPriceX96(wethUsdcSlot0)
    if (wethUsdcSqrtPrice !== null && wethUsdcT0) {
      const isWethT0 = wethUsdcT0.toLowerCase() === CONTRACTS.WETH.toLowerCase()
      const priceRatio = Number(wethUsdcSqrtPrice) / Number(Q96)
      const rawPrice = priceRatio * priceRatio

      // WETH (18 decimals) and USDC (6 decimals) - need decimal adjustment
      const decimalAdjustment = Math.pow(10, 18 - 6) // 10^12

      // sqrtPriceX96 gives token1/token0
      if (isWethT0) {
        // WETH is token0, USDC is token1
        // rawPrice = USDC_micro per WETH_wei = (price_usd * 10^6) / 10^18 = price_usd / 10^12
        // To get ETH price in USD: multiply by 10^12
        ethPriceUsd = rawPrice * decimalAdjustment
      } else {
        // WETH is token1, USDC is token0
        // rawPrice = WETH_wei per USDC_micro
        // To get ETH price: 10^12 / rawPrice
        ethPriceUsd = decimalAdjustment / rawPrice
      }
    }

    // Method 2: Fallback to pool balances (NOT reliable for V3 but better than nothing)
    if (ethPriceUsd === 0 || ethPriceUsd < 100 || ethPriceUsd > 10000) {
      if (wethUsdcPoolWethBal && wethUsdcPoolUsdcBal && wethUsdcPoolWethBal > 0n && wethUsdcPoolUsdcBal > 0n) {
        const wethInPool = parseFloat(formatUnits(wethUsdcPoolWethBal, 18)) // WETH has 18 decimals
        const usdcInPool = parseFloat(formatUnits(wethUsdcPoolUsdcBal, 6))  // USDC has 6 decimals
        if (wethInPool > 0) {
          const priceFromBalances = usdcInPool / wethInPool
          // Only use if it's in reasonable range
          if (priceFromBalances > 100 && priceFromBalances < 10000) {
            ethPriceUsd = priceFromBalances
          }
        }
      }
    }

    // Fallback: Use approximate ETH price if pool data unavailable
    if (ethPriceUsd === 0 || ethPriceUsd < 100 || ethPriceUsd > 10000) {
      ethPriceUsd = 2400 // Approximate ETH price fallback
    }
    
    // GGX price in USD
    const ggxPriceUsd = ggxPrice * ethPriceUsd
    
    return { ragePrice, ragePair, ragePriceInUsdc, esharePrice, esharePair, ggxPrice, ggxPair, ggxPriceUsd, ethPriceUsd, rageLpExists, eshareLpExists, ggxLpExists }
  }, [rageSlot0, rageLiquidity, rageT0, rageT1, eshareSlot0, eshareLiquidity, eshareT0, eshareT1, ggxSlot0, ggxLiquidity, ggxT0, ggxT1, ggxPoolWethBal, ggxPoolGgxBal, wethUsdcSlot0, wethUsdcT0, wethUsdcPoolWethBal, wethUsdcPoolUsdcBal])
  
  // Calculate GGX theoretical backing value in USD directly
  // This handles the case where ESHARE is in ETH and RAGE is in USDC
  const ggxBackingValueUsd = useMemo(() => {
    if (!backingRatio || prices.esharePrice === 0 || prices.ragePrice === 0) return 0
    const [esharePer, ragePer] = backingRatio
    
    // ESHARE is paired with ETH, so convert to USD
    const eshareValueUsd = parseFloat(formatUnits(esharePer, 18)) * prices.esharePrice * prices.ethPriceUsd
    
    // RAGE: if paired with USDC, price is already in USD; if paired with ETH, convert
    let rageValueUsd: number
    if (prices.ragePriceInUsdc) {
      // Price is already in USDC per RAGE (USD terms)
      rageValueUsd = parseFloat(formatUnits(ragePer, 18)) * prices.ragePrice
    } else {
      // Price is in ETH per RAGE, convert to USD
      rageValueUsd = parseFloat(formatUnits(ragePer, 18)) * prices.ragePrice * prices.ethPriceUsd
    }
    
    return eshareValueUsd + rageValueUsd
  }, [backingRatio, prices.esharePrice, prices.ragePrice, prices.ragePriceInUsdc, prices.ethPriceUsd])
  
  // Calculate GGX backing value in ETH (for chart comparisons)
  const ggxBackingValue = useMemo(() => {
    if (ggxBackingValueUsd === 0 || prices.ethPriceUsd === 0) return 0
    return ggxBackingValueUsd / prices.ethPriceUsd
  }, [ggxBackingValueUsd, prices.ethPriceUsd])
  
  // Calculate price efficiency ratio (Uniswap vs Mint)
  // When < 1: Buy on Uniswap (cheaper than mint)
  // When > 1: Mint is better (Uniswap has premium)
  const priceEfficiencyRatio = useMemo(() => {
    if (prices.ggxPrice <= 0 || ggxBackingValueUsd <= 0) return null
    
    // Calculate GGX price in USD
    const ggxPriceUsd = prices.ggxPrice * prices.ethPriceUsd
    
    // Ratio = Uniswap price / backing value (both in USD)
    return ggxPriceUsd / ggxBackingValueUsd
  }, [prices.ggxPrice, prices.ethPriceUsd, ggxBackingValueUsd])
  
  // Track price efficiency history for the chart
  // Data persisted via useChartHistory hook — survives page.tsx updates
  //
  // ANTI-SPIKE FILTER (confirmation window):
  // When queryClient.invalidateQueries() fires, contract reads momentarily return
  // stale/undefined data. In a 0.3% fee V3 pool with concentrated liquidity, the
  // pool-balance fallback then produces wildly inaccurate prices, causing ratio
  // spikes (e.g. 0.288 when normal is ~1.0).
  //
  // Strategy: if a reading deviates >25% from the last confirmed value, hold it
  // as "pending" instead of recording it. On the NEXT reading:
  //   - If the next reading is ALSO deviated from the last confirmed value,
  //     the move is real → record both (even if they differ from each other,
  //     e.g. crash then bounce — both are part of a real move).
  //   - If the next reading snaps back near the last confirmed value,
  //     the pending was a stale-RPC artifact → discard it.
  const lastGoodRatioRef = useRef<number | null>(null)
  const pendingRatioRef = useRef<{ value: number; time: number } | null>(null)
  useEffect(() => {
    if (!historyLoaded || priceEfficiencyRatio === null || priceEfficiencyRatio <= 0) return

    const MAX_DEVIATION = 0.25  // 25% threshold to detect anomaly
    const last = lastGoodRatioRef.current
    const pending = pendingRatioRef.current

    // Is this reading a wild deviation from the last confirmed value?
    const isDeviation = last !== null && Math.abs(priceEfficiencyRatio - last) / last > MAX_DEVIATION

    if (!isDeviation) {
      // Normal reading — within expected range of last confirmed value
      if (pending) {
        // We had a pending outlier. The current normal reading means the pending
        // was a transient artifact (stale RPC data) — discard it.
        pendingRatioRef.current = null
      }
      lastGoodRatioRef.current = priceEfficiencyRatio
      addPriceEfficiencyPoint(priceEfficiencyRatio)
    } else if (pending) {
      // Second consecutive deviation from the old baseline — this is a REAL move.
      // Both readings confirm the price has left the old level, regardless of how
      // much they differ from each other (crash → partial bounce is still real).
      addPriceEfficiencyPoint(pending.value)
      lastGoodRatioRef.current = priceEfficiencyRatio
      addPriceEfficiencyPoint(priceEfficiencyRatio)
      pendingRatioRef.current = null
    } else {
      // First deviation — hold as pending, don't record yet
      pendingRatioRef.current = { value: priceEfficiencyRatio, time: Date.now() }
    }
  }, [priceEfficiencyRatio, historyLoaded, addPriceEfficiencyPoint])
  
  // Estimated GGX output for ETH zap
  // Computed from the actual backing value (cost to mint 1 GGX in ETH terms)
  // rather than from the Uniswap market price. This avoids the need for a
  // price-efficiency fudge factor and stays accurate when GGX trades at a
  // premium or discount on Uniswap.
  const estimatedGgxFromEth = useMemo(() => {
    if (!inputAmount) return null
    const ethAmount = parseFloat(inputAmount)
    if (isNaN(ethAmount) || ethAmount <= 0) return null

    // On-chain mint tax (220 BPS = 2.2% as of v5.2; was 250 BPS / 2.5%)
    const mintTaxBps = Number(totalTaxBps || 220)
    const MINT_TAX_MULT = 1 - mintTaxBps / 10_000

    // V5 ZapContract: 0.69% ETH tax deducted before swapping
    const ZAP_TAX_MULT = 1 - 69 / 10_000  // 0.9931

    // Swap routing efficiency — pool fees on the two legs:
    //   ESHARE leg: WETH→ESHARE through 1% fee pool
    //   RAGE leg:   WETH→USDC (0.05%) → USDC→RAGE (1%) = ~1.05%
    // Average pool fee ≈ 1.025%. Add ~0.5% for price impact on small trades.
    const SWAP_FEE_MULT = 0.985  // ~1.5% combined routing loss

    // Combined multiplier: zap tax → swap fees → mint tax
    const totalEfficiency = ZAP_TAX_MULT * SWAP_FEE_MULT * MINT_TAX_MULT

    // Primary: compute from backing value (ETH cost to mint 1 GGX)
    // This is the true "floor" — how many GGX your ETH can mint after all fees.
    if (ggxBackingValue > 0) {
      return (ethAmount * totalEfficiency) / ggxBackingValue
    }

    // Fallback: derive from Uniswap price adjusted by price-efficiency ratio
    if (prices.ggxPrice <= 0) return null
    const uniOutput = ethAmount / prices.ggxPrice

    if (priceEfficiencyRatio && priceEfficiencyRatio > 1) {
      // GGX at premium on Uniswap → minting gives MORE than buying on Uniswap
      return uniOutput * totalEfficiency * priceEfficiencyRatio
    } else {
      return uniOutput * totalEfficiency
    }
  }, [inputAmount, prices.ggxPrice, priceEfficiencyRatio, ggxBackingValue, totalTaxBps])

  // ============ Auto-Slippage (v5.1) ============
  // Baseline 11% covers on-chain execution variance on the ETH zap path
  // (pool price movement between estimate and execution, gas timing, etc).
  // We scale UP from 11% as the trade size grows relative to the tighter of the
  // two binding liquidity pools (ESHARE/WETH on the ESHARE leg, USDC side of
  // the RAGE/USDC pool on the RAGE leg). Capped at 15%.
  //
  // For the direct ESHARE+RAGE mint path there are no Uniswap swaps, so the
  // on-chain getMintOutput preview is exact and 11% is generous overhead.
  const autoSlippagePct = useMemo<number>(() => {
    // For non-zap paths (direct mint), the estimator is on-chain exact; keep the floor.
    if (inputToken !== 'ETH') return SLIPPAGE_MIN_PCT
    if (!inputAmount || parseFloat(inputAmount) === 0) return SLIPPAGE_MIN_PCT

    const ethAmount = parseFloat(inputAmount)
    if (isNaN(ethAmount) || ethAmount <= 0) return SLIPPAGE_MIN_PCT

    // Half the ETH goes to the ESHARE leg, half to the RAGE leg.
    const halfEth = ethAmount / 2

    // ESHARE leg: how much of the ESHARE/WETH pool's WETH we'd consume.
    let eshareLegPct = 0
    if (eshareLpWethBal && eshareLpWethBal > 0n) {
      const poolWeth = parseFloat(formatUnits(eshareLpWethBal, 18))
      if (poolWeth > 0) eshareLegPct = (halfEth / poolWeth) * 100
    }

    // RAGE leg: two-hop via USDC. The tighter side in practice is RAGE/USDC,
    // and the USDC side of that pool is what the trade consumes (after the
    // WETH→USDC hop converts the half-ETH into USDC dollars).
    let rageLegPct = 0
    if (rageLpUsdcBal && rageLpUsdcBal > 0n && prices.ethPriceUsd > 0) {
      const poolUsdc = parseFloat(formatUnits(rageLpUsdcBal, 6)) // USDC is 6 decimals
      const halfEthAsUsdc = halfEth * prices.ethPriceUsd
      if (poolUsdc > 0) rageLegPct = (halfEthAsUsdc / poolUsdc) * 100
    }

    // Use the larger of the two leg percentages — whichever leg is the binding constraint.
    const bindingLegPct = Math.max(eshareLegPct, rageLegPct)

    // Base 11% + 1% additional tolerance for each 1% of pool consumed.
    const auto = SLIPPAGE_MIN_PCT + bindingLegPct
    return Math.min(Math.max(auto, SLIPPAGE_MIN_PCT), SLIPPAGE_MAX_PCT)
  }, [inputToken, inputAmount, eshareLpWethBal, rageLpUsdcBal, prices.ethPriceUsd])

  // Final slippage pct used by the mint/zap transaction. Manual mode wins if user opted in.
  const slippagePct = useMemo<number>(() => {
    if (slippageMode === 'manual') {
      const v = parseFloat(slippageManual)
      if (isNaN(v) || v <= 0) return autoSlippagePct
      return Math.min(v, SLIPPAGE_MAX_PCT)
    }
    return autoSlippagePct
  }, [slippageMode, slippageManual, autoSlippagePct])
  
  // ============ HANDLERS ============
  const handleApprove = (token: `0x${string}`, spender: `0x${string}`, amount: string) => {
    if (!amount) return
    writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, parseUnits(amount, 18)] })
  }
  
  // Main action handler - determines action based on inputToken
  const handleAction = () => {
    if (inputToken === 'GGX') {
      // Redeem GGX — no slippage param needed; redeem ratio can only move in user's favor
      if (!inputAmount) return
      const amountWei = parseUnits(inputAmount, 18)
      writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'redeem', args: [amountWei] })
    } else if (inputToken === 'ETH') {
      // Zap from ETH (uses Zapper) - V3 requires deadline
      if (!inputAmount) return
      const amountWei = parseUnits(inputAmount, 18)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600) // 10 min from now

      // v5: compute minGgxOut from estimated output × (1 - slippagePct)
      // estimatedGgxFromEth is a float number of GGX; convert to wei and apply slippage
      let minGgxOut = 0n
      if (estimatedGgxFromEth && estimatedGgxFromEth > 0) {
        const slippageMultiplier = 1 - slippagePct / 100
        // Use string conversion to avoid FP precision issues at 18 decimals
        const minOutFloat = estimatedGgxFromEth * slippageMultiplier
        try {
          minGgxOut = parseUnits(minOutFloat.toFixed(18), 18)
        } catch { minGgxOut = 0n }
      }

      writeContract({
        address: CONTRACTS.GGXZap,
        abi: ZAP_ABI,
        functionName: 'zapFromETH',
        args: [V3_PATHS.ETH_TO_ESHARE, V3_PATHS.ETH_TO_RAGE, V3_PATHS.ESHARE_TO_RAGE, minGgxOut, deadline],
        value: amountWei
      })
    } else if (inputToken === 'ESHARE_RAGE') {
      // Direct mint with both ESHARE and RAGE (GGX contract, NOT Zapper)
      if (!eshareInput || parseFloat(eshareInput) === 0) return
      const eshareWei = parseUnits(eshareInput, 18)

      // v5: mint() now takes (tokenAmount, minGgxOut). Use on-chain getMintOutput preview × slippage.
      let minGgxOut = 0n
      if (mintOutputEshare) {
        const [expectedGgx] = mintOutputEshare as readonly [bigint, bigint, bigint, bigint, bigint, bigint]
        // Apply slippage as integer math: minOut = expected × (10000 - slippageBps) / 10000
        const slippageBps = BigInt(Math.floor(slippagePct * 100))
        minGgxOut = (expectedGgx * (10000n - slippageBps)) / 10000n
      }

      writeContract({
        address: CONTRACTS.GGX,
        abi: GGX_ABI,
        functionName: 'mint',
        args: [eshareWei, minGgxOut]
      })
    }
  }

  // Handle approval — v5: approve exactly what the user typed, not their full balance
  const handleApproveEshare = () => {
    if (!eshareInput || parseFloat(eshareInput) === 0) return
    handleApprove(CONTRACTS.ESHARE, CONTRACTS.GGX, eshareInput)
  }

  const handleApproveRage = () => {
    if (!rageInput || parseFloat(rageInput) === 0) return
    handleApprove(CONTRACTS.RAGE, CONTRACTS.GGX, rageInput)
  }
  
  // Admin handlers
  const handleSetRatio = () => {
    if (!newRatio) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'setGGXPerPair', args: [parseUnits(newRatio, 18)] })
  }
  
  const handlePause = () => {
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'pause', args: [] })
  }
  
  const handleUnpause = () => {
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'unpause', args: [] })
  }
  
  // Symmetric tax handlers (v4 unchanged from v3)
  const handleSetFixedBackingTax = () => {
    if (!newFixedBackingTax) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'setFixedBackingTaxBps', args: [BigInt(newFixedBackingTax)] })
  }
  
  const handleSetLinearBackingTax = () => {
    if (!newLinearBackingTax) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'setLinearBackingTaxBps', args: [BigInt(newLinearBackingTax)] })
  }
  
  const handleSetEshareBurnTax = () => {
    if (!newEshareBurnTax) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'setEshareBurnTaxBps', args: [BigInt(newEshareBurnTax)] })
  }
  
  const handleSetRageBurnTax = () => {
    if (!newRageBurnTax) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'setRageBurnTaxBps', args: [BigInt(newRageBurnTax)] })
  }
  
  const handleSetAllTaxes = () => {
    if (!newFixedBackingTax || !newLinearBackingTax || !newEshareBurnTax || !newRageBurnTax) return
    writeContract({ 
      address: CONTRACTS.GGX, 
      abi: GGX_ABI, 
      functionName: 'setAllTaxes', 
      args: [BigInt(newFixedBackingTax), BigInt(newLinearBackingTax), BigInt(newEshareBurnTax), BigInt(newRageBurnTax)] 
    })
  }
  
  const handleRescueToken = (contract: 'ggx' | 'zap') => {
    if (!rescueToken || !rescueAmount) return
    writeContract({ 
      address: contract === 'ggx' ? CONTRACTS.GGX : CONTRACTS.GGXZap, 
      abi: contract === 'ggx' ? GGX_ABI : ZAP_ABI, 
      functionName: 'rescueToken', 
      args: [rescueToken as `0x${string}`, parseUnits(rescueAmount, 18)] 
    })
  }
  
  // Burn ERAGE handler — admin can burn ERAGE from their own balance
  const handleBurnERAGE = () => {
    if (!burnErageAmount || parseFloat(burnErageAmount) <= 0) return
    writeContract({
      address: CONTRACTS.GGX,
      abi: GGX_ABI,
      functionName: 'burn',
      args: [parseUnits(burnErageAmount, 18)]
    })
  }
  
  // v5: ERAGE emergency drain is a 3-step timelocked flow
  const handleInitiateEmergencyDrain = () => {
    if (!confirm('Start 48-hour emergency drain countdown?\n\nUsers can still mint/redeem during the window.\nYou must come back after 48h to execute.')) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'initiateEmergencyDrain', args: [] })
  }

  const handleCancelEmergencyDrain = () => {
    if (!confirm('Cancel the pending emergency drain?')) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'cancelEmergencyDrain', args: [] })
  }

  const handleExecuteEmergencyDrain = () => {
    if (!confirm('Execute drain NOW?\n\nThis pauses the contract permanently and sends ALL ESHARE, RAGE, and ERAGE to the owner wallet.\nContract becomes unusable after this.')) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'executeEmergencyDrain', args: [] })
  }

  // Zap emergencyWithdraw (ESHARE + RAGE + ERAGE) and rescueETH
  const handleZapEmergencyWithdraw = () => {
    if (!confirm('Withdraw all ESHARE, RAGE, and ERAGE from the Zap contract to owner?')) return
    writeContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'emergencyWithdraw', args: [] })
  }

  const handleZapRescueETH = () => {
    writeContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'rescueETH', args: [] })
  }
  
  // ============ RENDER ============
  if (!mounted) {
    return (
      <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#FF6B35] to-[#E55A2B]" />
          <div className="h-4 w-32 bg-white/10 rounded" />
        </div>
      </div>
    )
  }
  
  return (
    <div className="h-screen lg:h-screen bg-[#0A0A0B] text-white overflow-y-auto lg:overflow-hidden">
      {/* Background Effects */}
      <div className="fixed inset-0 pointer-events-none">
        <img src="/ERAGE-background.webp" alt="" className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-[#0A0A0B]/85" />
      </div>
      <div className="noise-overlay" />
      
      <div className="relative z-10 min-h-full lg:h-full flex flex-col lg:overflow-hidden">
        {/* Header */}
        <header className="px-3 sm:px-4 py-1" style={{ background: 'transparent' }}>
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <img src="/ERAGE-logo.webp" className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl object-cover shadow-lg shadow-[#FF6B35]/20 shrink-0" alt="GGX" />
              <div className="min-w-0">
                <h1 className="text-sm sm:text-lg font-bold tracking-tight truncate">ERAGE Protocol</h1>
              </div>
              <span className="hidden sm:flex items-center gap-1 px-2 py-1 text-[10px] bg-[#3B82F6]/10 text-[#3B82F6] rounded-full border border-[#3B82F6]/20">
                <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6] animate-pulse" />
                Base
              </span>

            </div>
            
            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              {isConnected ? (
                <>
                  <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 sm:py-2 bg-white/5 rounded-xl border border-white/10">
                    <div className="w-2 h-2 rounded-full bg-[#10B981]" />
                    <span className="text-xs sm:text-sm font-mono">{address?.slice(0, 4)}...{address?.slice(-3)}</span>
                  </div>
                  <button 
                    onClick={() => setShowAdmin(!showAdmin)}
                    className={`p-1.5 sm:p-2 rounded-xl border transition-all ${showAdmin ? 'bg-[#F59E0B]/20 border-[#F59E0B]/30 text-[#F59E0B]' : 'bg-white/5 border-white/10 text-gray-400 hover:text-white'}`}
                  >
                    <Settings size={14} className="sm:hidden" /><Settings size={18} className="hidden sm:block" />
                  </button>
                  <button 
                    onClick={handleRefresh}
                    className="p-1.5 sm:p-2 bg-white/5 hover:bg-white/10 rounded-xl border border-white/10 transition-all"
                    title="Refresh data"
                  >
                    <RefreshCw size={14} className="sm:hidden" /><RefreshCw size={16} className="hidden sm:block" />
                  </button>
                  <button onClick={() => disconnect()} className="px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm bg-white/5 hover:bg-white/10 rounded-xl border border-white/10 transition-all">Disc.</button>
                </>
              ) : (
                <button onClick={() => connect({ connector: connectors[0] })} disabled={isConnecting} className="px-3 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm btn-primary rounded-xl font-medium disabled:opacity-50 flex items-center gap-2">
                  <Wallet size={14} className="sm:hidden" /><Wallet size={16} className="hidden sm:block" /> Connect
                </button>
              )}
            </div>
          </div>
        </header>
        
        {/* Main Content */}
        <main className="flex-1 max-w-7xl mx-auto w-full px-2 sm:px-3 py-1 pb-4 lg:pb-1 lg:min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 lg:min-h-0 flex flex-col">
              {/* Main Grid — mobile scrolls naturally, desktop uses viewport-locked layout */}
              <div className="flex-1 grid grid-cols-12 gap-2 min-h-0 lg:overflow-hidden">
                {/* Left Column */}
                <div className="col-span-12 lg:col-span-5 flex flex-col gap-2 lg:min-h-0 lg:overflow-y-auto">
                  {/* Top Row - 3 columns on desktop, 1 col on mobile */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" style={{ minHeight: '80px' }}>
                    {/* Backing Ratio */}
                    <div className="stat-card rounded-xl bg-gradient-to-br from-[#FF6B35]/15 to-[#1a1a1c]/90 border border-white/6 p-2 flex flex-col transition-all duration-300 hover:brightness-110 hover:border-white/12">
                      <div>
                        <p className="text-[10px] text-gray-400 uppercase tracking-wider">Backing Ratio</p>
                        <p className="text-lg sm:text-xl font-bold font-mono gradient-text">
                          {formatRatio(backingRatio?.[0] && backingRatio?.[1] ? (backingRatio[0] + backingRatio[1]) : undefined)}
                        </p>
                        <p className="text-[10px] text-gray-500 flex items-center gap-1">
                          <img src="/eshare-logo.webp" className="w-4 h-4 rounded object-cover" alt="ES" /> <span className="text-sm font-bold text-gray-300 mx-0.5">+</span> <img src="/rage-logo.webp" className="w-4 h-4 rounded object-cover" alt="RA" /> per ERAGE
                        </p>
                        {(estimatedAPR !== null || estimated30dAPR !== null) && (
                          <div className="mt-2 pt-1.5 border-t border-white/10 space-y-1.5">
                            {estimatedAPR !== null && (
                              <div className="text-center">
                                <p className="text-xs text-gray-400 font-medium">Live APR</p>
                                <p className="text-base font-bold flex items-center justify-center gap-1.5">
                                  <span className="text-[#10B981] animate-apr-glow" style={{ animationDuration: '0.6s' }}>~{Math.round(estimatedAPR.rate)}%</span>
                                  <span className="text-[10px] text-gray-500">
                                    {estimatedAPR.minutesElapsed === -1
                                      ? 'on-chain est.'
                                      : estimatedAPR.minutesElapsed >= 1440
                                        ? `24hr est.`
                                        : estimatedAPR.minutesElapsed >= 60
                                          ? `${(estimatedAPR.minutesElapsed / 60).toFixed(0)}hr est.`
                                          : `${estimatedAPR.minutesElapsed}m est.`}
                                  </span>
                                </p>
                              </div>
                            )}
                            {estimatedAPR !== null && estimated30dAPR !== null && (
                              <div className="border-t border-white/10" />
                            )}
                            {estimated30dAPR !== null && (
                              <div className="text-center">
                                <p className="text-xs text-gray-400 font-medium">30D APR</p>
                                <p className="text-base font-bold flex items-center justify-center gap-1.5">
                                  <span className="text-[#10B981] animate-apr-glow">~{estimated30dAPR.rate.toFixed(1)}%</span>
                                  <span className="text-[10px] text-gray-500">30d est.</span>
                                </p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    
                    {/* GGX Supply */}
                    <div className="stat-card rounded-xl bg-gradient-to-br from-[#3B82F6]/15 to-[#1a1a1c]/90 border border-white/6 p-2 transition-all duration-300 hover:brightness-110 hover:border-white/12">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] text-gray-400 uppercase tracking-wider">ERAGE Supply</p>
                        {isPaused && <span className="text-[9px] text-[#EF4444] font-semibold">PAUSED</span>}
                      </div>
                      <p className="text-lg sm:text-xl font-bold font-mono">{formatNum(ggxSupply)}</p>
                      {ggxBackingValueUsd > 0 && (
                        <div className="mt-1 pt-1 border-t border-white/10">
                          <p className="text-[10px] text-gray-400">Backing Price</p>
                          <p className="text-base font-semibold text-[#FFD700]">${formatPrice(ggxBackingValueUsd)}</p>
                        </div>
                      )}
                      <div className="mt-1 pt-1 border-t border-white/10">
                        <div className="flex justify-between items-center">
                          <p className="text-[10px] text-gray-400">ERAGE Price</p>
                          <a 
                            href={`https://app.uniswap.org/swap?inputCurrency=ETH&outputCurrency=${CONTRACTS.GGX}&chain=base`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-[#10B981] hover:text-[#34D399] flex items-center gap-0.5 transition-colors"
                          >
                            Swap <ArrowUpRight size={10} />
                          </a>
                        </div>
                        <p className="text-base font-semibold text-[#10B981]">
                          {prices.ggxPrice > 0 
                            ? `$${formatPrice(prices.ggxPrice * prices.ethPriceUsd)}` 
                            : ggxBackingValueUsd > 0 
                              ? `$${formatPrice(ggxBackingValueUsd)}` 
                              : '—'}
                        </p>
                        {prices.ggxPrice > 0 && (
                          <p className="text-[9px] text-gray-500">
                            {formatPrice(prices.ggxPrice)} ETH
                          </p>
                        )}
                      </div>
                    </div>
                    
                    {/* Combined ESHARE & RAGE Backing */}
                    <div className="relative group">
                      <div className="absolute inset-0 bg-gradient-to-br from-[#8B5CF6]/30 to-[#EF4444]/30 rounded-xl opacity-30 blur-lg" />
                      <div className="relative stat-card rounded-xl bg-gradient-to-br from-white/8 to-[#1a1a1c]/90 border border-white/6 p-2 h-full flex flex-col transition-all duration-300 hover:brightness-110 hover:border-white/12">
                        <div>
                          <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Protocol Backing</p>
                          
                          {/* ESHARE Row */}
                          <div className="flex items-center mb-0.5">
                            <div className="flex items-center gap-1">
                              <img src="/eshare-logo.webp" className="w-4 sm:w-5 h-4 sm:h-5 rounded object-cover" alt="ESHARE" />
                              <span className="text-[10px] sm:text-xs font-semibold text-[#8B5CF6]">ESHARE</span>
                            </div>
                            <span className="text-base font-semibold ml-auto">{backingBalances ? formatNum(backingBalances[0]) : '—'}</span>
                          </div>
                          
                          {/* RAGE Row */}
                          <div className="flex items-center mb-0.5">
                            <div className="flex items-center gap-1">
                              <img src="/rage-logo.webp" className="w-4 sm:w-5 h-4 sm:h-5 rounded object-cover" alt="RAGE" />
                              <span className="text-[10px] sm:text-xs font-semibold text-[#DC2626]">RAGE</span>
                            </div>
                            <span className="text-base font-semibold ml-auto">{backingBalances ? formatNum(backingBalances[1]) : '—'}</span>
                          </div>
                        </div>
                        
                        {/* Burnt Section */}
                        <div className="pt-1 border-t border-white/10">
                          <p className="text-[13px] text-gray-400 text-center mb-1 font-semibold">🔥 Burnt 🔥</p>
                          <div className="flex flex-col gap-0.5 text-xs">
                            <div className="flex items-center gap-1">
                              <img src="/eshare-logo.webp" className="w-3.5 h-3.5 rounded object-cover shrink-0" alt="ESHARE" />
                              <div className="flex gap-1 w-full"><span className="text-[#8B5CF6] font-semibold w-[50px]">ESHARE</span><span className="text-[#8B5CF6] font-semibold ml-auto">{burntAmounts.eshare > 0n ? formatNum(burntAmounts.eshare) : '—'}</span></div>
                            </div>
                            <div className="flex items-center gap-1">
                              <img src="/rage-logo.webp" className="w-3.5 h-3.5 rounded object-cover shrink-0" alt="RAGE" />
                              <div className="flex gap-1 w-full"><span className="text-[#DC2626] font-semibold w-[50px]">RAGE</span><span className="text-[#DC2626] font-semibold ml-auto">{burntAmounts.rage > 0n ? formatNum(burntAmounts.rage) : '—'}</span></div>
                            </div>
                            <div className="flex items-center gap-1">
                              <img src="/ERAGE-logo.webp" className="w-3.5 h-3.5 rounded object-cover shrink-0" alt="ERAGE" />
                              <div className="flex gap-1 w-full"><span className="text-[#F97316] font-semibold w-[50px]">ERAGE</span><span className="text-[#F97316] font-semibold ml-auto">{erageBurnt > 0n ? formatNum(erageBurnt) : '—'}</span></div>
                            </div>
                          </div>
                        </div>
                        
                        {/* Protocol TVL at bottom - single line */}
                        {backingBalances && prices.ethPriceUsd > 0 && (
                          <div className="mt-auto pt-1 border-t border-white/10">
                            <p className="text-[12px] font-semibold text-[#FFD700] text-center">
                              Protocol TVL = ${formatPrice((
                                parseFloat(formatUnits(backingBalances[0], 18)) * prices.esharePrice * prices.ethPriceUsd +
                                parseFloat(formatUnits(backingBalances[1], 18)) * prices.ragePrice +
                                (ggxPoolWethBal ? parseFloat(formatUnits(ggxPoolWethBal, 18)) : 0) * prices.ethPriceUsd +
                                (ggxRagePoolRageBal ? parseFloat(formatUnits(ggxRagePoolRageBal, 18)) : 0) * prices.ragePrice +
                                (ggxEsharePoolEshareBal ? parseFloat(formatUnits(ggxEsharePoolEshareBal, 18)) : 0) * prices.esharePrice * prices.ethPriceUsd +
                                (erageRagePoolRageBal ? parseFloat(formatUnits(erageRagePoolRageBal, 18)) : 0) * prices.ragePrice +
                                (erageEsharePoolEshareBal ? parseFloat(formatUnits(erageEsharePoolEshareBal, 18)) : 0) * prices.esharePrice * prices.ethPriceUsd
                              ))}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {/* Ratio Chart with Time Range Buttons - grows to match mint/redeem box on desktop, natural height on mobile */}
                  <div className="lg:flex-1 card rounded-xl p-2 flex flex-col lg:min-h-0" style={{ minHeight: '200px' }}>
                    <div className="flex items-center justify-between mb-1">
                      <div>
                        <h3 className="text-xs sm:text-sm font-semibold flex items-center gap-1.5 flex-wrap">
                          <span className="w-2 h-2 rounded-full bg-[#10B981]"></span>
                          Price Efficiency UniSwap/Mint:{' '}
                          {priceEfficiencyRatio !== null && (
                            <span className="text-[#10B981]">{priceEfficiencyRatio.toFixed(3)}</span>
                          )}
                        </h3>
                      </div>
                      {/* Time Range Buttons */}
                      <div className="flex gap-1">
                        {(['4h', '1d', '1w', '2w'] as TimeRange[]).map((range) => (
                          <button
                            key={range}
                            onClick={() => setTimeRange(range)}
                            className={`px-2 py-0.5 text-[10px] rounded transition-all ${
                              timeRange === range 
                                ? 'bg-[#FF6B35] text-white' 
                                : 'bg-white/10 text-gray-400 hover:bg-white/20'
                            }`}
                          >
                            {range}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="lg:flex-1 min-h-[120px] lg:min-h-[80px]">
                      <RatioChart history={backingRatioHistory} priceEfficiencyHistory={priceEfficiencyHistory} timeRange={timeRange} currentRatio={priceEfficiencyRatio} />
                    </div>
                    {/* Strategy Guide */}
                    <div className="mt-1 pt-1 border-t border-white/5 text-[10px] text-gray-400">
                      <p className="text-[11px] text-gray-300 font-semibold mb-0.5 text-center">Arbitrage Strategies</p>
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-start gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-[#10B981] mt-0.5 shrink-0"></span><span className="text-[#10B981]">Green Zone Efficiency</span><span className="text-gray-400">: MINT ERAGE (cheaper) → Sell on UniSwap (capture premium)</span></div>
                        <div className="flex items-start gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-[#3B82F6] mt-0.5 shrink-0"></span><span className="text-[#3B82F6]">Neutral Zone Efficiency</span><span className="text-gray-400">: MINT ERAGE or Hold</span></div>
                        <div className="flex items-start gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-[#EF4444] mt-0.5 shrink-0"></span><span className="text-[#EF4444]">Red Zone Efficiency</span><span className="text-gray-400">: BUY on UniSwap (cheaper) → Redeem (full backing value)</span></div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Right Column - Unified Action Box */}
                <div className="col-span-12 lg:col-span-7 flex flex-col gap-2 lg:min-h-0 lg:overflow-y-auto">
                  <div className="lg:flex-1 card rounded-xl p-2 flex flex-col lg:min-h-0">
                    <div className="shrink-0 space-y-1">
                      <div className="flex gap-2">
                        <div className="flex-1 flex flex-col items-center gap-0.5">
                          <p className="text-[11px] text-[#10B981] font-semibold">Mint</p>
                          <button 
                            onClick={() => { setInputToken('ETH'); setInputAmount(''); setEshareInput(''); setRageInput(''); }}
                            className={`w-full py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1 ${
                              inputToken === 'ETH' 
                                ? 'bg-[#FF6B35] text-white' 
                                : 'bg-white/5 text-gray-400 hover:text-white border border-white/10'
                            }`}
                          >
                            <Zap size={12} /> ETH
                          </button>
                        </div>
                        <div className="flex-1 flex flex-col items-center gap-0.5">
                          <p className="text-[11px] text-[#10B981] font-semibold">Mint</p>
                          <button 
                            onClick={() => { setInputToken('ESHARE_RAGE'); setInputAmount(''); setEshareInput(''); setRageInput(''); }}
                            className={`w-full py-2 rounded-lg text-xs font-medium transition-all ${
                              inputToken === 'ESHARE_RAGE' 
                                ? 'bg-[#8B5CF6] text-white' 
                                : 'bg-white/5 text-gray-400 hover:text-white border border-white/10'
                            }`}
                          >
                            ESHARE + RAGE
                          </button>
                        </div>
                        <div className="flex-1 flex flex-col items-center gap-0.5">
                          <p className="text-[11px] text-[#A855F7] font-semibold">Redeem</p>
                          <button 
                            onClick={() => { setInputToken('GGX'); setInputAmount(''); setEshareInput(''); setRageInput(''); }}
                            className={`w-full py-2 rounded-lg text-xs font-medium transition-all ${
                              inputToken === 'GGX' 
                                ? 'bg-[#3B82F6] text-white' 
                                : 'bg-white/5 text-gray-400 hover:text-white border border-white/10'
                            }`}
                          >
                            ERAGE
                          </button>
                        </div>
                      </div>

                      {/* Separator line under tabs */}
                      <div className="mt-0.5 border-t border-white/10"></div>
                      
                      {/* Input Section — fixed min-height keeps layout stable across tab switches */}
                      <div className="mt-0.5 min-h-[52px]">
                      {inputToken === 'ESHARE_RAGE' ? (
                        // Dual input for ESHARE + RAGE — stacked on mobile, row on desktop
                        <div className="flex flex-col sm:flex-row gap-2">
                          <div className="flex gap-2 flex-1">
                            <div className="bg-[#8B5CF6]/10 rounded-lg px-2 sm:px-3 py-2 text-sm font-medium flex items-center border border-[#8B5CF6]/20 shrink-0">
                              <img src="/eshare-logo.webp" className="w-5 h-5 rounded object-cover" alt="ES" />
                            </div>
                            <div className="flex-1 relative bg-[#8B5CF6]/5 border border-[#8B5CF6]/20 rounded-lg px-3 py-2">
                              <input 
                                type="number" 
                                value={eshareInput} 
                                onChange={(e) => {
                                  const val = e.target.value
                                  setEshareInput(val)
                                  if (backingRatio && backingRatio[0] && backingRatio[1]) {
                                    const esharePerGGX = parseFloat(formatUnits(backingRatio[0], 18))
                                    const ragePerGGX = parseFloat(formatUnits(backingRatio[1], 18))
                                    const numVal = parseFloat(val)
                                    if (esharePerGGX > 0 && !isNaN(numVal) && numVal > 0) {
                                      const ratio = ragePerGGX / esharePerGGX
                                      const rageAmount = numVal * ratio
                                      const rageRounded = Math.floor(rageAmount * 1000000) / 1000000
                                      setRageInput(rageRounded.toString())
                                    }
                                  }
                                }} 
                                placeholder="0.00" 
                                className="w-full bg-transparent text-base font-mono focus:outline-none" 
                              />
                              <button 
                                onClick={() => {
                                  if (eshareBal) {
                                    const rawBalance = parseFloat(formatUnits(eshareBal, 18))
                                    const roundedDown = Math.floor(rawBalance * 1000000) / 1000000
                                    setEshareInput(roundedDown.toString())
                                    if (backingRatio && backingRatio[0] && backingRatio[1]) {
                                      const esharePerGGX = parseFloat(formatUnits(backingRatio[0], 18))
                                      const ragePerGGX = parseFloat(formatUnits(backingRatio[1], 18))
                                      if (esharePerGGX > 0) {
                                        const ratio = ragePerGGX / esharePerGGX
                                        const rageAmount = roundedDown * ratio
                                        const rageRounded = Math.floor(rageAmount * 1000000) / 1000000
                                        setRageInput(rageRounded.toString())
                                      }
                                    }
                                  }
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#8B5CF6] hover:text-[#A78BFA] font-medium"
                              >
                                MAX
                              </button>
                            </div>
                          </div>
                          <div className="flex gap-2 flex-1">
                            <div className="bg-[#EF4444]/10 rounded-lg px-2 sm:px-3 py-2 text-sm font-medium flex items-center border border-[#EF4444]/20 shrink-0">
                              <img src="/rage-logo.webp" className="w-5 h-5 rounded object-cover" alt="RA" />
                            </div>
                            <div className="flex-1 relative bg-[#EF4444]/5 border border-[#EF4444]/20 rounded-lg px-3 py-2">
                              <input 
                                type="number" 
                                value={rageInput} 
                                onChange={(e) => {
                                  const val = e.target.value
                                  setRageInput(val)
                                  if (backingRatio && backingRatio[0] && backingRatio[1]) {
                                    const esharePerGGX = parseFloat(formatUnits(backingRatio[0], 18))
                                    const ragePerGGX = parseFloat(formatUnits(backingRatio[1], 18))
                                    const numVal = parseFloat(val)
                                    if (ragePerGGX > 0 && !isNaN(numVal) && numVal > 0) {
                                      const ratio = esharePerGGX / ragePerGGX
                                      const eshareAmount = numVal * ratio
                                      const eshareRounded = Math.floor(eshareAmount * 1000000) / 1000000
                                      setEshareInput(eshareRounded.toString())
                                    }
                                  }
                                }} 
                                placeholder="0.00" 
                                className="w-full bg-transparent text-base font-mono focus:outline-none" 
                              />
                              <button 
                                onClick={() => {
                                  if (rageBal) {
                                    const rawBalance = parseFloat(formatUnits(rageBal, 18))
                                    const roundedDown = Math.floor(rawBalance * 1000000) / 1000000
                                    setRageInput(roundedDown.toString())
                                    if (backingRatio && backingRatio[0] && backingRatio[1]) {
                                      const esharePerGGX = parseFloat(formatUnits(backingRatio[0], 18))
                                      const ragePerGGX = parseFloat(formatUnits(backingRatio[1], 18))
                                      if (ragePerGGX > 0) {
                                        const ratio = esharePerGGX / ragePerGGX
                                        const eshareAmount = roundedDown * ratio
                                        const eshareRounded = Math.floor(eshareAmount * 1000000) / 1000000
                                        setEshareInput(eshareRounded.toString())
                                      }
                                    }
                                  }
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#EF4444] hover:text-[#F87171] font-medium"
                              >
                                MAX
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <div className="bg-[#1a1a1c]/80 rounded-lg px-3 py-2.5 text-sm font-medium flex items-center gap-2">
                              {inputToken === 'ETH' && <span className="text-[#FF6B35]">ETH</span>}
                              {inputToken === 'GGX' && <span className="text-[#3B82F6]">ERAGE</span>}
                            </div>
                            
                            <div className="flex-1 relative bg-[#141416]/90 border border-white/10 rounded-lg px-3 py-2">
                              <input 
                                type="number" 
                                value={inputAmount} 
                                onChange={(e) => setInputAmount(e.target.value)} 
                                placeholder="0.00" 
                                className="w-[calc(100%-90px)] bg-transparent text-base font-mono focus:outline-none" 
                              />
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
                                {inputAmount && parseFloat(inputAmount) > 0 && (
                                  <span className="text-[11px] text-[#10B981] shrink-0">
                                    {inputToken === 'ETH' && prices.ethPriceUsd > 0 
                                      ? `$${(parseFloat(inputAmount) * prices.ethPriceUsd).toFixed(2)}`
                                      : inputToken === 'GGX' && prices.ggxPriceUsd > 0
                                        ? `$${(parseFloat(inputAmount) * prices.ggxPriceUsd).toFixed(2)}`
                                        : ''}
                                  </span>
                                )}
                                <button 
                                  onClick={() => {
                                    // For GGX redeem, round down to avoid failed transactions
                                    if (inputToken === 'GGX' && ggxBal) {
                                      const rawBalance = parseFloat(formatUnits(ggxBal, 18))
                                      // Round down to 6 decimal places to avoid precision issues
                                      const roundedDown = Math.floor(rawBalance * 1000000) / 1000000
                                      setInputAmount(roundedDown.toString())
                                    } else if (inputToken === 'ETH') {
                                      // Use 90% of ETH balance to leave gas reserve
                                      const ninetyPct = Math.floor(selectedBalance * 0.9 * 1000000) / 1000000
                                      setInputAmount(ninetyPct > 0 ? ninetyPct.toString() : '0')
                                    } else {
                                      setInputAmount(selectedBalance.toString())
                                    }
                                  }}
                                  className="text-[10px] text-[#FF6B35] hover:text-[#FF8A5C] font-medium"
                                >
                                  MAX
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      </div>

                      {/* Output Preview - fixed min-height prevents layout shift on tab switch */}
                      <div className="mt-0.5 min-h-[28px]">
                      {inputToken === 'GGX' ? (
                        // Redeem output
                        redeemOutput ? (
                          <div className="bg-[#141416]/80 rounded-lg px-2 py-0.5">
                            <div className="flex items-center justify-between">
                              <p className="text-[10px] text-gray-400">You Receive</p>
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-[#8B5CF6]">{formatNum(redeemOutput[0])} ESHARE</span>
                                <span className="text-xs font-semibold text-[#EF4444]">{formatNum(redeemOutput[1])} RAGE</span>
                                {prices.esharePrice > 0 && prices.ethPriceUsd > 0 && prices.ragePrice > 0 && (
                                  <span className="text-[10px] text-gray-400">${(parseFloat(formatUnits(redeemOutput[0], 18)) * prices.esharePrice * prices.ethPriceUsd + parseFloat(formatUnits(redeemOutput[1], 18)) * prices.ragePrice).toFixed(2)}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="bg-[#141416]/80 rounded-lg px-2 py-0.5">
                            <div className="flex items-center justify-between">
                              <p className="text-[10px] text-gray-400">You Receive</p>
                              {isFetchingRedeemOutput && inputAmount && parseFloat(inputAmount) > 0 ? (
                                <div className="flex items-center gap-1">
                                  <div className="w-2.5 h-2.5 border border-[#10B981] border-t-transparent rounded-full animate-spin" />
                                  <p className="text-[10px] text-gray-500">Calculating...</p>
                                </div>
                              ) : (
                                <p className="text-xs font-semibold text-[#10B981]">—</p>
                              )}
                            </div>
                          </div>
                        )
                      ) : (
                        // Mint output
                        <div className="bg-[#141416]/80 rounded-lg px-2 py-0.5">
                          {inputToken === 'ESHARE_RAGE' && mintOutputEshare && (
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <p className="text-[10px] text-gray-400">You Receive (est.)</p>
                                <p className="text-xs font-semibold text-[#10B981]">~ {formatNum(mintOutputEshare[0])} ERAGE</p>
                              </div>
                              {prices.ggxPriceUsd > 0 && (
                                <p className="text-[10px] text-[#10B981]">${(parseFloat(formatUnits(mintOutputEshare[0], 18)) * prices.ggxPriceUsd).toFixed(2)}</p>
                              )}
                            </div>
                          )}
                          {inputToken === 'ESHARE_RAGE' && !mintOutputEshare && isFetchingMintOutput && eshareInput && parseFloat(eshareInput) > 0 && (
                            <div className="flex items-center gap-1">
                              <p className="text-[10px] text-gray-400">You Receive (est.)</p>
                              <div className="w-2.5 h-2.5 border border-[#10B981] border-t-transparent rounded-full animate-spin" />
                              <p className="text-[10px] text-gray-500">Calculating...</p>
                            </div>
                          )}
                          {inputToken === 'ESHARE_RAGE' && !mintOutputEshare && !isFetchingMintOutput && (
                            <div className="flex items-center gap-1.5">
                              <p className="text-[10px] text-gray-400">You Receive (est.)</p>
                              <p className="text-xs font-semibold text-gray-500">—</p>
                            </div>
                          )}
                          {inputToken === 'ETH' && estimatedGgxFromEth && (
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-1.5">
                                <p className="text-[10px] text-gray-400">You Receive (est.)</p>
                                <p className="text-xs font-semibold text-[#10B981]">~ {estimatedGgxFromEth.toFixed(4)} ERAGE</p>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {prices.ggxPriceUsd > 0 && (
                                  <p className="text-[10px] text-[#10B981]">${(estimatedGgxFromEth * prices.ggxPriceUsd).toFixed(2)}</p>
                                )}
                                <p className="text-[9px] text-[#F59E0B]">incl. 0.69% zap fee</p>
                              </div>
                            </div>
                          )}
                          {inputToken === 'ETH' && !estimatedGgxFromEth && inputAmount && parseFloat(inputAmount) > 0 && (
                            <div className="flex items-center gap-1">
                              <p className="text-[10px] text-gray-400">You Receive (est.)</p>
                              <div className="w-2.5 h-2.5 border border-[#10B981] border-t-transparent rounded-full animate-spin" />
                              <p className="text-[10px] text-gray-500">Fetching price...</p>
                            </div>
                          )}
                          {inputToken === 'ETH' && !estimatedGgxFromEth && (!inputAmount || parseFloat(inputAmount) === 0) && (
                            <div className="flex items-center gap-1.5">
                              <p className="text-[10px] text-gray-400">You Receive (est.)</p>
                              <p className="text-xs font-semibold text-gray-500">—</p>
                            </div>
                          )}
                        </div>
                      )}
                      </div>
                      
                      {/* V3 Route Info for ETH - removed as requested */}
                      
                      {/* All Balances */}
                      {isConnected ? (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-sm">
                        <div className="relative bg-[#141416]/80 rounded-lg py-1.5 px-2 border border-[#FF6B35]/15">
                          <a href={`https://app.uniswap.org/swap?inputCurrency=${CONTRACTS.USDC}&outputCurrency=${CONTRACTS.WETH}&chain=base`} target="_blank" rel="noopener noreferrer" className="absolute top-1 right-1.5 text-[9px] text-gray-400/60 hover:text-gray-300 flex items-center gap-0.5 transition-colors">Swap <ArrowUpRight size={8} /></a>
                          <p className="text-[11px] text-gray-400 text-center">ETH</p>
                          <p className="font-mono text-[11px] sm:text-[13px] text-center leading-tight">{ethBal ? parseFloat(formatUnits(ethBal.value, ethBal.decimals)).toFixed(4) : '0.0000'}</p>
                          <p className="text-[10px] text-[#10B981] text-center leading-tight">{ethBal && prices.ethPriceUsd > 0 ? `$${formatPrice(parseFloat(formatUnits(ethBal.value, ethBal.decimals)) * prices.ethPriceUsd)}` : '—'}</p>
                        </div>
                        <div className="relative bg-[#141416]/80 rounded-lg py-1.5 px-2 border border-[#FF6B35]/15">
                          <CopyAddr address={CONTRACTS.ESHARE} color="#8B5CF6" />
                          <a href={`https://app.uniswap.org/swap?inputCurrency=ETH&outputCurrency=${CONTRACTS.ESHARE}&chain=base`} target="_blank" rel="noopener noreferrer" className="absolute top-1 right-1.5 text-[9px] text-[#8B5CF6]/60 hover:text-[#8B5CF6] flex items-center gap-0.5 transition-colors">Swap <ArrowUpRight size={8} /></a>
                          <p className="text-[11px] text-[#8B5CF6] text-center">ESHARE</p>
                          <p className="font-mono text-[11px] sm:text-[13px] text-center leading-tight">{formatNum(eshareBal)}</p>
                          <p className="text-[10px] text-[#10B981] text-center leading-tight">{eshareBal && prices.esharePrice > 0 && prices.ethPriceUsd > 0 ? `$${formatPrice(parseFloat(formatUnits(eshareBal, 18)) * prices.esharePrice * prices.ethPriceUsd)}` : '—'}</p>
                        </div>
                        <div className="relative bg-[#141416]/80 rounded-lg py-1.5 px-2 border border-[#FF6B35]/15">
                          <CopyAddr address={CONTRACTS.RAGE} color="#EF4444" />
                          <a href={`https://app.uniswap.org/swap?inputCurrency=ETH&outputCurrency=${CONTRACTS.RAGE}&chain=base`} target="_blank" rel="noopener noreferrer" className="absolute top-1 right-1.5 text-[9px] text-[#EF4444]/60 hover:text-[#EF4444] flex items-center gap-0.5 transition-colors">Swap <ArrowUpRight size={8} /></a>
                          <p className="text-[11px] text-[#EF4444] text-center">RAGE</p>
                          <p className="font-mono text-[11px] sm:text-[13px] text-center leading-tight">{formatNum(rageBal)}</p>
                          <p className="text-[10px] text-[#10B981] text-center leading-tight">{rageBal && prices.ragePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(rageBal, 18)) * prices.ragePrice)}` : '—'}</p>
                        </div>
                        <div className="relative bg-[#141416]/80 rounded-lg py-1.5 px-2 border border-[#FF6B35]/15">
                          <CopyAddr address={CONTRACTS.GGX} color="#FF6B35" />
                          <a href={`https://app.uniswap.org/swap?inputCurrency=ETH&outputCurrency=${CONTRACTS.GGX}&chain=base`} target="_blank" rel="noopener noreferrer" className="absolute top-1 right-1.5 text-[9px] text-[#FF6B35]/60 hover:text-[#FF6B35] flex items-center gap-0.5 transition-colors">Swap <ArrowUpRight size={8} /></a>
                          <p className="text-[11px] text-[#FF6B35] text-center">ERAGE</p>
                          <p className="font-mono text-[11px] sm:text-[13px] text-center leading-tight">{formatNum(ggxBal)}</p>
                          <p className="text-[10px] text-[#10B981] text-center leading-tight">{ggxBal && prices.ggxPriceUsd > 0 ? `$${formatPrice(parseFloat(formatUnits(ggxBal, 18)) * prices.ggxPriceUsd)}` : '—'}</p>
                        </div>
                      </div>
                      ) : (
                      <div className="text-center py-2 px-3 bg-white/5 rounded-lg border border-white/10">
                        <p className="text-xs text-gray-400">Connect wallet to view your balances</p>
                      </div>
                      )}
                      
                      {/* Slippage / Redeem info — always renders to keep action button stable */}
                      <div className="space-y-1">
                          {inputToken !== 'GGX' && slippageMode === 'manual' && (
                            <div className="flex items-center gap-1 rounded px-1 bg-[#FF6B35]/20 border border-[#FF6B35]/40">
                              <input
                                type="number"
                                step="0.1"
                                min="0.1"
                                max="15"
                                value={slippageManual}
                                onChange={(e) => setSlippageManual(e.target.value)}
                                placeholder="Manual"
                                className="w-full bg-transparent text-[11px] py-1 px-1 focus:outline-none"
                              />
                              <span className="text-[10px] text-gray-400">% (max 15)</span>
                            </div>
                          )}
                          <p className="text-[9px] text-gray-500 leading-snug text-center">
                            {inputToken !== 'GGX' ? (
                              <>
                                <button
                                  onClick={() => {
                                    if (slippageMode === 'auto') {
                                      setSlippageManual(autoSlippagePct.toFixed(2))
                                      setSlippageMode('manual')
                                    } else {
                                      setSlippageMode('auto')
                                    }
                                  }}
                                  className="text-[9px] text-[#FF6B35] hover:text-[#FF8C5A] font-semibold"
                                >
                                  Auto-Slippage -Adjust-
                                </button>
                                {inputToken === 'ETH' && ' Recommended: 1 ETH or less per mint.'}
                              </>
                            ) : (
                              'Redeem ERAGE for full 1:1 ESHARE+RAGE backing'
                            )}
                          </p>
                          {inputToken !== 'GGX' && slippagePct >= SLIPPAGE_MAX_PCT && (
                            <p className="text-[9px] text-[#FFD700] flex items-center gap-1">
                              <AlertTriangle size={9} /> At max slippage — trade size is large vs pool liquidity. Consider splitting into smaller mints.
                            </p>
                          )}
                      </div>

                      {/* Action Buttons */}
                      {!isConnected ? (
                        <button 
                          onClick={() => connect({ connector: connectors[0] })} 
                          disabled={isConnecting}
                          className="w-full py-2.5 rounded-lg text-sm font-semibold btn-primary disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          <Wallet size={16} /> Connect Wallet
                        </button>
                      ) : inputToken === 'ESHARE_RAGE' && needsApproval ? (
                        <div className="flex gap-2">
                          <button 
                            onClick={handleApproveEshare} 
                            disabled={isLoading || !eshareInput || parseFloat(eshareInput) === 0 || !needsEshareApproval}
                            className={`w-1/2 py-2.5 rounded-lg text-sm font-semibold bg-[#8B5CF6] hover:bg-[#8B5CF6]/80 ${needsEshareApproval ? '' : 'opacity-30 cursor-not-allowed'}`}
                          >
                            Approve ESHARE
                          </button>
                          <button 
                            onClick={handleApproveRage} 
                            disabled={isLoading || !rageInput || parseFloat(rageInput) === 0 || !needsRageApproval}
                            className={`w-1/2 py-2.5 rounded-lg text-sm font-semibold bg-[#8B5CF6] hover:bg-[#8B5CF6]/80 ${needsRageApproval ? '' : 'opacity-30 cursor-not-allowed'}`}
                          >
                            Approve RAGE
                          </button>
                        </div>
                      ) : (
                        <button 
                          onClick={handleAction} 
                          disabled={
                            isLoading || 
                            (inputToken === 'GGX' && (!inputAmount || parseFloat(inputAmount) === 0)) ||
                            (inputToken === 'ETH' && (!inputAmount || parseFloat(inputAmount) === 0)) ||
                            (inputToken === 'ESHARE_RAGE' && 
                              (!eshareInput || parseFloat(eshareInput) === 0) && 
                              (!rageInput || parseFloat(rageInput) === 0))
                          } 
                          className={`w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50 ${
                            inputToken === 'GGX'
                              ? 'bg-[#3B82F6] hover:bg-[#3B82F6]/80'
                              : 'btn-primary'
                          }`}
                        >
                          {actionButtonText}
                        </button>
                      )}
                    </div>

                    {/* Widget + Logo side by side — tall min-height on mobile (natural scroll), flex-1 on desktop (viewport-locked) */}
                    <div className="flex flex-col border-t border-white/10 pt-1.5 mt-1 flex-1 min-h-[620px] lg:min-h-0">
                      <div className="flex-1 flex gap-2 items-stretch min-h-0">
                        <div className="flex-1 min-w-0 min-h-0">
                          <UniswapWidget ggxAddress={CONTRACTS.GGX} />
                        </div>
                        <div className="hidden sm:flex shrink-0 items-center justify-center">
                          <img src="/ERAGE-logo.webp" className="w-16 h-16 sm:w-20 sm:h-20 lg:w-48 lg:h-48 object-contain opacity-60" alt="ERAGE" />
                        </div>
                      </div>
                      {/* Links row — always visible, never clipped */}
                      <div className="shrink-0 flex items-center justify-end text-[9px] text-gray-500 pt-1 border-t border-white/5">
                        <div className="flex items-center gap-2.5">
                          <a href="https://t.me/+ZDuHXsPY1Jg3MmU5" target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 hover:text-white transition-colors"><MessageCircle size={9} /> Telegram</a>
                          <a href="/ERAGE_Whitepaper_v2.pdf" target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 hover:text-white transition-colors"><FileText size={9} /> Docs</a>
                          <a href="https://ultraroundmoney.com" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">UltraRound</a>
                          <a href="https://plazm.io" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Plazm</a>
                          <a href="https://fusion.emp.money" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Fusion</a>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* User Info Panel — visible for all connected wallets */}
              {isConnected && !isAdmin && showAdmin && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowAdmin(false)}>
                  {/* Backdrop */}
                  <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
                  {/* Modal */}
                  <div className="relative w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl bg-[#0F0F10] border border-[#FF6B35]/30 shadow-2xl shadow-[#FF6B35]/10" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between px-4 py-3 bg-[#FF6B35]/10 border-b border-[#FF6B35]/20 sticky top-0 z-10 rounded-t-2xl">
                    <div className="flex items-center gap-2">
                      <Settings size={14} className="text-[#FF6B35]" />
                      <span className="text-sm font-semibold text-[#FF6B35]">ERAGE Protocol Info</span>
                    </div>
                    <button onClick={() => setShowAdmin(false)} className="text-gray-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10">✕</button>
                  </div>
                  
                  <div className="p-3 space-y-3">
                    {/* Burn ERAGE */}
                    <div className="bg-white/5 rounded-lg p-2 space-y-2">
                      <p className="text-[10px] text-[#F97316] uppercase">Burn ERAGE</p>
                      <input type="number" value={burnErageAmount} onChange={(e) => setBurnErageAmount(e.target.value)} placeholder="Amount to burn" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                      <button onClick={handleBurnERAGE} disabled={!burnErageAmount || parseFloat(burnErageAmount) <= 0 || isLoading} className="w-full py-1 text-[10px] bg-[#F97316]/20 text-[#F97316] rounded border border-[#F97316]/30 disabled:opacity-50 flex items-center justify-center gap-1"><Flame size={10} /> Burn</button>
                      <p className="text-[9px] text-gray-500">Your balance: {ggxBal ? formatNum(ggxBal) : '—'} ERAGE</p>
                    </div>

                    {/* Tax Summary */}
                    <div className="bg-white/5 rounded-lg p-2 space-y-1">
                      <p className="text-[10px] text-gray-400 uppercase">Tax Summary (v5 — Slippage Protected + 48h Timelock)</p>
                      <div className="grid grid-cols-2 gap-1 text-[9px]">
                        <div className="bg-[#10B981]/10 rounded p-1">
                          <span className="text-[#10B981]">Fixed:</span> {fixedBackingTaxBps?.toString() || '13'} BPS ({((Number(fixedBackingTaxBps || 13)) / 100).toFixed(2)}%)
                        </div>
                        <div className="bg-[#3B82F6]/10 rounded p-1">
                          <span className="text-[#3B82F6]">Linear:</span> {linearBackingTaxBps?.toString() || '69'} BPS ({((Number(linearBackingTaxBps || 69)) / 100).toFixed(2)}%)
                        </div>
                        <div className="bg-[#8B5CF6]/10 rounded p-1">
                          <span className="text-[#8B5CF6]">ES Burn:</span> {eshareBurnTaxBps?.toString() || '69'} BPS ({((Number(eshareBurnTaxBps || 69)) / 100).toFixed(2)}%)
                        </div>
                        <div className="bg-[#EF4444]/10 rounded p-1">
                          <span className="text-[#EF4444]">RA Burn:</span> {rageBurnTaxBps?.toString() || '69'} BPS ({((Number(rageBurnTaxBps || 69)) / 100).toFixed(2)}%)
                        </div>
                      </div>
                      <div className="mt-1 pt-1 border-t border-white/10 flex justify-between items-center text-[9px]">
                        <span className="text-gray-400">Total: {totalTaxBps?.toString() || '220'} BPS ({((Number(totalTaxBps || 220)) / 100).toFixed(2)}%)</span>
                        <span className="text-[#FFD700]">Round-trip: {((Number(totalTaxBps || 220)) * 2 / 100).toFixed(1)}%</span>
                      </div>
                      <p className="text-[9px] text-gray-500">Same tax on mint and redeem — ratio ratchets up both ways</p>
                    </div>

                    {/* TVL Breakdown */}
                    <div className="bg-white/5 rounded-lg p-2 space-y-1">
                      <p className="text-[10px] text-gray-400 uppercase">TVL Breakdown</p>
                      <div className="grid grid-cols-1 gap-2 text-[9px]">
                        <div className="bg-[#8B5CF6]/10 rounded p-1.5">
                          <p className="text-[#8B5CF6] font-semibold">ESHARE Backing</p>
                          <p className="text-white">{backingBalances ? formatNum(backingBalances[0]) : '—'} ES</p>
                          <p className="text-gray-400">{backingBalances && prices.esharePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(backingBalances[0], 18)) * prices.esharePrice * prices.ethPriceUsd)}` : '—'}</p>
                        </div>
                        <div className="bg-[#EF4444]/10 rounded p-1.5">
                          <p className="text-[#EF4444] font-semibold">RAGE Backing</p>
                          <p className="text-white">{backingBalances ? formatNum(backingBalances[1]) : '—'} RA</p>
                          <p className="text-gray-400">{backingBalances && prices.ragePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(backingBalances[1], 18)) * prices.ragePrice)}` : '—'}</p>
                        </div>
                        <div className="bg-[#3B82F6]/10 rounded p-1.5">
                          <p className="text-[#3B82F6] font-semibold">ERAGE-ETH Pool</p>
                          <p className="text-white">{ggxPoolWethBal ? formatNum(ggxPoolWethBal, 18) : '—'} ETH</p>
                          <p className="text-gray-400">{ggxPoolWethBal && prices.ethPriceUsd > 0 ? `$${formatPrice(parseFloat(formatUnits(ggxPoolWethBal, 18)) * prices.ethPriceUsd)}` : '—'}</p>
                        </div>
                        <div className="bg-[#EF4444]/10 rounded p-1.5">
                          <p className="text-[#EF4444] font-semibold">ERAGE-RAGE Pool</p>
                          <p className="text-white">{erageRagePoolRageBal ? formatNum(erageRagePoolRageBal, 18) : '—'} RA</p>
                          <p className="text-gray-400">{erageRagePoolRageBal && prices.ragePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(erageRagePoolRageBal, 18)) * prices.ragePrice)}` : '—'}</p>
                        </div>
                        <div className="bg-[#8B5CF6]/10 rounded p-1.5">
                          <p className="text-[#8B5CF6] font-semibold">ERAGE-ESHARE Pool</p>
                          <p className="text-white">{erageEsharePoolEshareBal ? formatNum(erageEsharePoolEshareBal, 18) : '—'} ES</p>
                          <p className="text-gray-400">{erageEsharePoolEshareBal && prices.esharePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(erageEsharePoolEshareBal, 18)) * prices.esharePrice * prices.ethPriceUsd)}` : '—'}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              )}

              {/* Admin Console Modal */}
              {isAdmin && showAdmin && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowAdmin(false)}>
                  {/* Backdrop */}
                  <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
                  {/* Modal */}
                  <div className="relative w-full max-w-4xl max-h-[85vh] overflow-y-auto rounded-2xl bg-[#0F0F10] border border-[#F59E0B]/30 shadow-2xl shadow-[#F59E0B]/10" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between px-4 py-3 bg-[#F59E0B]/10 border-b border-[#F59E0B]/20 sticky top-0 z-10 rounded-t-2xl">
                    <div className="flex items-center gap-2">
                      <Shield size={14} className="text-[#F59E0B]" />
                      <span className="text-sm font-semibold text-[#F59E0B]">Admin Console</span>
                      <span className="text-[10px] text-[#F59E0B]/60 ml-2">Owner: {address?.slice(0, 6)}...{address?.slice(-4)}</span>
                    </div>
                    <button onClick={() => setShowAdmin(false)} className="text-gray-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10">✕</button>
                  </div>
                  
                  <div className="p-3">
                    <div className="flex gap-1 mb-3">
                      {(['ggx', 'zap', 'rescue'] as const).map((t) => (
                        <button key={t} onClick={() => setAdminTab(t)} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${adminTab === t ? 'bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/30' : 'text-gray-500 hover:text-white bg-white/5'}`}>
                          {t === 'ggx' ? 'ERAGE Controls' : t === 'zap' ? 'Zap Controls' : 'Emergency'}
                        </button>
                      ))}
                    </div>
                    
                    {adminTab === 'ggx' && (
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-gray-400 uppercase">Protocol Status</p>
                          <div className="flex gap-1">
                            <button onClick={handlePause} disabled={isPaused || isLoading} className="flex-1 py-1.5 text-[10px] bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50 flex items-center justify-center gap-1"><Pause size={10} /> Pause</button>
                            <button onClick={handleUnpause} disabled={!isPaused || isLoading} className="flex-1 py-1.5 text-[10px] bg-[#10B981]/20 text-[#10B981] rounded border border-[#10B981]/30 disabled:opacity-50 flex items-center justify-center gap-1"><Play size={10} /> Unpause</button>
                          </div>
                          <p className="text-[9px] text-gray-500">Status: {isPaused ? '\uD83D\uDD34 Paused' : '\uD83D\uDFE2 Active'}</p>
                          <p className="text-[9px] text-gray-500">Mints: {totalMintCount?.toString() || '0'} | Redeems: {totalRedeemCount?.toString() || '0'}</p>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-gray-400 uppercase">ERAGE Per Pair</p>
                          <input type="number" value={newRatio} onChange={(e) => setNewRatio(e.target.value)} placeholder={ggxPerPair ? formatRatio(ggxPerPair) : '1.0'} className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleSetRatio} disabled={!newRatio || isLoading} className="w-full py-1 text-[10px] bg-[#F59E0B]/20 text-[#F59E0B] rounded border border-[#F59E0B]/30 disabled:opacity-50">Update</button>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-[#F97316] uppercase">Burn ERAGE</p>
                          <input type="number" value={burnErageAmount} onChange={(e) => setBurnErageAmount(e.target.value)} placeholder="Amount to burn" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleBurnERAGE} disabled={!burnErageAmount || parseFloat(burnErageAmount) <= 0 || isLoading} className="w-full py-1 text-[10px] bg-[#F97316]/20 text-[#F97316] rounded border border-[#F97316]/30 disabled:opacity-50 flex items-center justify-center gap-1"><Flame size={10} /> Burn</button>
                          <p className="text-[9px] text-gray-500">Your balance: {ggxBal ? formatNum(ggxBal) : '—'} ERAGE</p>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-[#10B981] uppercase">Fixed Backing Tax (BPS)</p>
                          <input type="number" value={newFixedBackingTax} onChange={(e) => setNewFixedBackingTax(e.target.value)} placeholder={fixedBackingTaxBps?.toString() || '12'} className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleSetFixedBackingTax} disabled={!newFixedBackingTax || isLoading} className="w-full py-1 text-[10px] bg-[#10B981]/20 text-[#10B981] rounded border border-[#10B981]/30 disabled:opacity-50">Set</button>
                          <p className="text-[9px] text-gray-500">Current: {fixedBackingTaxBps?.toString() || '12'} (floor creep)</p>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-[#3B82F6] uppercase">Linear Backing Tax (BPS)</p>
                          <input type="number" value={newLinearBackingTax} onChange={(e) => setNewLinearBackingTax(e.target.value)} placeholder={linearBackingTaxBps?.toString() || '100'} className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleSetLinearBackingTax} disabled={!newLinearBackingTax || isLoading} className="w-full py-1 text-[10px] bg-[#3B82F6]/20 text-[#3B82F6] rounded border border-[#3B82F6]/30 disabled:opacity-50">Set</button>
                          <p className="text-[9px] text-gray-500">Current: {linearBackingTaxBps?.toString() || '100'} (ratio growth)</p>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-[#8B5CF6] uppercase">ESHARE Burn Tax (BPS)</p>
                          <input type="number" value={newEshareBurnTax} onChange={(e) => setNewEshareBurnTax(e.target.value)} placeholder={eshareBurnTaxBps?.toString() || '69'} className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleSetEshareBurnTax} disabled={!newEshareBurnTax || isLoading} className="w-full py-1 text-[10px] bg-[#8B5CF6]/20 text-[#8B5CF6] rounded border border-[#8B5CF6]/30 disabled:opacity-50">Set</button>
                          <p className="text-[9px] text-gray-500">Current: {eshareBurnTaxBps?.toString() || '69'} (deflation)</p>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-[#EF4444] uppercase">RAGE Burn Tax (BPS)</p>
                          <input type="number" value={newRageBurnTax} onChange={(e) => setNewRageBurnTax(e.target.value)} placeholder={rageBurnTaxBps?.toString() || '69'} className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleSetRageBurnTax} disabled={!newRageBurnTax || isLoading} className="w-full py-1 text-[10px] bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50">Set</button>
                          <p className="text-[9px] text-gray-500">Current: {rageBurnTaxBps?.toString() || '69'} (deflation)</p>
                        </div>
                        
                        <div className="col-span-2 bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-gray-400 uppercase">Set All Taxes at Once</p>
                          <div className="grid grid-cols-2 gap-1">
                            <input type="number" value={newFixedBackingTax} onChange={(e) => setNewFixedBackingTax(e.target.value)} placeholder="Fixed BPS" className="bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px]" />
                            <input type="number" value={newLinearBackingTax} onChange={(e) => setNewLinearBackingTax(e.target.value)} placeholder="Linear BPS" className="bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px]" />
                            <input type="number" value={newEshareBurnTax} onChange={(e) => setNewEshareBurnTax(e.target.value)} placeholder="ES Burn BPS" className="bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px]" />
                            <input type="number" value={newRageBurnTax} onChange={(e) => setNewRageBurnTax(e.target.value)} placeholder="RA Burn BPS" className="bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px]" />
                          </div>
                          <button onClick={handleSetAllTaxes} disabled={isLoading} className="w-full py-1 text-[10px] bg-[#F59E0B]/20 text-[#F59E0B] rounded border border-[#F59E0B]/30 disabled:opacity-50">Apply All Taxes</button>
                        </div>
                        
                        <div className="col-span-2 bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">Tax Summary (v5 — Slippage Protected + 48h Timelock)</p>
                          <div className="grid grid-cols-2 gap-1 text-[9px]">
                            <div className="bg-[#10B981]/10 rounded p-1">
                              <span className="text-[#10B981]">Fixed:</span> {fixedBackingTaxBps?.toString() || '12'} BPS ({((Number(fixedBackingTaxBps || 12)) / 100).toFixed(2)}%)
                            </div>
                            <div className="bg-[#3B82F6]/10 rounded p-1">
                              <span className="text-[#3B82F6]">Linear:</span> {linearBackingTaxBps?.toString() || '100'} BPS ({((Number(linearBackingTaxBps || 100)) / 100).toFixed(2)}%)
                            </div>
                            <div className="bg-[#8B5CF6]/10 rounded p-1">
                              <span className="text-[#8B5CF6]">ES Burn:</span> {eshareBurnTaxBps?.toString() || '69'} BPS ({((Number(eshareBurnTaxBps || 69)) / 100).toFixed(2)}%)
                            </div>
                            <div className="bg-[#EF4444]/10 rounded p-1">
                              <span className="text-[#EF4444]">RA Burn:</span> {rageBurnTaxBps?.toString() || '69'} BPS ({((Number(rageBurnTaxBps || 69)) / 100).toFixed(2)}%)
                            </div>
                          </div>
                          <div className="mt-1 pt-1 border-t border-white/10 flex justify-between items-center text-[9px]">
                            <span className="text-gray-400">Total: {totalTaxBps?.toString() || '250'} BPS ({((Number(totalTaxBps || 250)) / 100).toFixed(2)}%)</span>
                            <span className="text-[#FFD700]">Round-trip: {((Number(totalTaxBps || 250)) * 2 / 100).toFixed(1)}%</span>
                          </div>
                          <p className="text-[9px] text-gray-500">Same tax on mint and redeem — ratio ratchets up both ways</p>
                        </div>
                        
                        <div className="col-span-2 lg:col-span-4 bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">TVL Breakdown</p>
                          <div className="grid grid-cols-3 lg:grid-cols-4 gap-2 text-[9px]">
                            <div className="bg-[#8B5CF6]/10 rounded p-1.5">
                              <p className="text-[#8B5CF6] font-semibold">ESHARE Backing</p>
                              <p className="text-white">{backingBalances ? formatNum(backingBalances[0]) : '—'} ES</p>
                              <p className="text-gray-400">{backingBalances && prices.esharePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(backingBalances[0], 18)) * prices.esharePrice * prices.ethPriceUsd)}` : '—'}</p>
                            </div>
                            <div className="bg-[#EF4444]/10 rounded p-1.5">
                              <p className="text-[#EF4444] font-semibold">RAGE Backing</p>
                              <p className="text-white">{backingBalances ? formatNum(backingBalances[1]) : '—'} RA</p>
                              <p className="text-gray-400">{backingBalances && prices.ragePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(backingBalances[1], 18)) * prices.ragePrice)}` : '—'}</p>
                            </div>
                            <div className="bg-[#3B82F6]/10 rounded p-1.5">
                              <p className="text-[#3B82F6] font-semibold">ERAGE-ETH Pool</p>
                              <p className="text-white">{ggxPoolWethBal ? formatNum(ggxPoolWethBal, 18) : '—'} ETH</p>
                              <p className="text-gray-400">{ggxPoolWethBal && prices.ethPriceUsd > 0 ? `$${formatPrice(parseFloat(formatUnits(ggxPoolWethBal, 18)) * prices.ethPriceUsd)}` : '—'}</p>
                            </div>
                            <div className="bg-[#EF4444]/10 rounded p-1.5">
                              <p className="text-[#EF4444] font-semibold">ERAGE-RAGE Pool</p>
                              <p className="text-white">{ggxRagePoolRageBal ? formatNum(ggxRagePoolRageBal, 18) : '—'} RA</p>
                              <p className="text-gray-400">{ggxRagePoolRageBal && prices.ragePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(ggxRagePoolRageBal, 18)) * prices.ragePrice)}` : '—'}</p>
                            </div>
                            <div className="bg-[#8B5CF6]/10 rounded p-1.5">
                              <p className="text-[#8B5CF6] font-semibold">ERAGE-ESHARE Pool</p>
                              <p className="text-white">{ggxEsharePoolEshareBal ? formatNum(ggxEsharePoolEshareBal, 18) : '—'} ES</p>
                              <p className="text-gray-400">{ggxEsharePoolEshareBal && prices.esharePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(ggxEsharePoolEshareBal, 18)) * prices.esharePrice * prices.ethPriceUsd)}` : '—'}</p>
                            </div>
                            <div className="bg-[#EF4444]/10 rounded p-1.5">
                              <p className="text-[#EF4444] font-semibold">ERAGE-RAGE Pool (V3 1%)</p>
                              <p className="text-white">{erageRagePoolRageBal ? formatNum(erageRagePoolRageBal, 18) : '—'} RA</p>
                              <p className="text-gray-400">{erageRagePoolRageBal && prices.ragePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(erageRagePoolRageBal, 18)) * prices.ragePrice)}` : '—'}</p>
                            </div>
                            <div className="bg-[#8B5CF6]/10 rounded p-1.5">
                              <p className="text-[#8B5CF6] font-semibold">ERAGE-ESHARE Pool (V3 1%)</p>
                              <p className="text-white">{erageEsharePoolEshareBal ? formatNum(erageEsharePoolEshareBal, 18) : '—'} ES</p>
                              <p className="text-gray-400">{erageEsharePoolEshareBal && prices.esharePrice > 0 ? `$${formatPrice(parseFloat(formatUnits(erageEsharePoolEshareBal, 18)) * prices.esharePrice * prices.ethPriceUsd)}` : '—'}</p>
                            </div>
                          </div>
                          <div className="mt-1 pt-1 border-t border-white/10 flex justify-between items-center">
                            <span className="text-[10px] text-gray-400">Total TVL:</span>
                            <span className="text-sm font-bold text-[#FFD700]">
                              ${backingBalances && prices.ethPriceUsd > 0 
                                ? formatPrice((
                                    parseFloat(formatUnits(backingBalances[0], 18)) * prices.esharePrice * prices.ethPriceUsd +
                                    parseFloat(formatUnits(backingBalances[1], 18)) * prices.ragePrice +
                                    (ggxPoolWethBal ? parseFloat(formatUnits(ggxPoolWethBal, 18)) : 0) * prices.ethPriceUsd +
                                    (ggxRagePoolRageBal ? parseFloat(formatUnits(ggxRagePoolRageBal, 18)) : 0) * prices.ragePrice +
                                    (ggxEsharePoolEshareBal ? parseFloat(formatUnits(ggxEsharePoolEshareBal, 18)) : 0) * prices.esharePrice * prices.ethPriceUsd +
                                    (erageRagePoolRageBal ? parseFloat(formatUnits(erageRagePoolRageBal, 18)) : 0) * prices.ragePrice +
                                    (erageEsharePoolEshareBal ? parseFloat(formatUnits(erageEsharePoolEshareBal, 18)) : 0) * prices.esharePrice * prices.ethPriceUsd
                                  ))
                                : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {adminTab === 'zap' && (
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                        <div className="bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">V3 Router</p>
                          <p className="text-[10px] font-mono text-white break-all">{zapRouter ? `${zapRouter.slice(0, 6)}...${zapRouter.slice(-4)}` : '—'}</p>
                          <p className="text-[9px] text-gray-500 mt-1">Expected: {CONTRACTS.V3_ROUTER.slice(0, 6)}...{CONTRACTS.V3_ROUTER.slice(-4)}</p>
                          {zapRouter && zapRouter.toLowerCase() !== CONTRACTS.V3_ROUTER.toLowerCase() && (
                            <p className="text-[9px] text-[#EF4444]">⚠️ Mismatch!</p>
                          )}
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">WETH Address</p>
                          <p className="text-[10px] font-mono text-white break-all">{zapWeth ? `${zapWeth.slice(0, 6)}...${zapWeth.slice(-4)}` : '—'}</p>
                          <p className="text-[9px] text-gray-500 mt-1">Expected: {CONTRACTS.WETH.slice(0, 6)}...{CONTRACTS.WETH.slice(-4)}</p>
                          {zapWeth && zapWeth.toLowerCase() !== CONTRACTS.WETH.toLowerCase() && (
                            <p className="text-[9px] text-[#EF4444]">⚠️ Mismatch!</p>
                          )}
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">USDC Address</p>
                          <p className="text-[10px] font-mono text-white break-all">{zapUsdc ? `${zapUsdc.slice(0, 6)}...${zapUsdc.slice(-4)}` : '—'}</p>
                          <p className="text-[9px] text-gray-500 mt-1">Expected: {CONTRACTS.USDC.slice(0, 6)}...{CONTRACTS.USDC.slice(-4)}</p>
                          {zapUsdc && zapUsdc.toLowerCase() !== CONTRACTS.USDC.toLowerCase() && (
                            <p className="text-[9px] text-[#EF4444]">⚠️ Mismatch!</p>
                          )}
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">ERAGE Address</p>
                          <p className="text-[10px] font-mono text-white break-all">{zapErage ? `${zapErage.slice(0, 6)}...${zapErage.slice(-4)}` : '—'}</p>
                          <p className="text-[9px] text-gray-500 mt-1">Expected: {CONTRACTS.GGX.slice(0, 6)}...{CONTRACTS.GGX.slice(-4)}</p>
                          {zapErage && zapErage.toLowerCase() !== CONTRACTS.GGX.toLowerCase() && (
                            <p className="text-[9px] text-[#EF4444]">⚠️ Mismatch!</p>
                          )}
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 space-y-1 col-span-2">
                          <p className="text-[10px] text-gray-400 uppercase">Admin Wallet (Tax Recipient)</p>
                          <p className="text-[10px] font-mono text-white break-all">{zapAdminWallet ? `${zapAdminWallet.slice(0, 10)}...${zapAdminWallet.slice(-6)}` : '—'}</p>
                          <p className="text-[9px] text-gray-500">Receives 0.69% of ETH on every zapFromETH</p>
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">QuoterV2 Address</p>
                          <p className="text-[10px] font-mono text-white break-all">{zapQuoter ? `${zapQuoter.slice(0, 6)}...${zapQuoter.slice(-4)}` : '—'}</p>
                          <p className="text-[9px] text-gray-500 mt-1">Expected: {CONTRACTS.QUOTER_V2.slice(0, 6)}...{CONTRACTS.QUOTER_V2.slice(-4)}</p>
                          {zapQuoter && zapQuoter.toLowerCase() !== CONTRACTS.QUOTER_V2.toLowerCase() && (
                            <p className="text-[9px] text-[#EF4444]">⚠️ Mismatch!</p>
                          )}
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">Split Config</p>
                          <p className="text-[10px] font-mono text-white">quoteRefBps: {zapQuoteRefBps ? String(zapQuoteRefBps) : '—'}</p>
                          <p className="text-[10px] font-mono text-white">rebalanceThreshold: {zapRebalanceThresholdBps ? `${String(zapRebalanceThresholdBps)} bps` : '—'}</p>
                          <p className="text-[9px] text-gray-500 mt-1">Ref BPS for quoter & rebalance trigger threshold</p>
                        </div>
                        <div className="col-span-2 bg-[#10B981]/10 border border-[#10B981]/20 rounded-lg p-3">
                          <p className="text-xs text-[#10B981] font-medium">✅ V5 Optimized Zap Active — QuoterV2 Intelligent Split + 0.69% ETH Tax</p>
                          <p className="text-[10px] text-gray-400 mt-1">Price-aware splitting via Uniswap V3 QuoterV2 + optional rebalance pass:</p>
                          <ul className="text-[10px] text-gray-400 mt-1 list-disc list-inside space-y-0.5">
                            <li>ETH → ESHARE: Direct via WETH/ESHARE pool ({POOL_FEES.WETH_ESHARE/10000}% fee)</li>
                            <li>ETH → RAGE: WETH → USDC → RAGE ({POOL_FEES.WETH_USDC/10000}% + {POOL_FEES.USDC_RAGE/10000}% fees)</li>
                            <li className="text-[#3B82F6]">QuoterV2: Queries live pool prices to calculate optimal ETH split (no oracle needed)</li>
                            <li className="text-[#3B82F6]">Rebalance: ESHARE → WETH → USDC → RAGE (3-hop, auto-skips if RAGE is excess)</li>
                            <li className="text-[#F59E0B]">ETH zaps: 0.69% tax sent to adminWallet before swapping</li>
                          </ul>
                        </div>
                      </div>
                    )}
                    
                    {adminTab === 'rescue' && (
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                        {/* ERAGE Contract — v5 timelocked emergency drain + rescueToken */}
                        <div className="bg-[#EF4444]/5 border border-[#EF4444]/20 rounded-lg p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <AlertTriangle size={14} className="text-[#EF4444]" />
                            <p className="text-xs font-semibold text-[#EF4444]">ERAGE Contract Emergency</p>
                          </div>

                          {/* Rescue non-backing token */}
                          <div className="space-y-1.5">
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Rescue stuck token (not ES/RA/ERAGE)</p>
                            <input type="text" value={rescueToken} onChange={(e) => setRescueToken(e.target.value)} placeholder="Token Address" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                            <input type="number" value={rescueAmount} onChange={(e) => setRescueAmount(e.target.value)} placeholder="Amount (wei)" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                            <button onClick={() => handleRescueToken('ggx')} disabled={!rescueToken || !rescueAmount || isLoading} className="w-full py-2 text-xs bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50 flex items-center justify-center gap-1"><Trash2 size={12} /> Rescue Token</button>
                          </div>

                          {/* v5: 48h timelocked emergency drain */}
                          <div className="pt-2 border-t border-[#EF4444]/20 space-y-1.5">
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">48h Timelocked Drain</p>

                            {/* Countdown display */}
                            {emergencyDrainExecutableAt && (emergencyDrainExecutableAt as bigint) > 0n ? (
                              (() => {
                                const executableAt = Number(emergencyDrainExecutableAt as bigint)
                                const now = Math.floor(Date.now() / 1000)
                                const secondsRemaining = executableAt - now
                                const isExecutable = secondsRemaining <= 0
                                const hours = Math.floor(Math.abs(secondsRemaining) / 3600)
                                const mins = Math.floor((Math.abs(secondsRemaining) % 3600) / 60)
                                return (
                                  <div className={`rounded p-2 text-center ${isExecutable ? 'bg-[#10B981]/10 border border-[#10B981]/30' : 'bg-[#FFD700]/10 border border-[#FFD700]/30'}`}>
                                    <p className="text-[10px] uppercase tracking-wider text-gray-400">
                                      {isExecutable ? 'READY TO EXECUTE' : 'DRAIN PENDING'}
                                    </p>
                                    <p className={`text-sm font-mono ${isExecutable ? 'text-[#10B981]' : 'text-[#FFD700]'}`}>
                                      {isExecutable ? `Unlocked ${hours}h ${mins}m ago` : `${hours}h ${mins}m remaining`}
                                    </p>
                                  </div>
                                )
                              })()
                            ) : (
                              <div className="rounded p-2 text-center bg-white/5 border border-white/10">
                                <p className="text-[10px] uppercase tracking-wider text-gray-400">No drain pending</p>
                              </div>
                            )}

                            {/* 3-step buttons */}
                            <div className="flex gap-1">
                              <button
                                onClick={handleInitiateEmergencyDrain}
                                disabled={isLoading || (!!emergencyDrainExecutableAt && (emergencyDrainExecutableAt as bigint) > 0n)}
                                className="flex-1 py-2 text-xs bg-[#FFD700]/20 text-[#FFD700] rounded border border-[#FFD700]/30 disabled:opacity-30 flex items-center justify-center gap-1"
                                title="Start the 48h countdown. Users can still mint/redeem during the window."
                              >
                                <Shield size={11} /> Initiate
                              </button>
                              <button
                                onClick={handleCancelEmergencyDrain}
                                disabled={isLoading || !emergencyDrainExecutableAt || (emergencyDrainExecutableAt as bigint) === 0n}
                                className="flex-1 py-2 text-xs bg-[#3B82F6]/20 text-[#3B82F6] rounded border border-[#3B82F6]/30 disabled:opacity-30 flex items-center justify-center gap-1"
                                title="Cancel a pending drain."
                              >
                                <RefreshCw size={11} /> Cancel
                              </button>
                              <button
                                onClick={handleExecuteEmergencyDrain}
                                disabled={
                                  isLoading ||
                                  !emergencyDrainExecutableAt ||
                                  (emergencyDrainExecutableAt as bigint) === 0n ||
                                  Number(emergencyDrainExecutableAt as bigint) > Math.floor(Date.now() / 1000)
                                }
                                className="flex-1 py-2 text-xs bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-30 flex items-center justify-center gap-1"
                                title="Execute after 48h. Pauses contract + drains ES/RA/ERAGE to owner."
                              >
                                <AlertTriangle size={11} /> Execute
                              </button>
                            </div>
                            <p className="text-[9px] text-gray-500">
                              Initiate → wait 48h → Execute. Users can redeem during the wait window.
                            </p>
                          </div>
                        </div>

                        {/* Zap Contract (V5 Optimized) — emergencyWithdraw (ES+RA+ERAGE) + rescueETH + rescueToken */}
                        <div className="bg-[#EF4444]/5 border border-[#EF4444]/20 rounded-lg p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <AlertTriangle size={14} className="text-[#EF4444]" />
                            <p className="text-xs font-semibold text-[#EF4444]">ERAGE Zap Emergency (V5 Optimized)</p>
                          </div>
                          <div className="space-y-1.5">
                            <p className="text-[10px] text-gray-400 uppercase tracking-wider">Rescue stuck token (not ES/RA/ERAGE)</p>
                            <input type="text" value={rescueToken} onChange={(e) => setRescueToken(e.target.value)} placeholder="Token Address" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                            <input type="number" value={rescueAmount} onChange={(e) => setRescueAmount(e.target.value)} placeholder="Amount (wei)" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                            <button onClick={() => handleRescueToken('zap')} disabled={!rescueToken || !rescueAmount || isLoading} className="w-full py-2 text-xs bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50 flex items-center justify-center gap-1"><Trash2 size={12} /> Rescue Token</button>
                          </div>
                          <div className="pt-2 border-t border-[#EF4444]/20 flex gap-1">
                            <button onClick={handleZapEmergencyWithdraw} disabled={isLoading} className="flex-1 py-2 text-xs bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50 flex items-center justify-center gap-1" title="Sweep all ES+RA+ERAGE held by the Zap to owner (no timelock — Zap should never hold meaningful balances).">
                              <AlertTriangle size={11} /> Withdraw ES/RA/ERAGE
                            </button>
                            <button onClick={handleZapRescueETH} disabled={isLoading} className="flex-1 py-2 text-xs bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50 flex items-center justify-center gap-1">
                              <DollarSign size={12} /> Rescue ETH
                            </button>
                          </div>
                          <p className="text-[9px] text-gray-500">Zap is stateless — no timelock needed; balances should be ephemeral.</p>
                        </div>
                      </div>
                    )}
                  </div>
                  </div>
                </div>
              )}
            </div>
        </main>
      </div>
    </div>
  )
}
