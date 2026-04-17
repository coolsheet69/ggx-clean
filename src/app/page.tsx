'use client'

import { useAccount, useConnect, useDisconnect, useReadContract, useWriteContract, useWaitForTransactionReceipt, useSwitchChain, useBalance } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { parseUnits, formatUnits } from 'viem'
import { base } from 'wagmi/chains'
import { useState, useEffect, useMemo, useRef } from 'react'
import { 
  TrendingUp, Wallet, Zap, ArrowUpRight, Flame, 
  RefreshCw, Settings, Shield, AlertTriangle, Pause, Play,
  Trash2, DollarSign, MessageCircle, FileText
} from 'lucide-react'

// ============ CONTRACT ADDRESSES ============
const CONTRACTS = {
  GGX: '0x876F7D40e24577948d25D4AC9336deb20c177ecb' as `0x${string}`,  // NEW CONTRACT
  GGXZap: '0xC4A291f48b6bc3072a9ab483dcEBA7FD18bb21a0' as `0x${string}`,  // V3 Zap (redeployed)
  ESHARE: '0xb7C10146bA1b618956a38605AB6496523d450871' as `0x${string}`,
  RAGE: '0xc0df50143EA93AeC63e38A6ED4E92B378079eA15' as `0x${string}`,
  WETH: '0x4200000000000000000000000000000000000006' as `0x${string}`,
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
  V3_ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481' as `0x${string}`, // Uniswap V3 SwapRouter on Base
  ADMIN: '0x2BDFDd894D0CD04017b7dAb3D4C25E788FDEfd47',
  // LP Pairs for price feeds (Uniswap V3)
  RAGE_LP: '0xd474B32a5a2BF93453996287D361a00f661E04FF' as `0x${string}`,
  ESHARE_LP: '0x0656CDF4539f412F542A8D8a029f7c6c5cE90d7B' as `0x${string}`,
  GGX_LP: '0x09591f786a2e724ed46ccc85293ee0e8dd73f9ba' as `0x${string}`,  // New GGX-ETH V3 pair
  WETH_USDC_LP: '0x6c561b446416e1a00e8e93e221854d6ea4171372' as `0x${string}`, // WETH/USDC Uniswap V3 on Base (correct pool)
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
  WETH_ESHARE: 10000,  // 1% - ESHARE/ETH pool
  USDC_RAGE: 10000,    // 1% - RAGE/USDC pool
  ESHARE_RAGE: 10000,  // 1% (via USDC)
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
  
  // ESHARE → RAGE (multi-hop via USDC)
  ESHARE_TO_RAGE: encodeV3Path(
    [CONTRACTS.ESHARE, CONTRACTS.USDC, CONTRACTS.RAGE],
    [POOL_FEES.ESHARE_RAGE, POOL_FEES.USDC_RAGE]
  ),
  
  // RAGE → ESHARE (multi-hop via USDC)
  RAGE_TO_ESHARE: encodeV3Path(
    [CONTRACTS.RAGE, CONTRACTS.USDC, CONTRACTS.ESHARE],
    [POOL_FEES.USDC_RAGE, POOL_FEES.ESHARE_RAGE]
  ),
}

// ============ ABIs ============
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
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
  { name: 'getMintOutput', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenAmount', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'getRedeemOutput', type: 'function', stateMutability: 'view', inputs: [{ name: 'ggxAmount', type: 'uint256' }], outputs: [{ name: 'eshareOut', type: 'uint256' }, { name: 'rageOut', type: 'uint256' }] },
  { name: 'ggxPerPair', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'eshareToken', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'rageToken', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'paused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  
  // Tax configuration - ASYMMETRIC
  { name: 'mintBackingTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },      // 5% default
  { name: 'redeemBackingTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },   // 1% default
  { name: 'totalMintTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },        // 7% total
  { name: 'totalRedeemTaxBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },     // 3% total
  { name: 'MINT_ESHARE_BURN_BPS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, // 1% hardcoded
  { name: 'MINT_RAGE_BURN_BPS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },   // 1% hardcoded
  { name: 'REDEEM_ESHARE_BURN_BPS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, // 1% hardcoded
  { name: 'REDEEM_RAGE_BURN_BPS', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },   // 1% hardcoded
  
  // Analytics
  { name: 'totalEshareBackingAdded', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalRageBackingAdded', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  
  // User functions
  { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenAmount', type: 'uint256' }], outputs: [{ name: 'ggxOut', type: 'uint256' }] },
  { name: 'redeem', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'ggxAmount', type: 'uint256' }], outputs: [{ name: 'eshareOut', type: 'uint256' }, { name: 'rageOut', type: 'uint256' }] },
  { name: 'burn', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  
  // Admin functions
  { name: 'setGGXPerPair', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_ratio', type: 'uint256' }], outputs: [] },
  { name: 'pause', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'unpause', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'setMintBackingTaxBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_bps', type: 'uint256' }], outputs: [] },
  { name: 'setRedeemBackingTaxBps', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_bps', type: 'uint256' }], outputs: [] },
  { name: 'setBothBackingTaxes', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_mintBps', type: 'uint256' }, { name: '_redeemBps', type: 'uint256' }], outputs: [] },
  { name: 'rescueToken', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'emergencyWithdrawBacking', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

const ZAP_ABI = [
  // V3 Zap functions with path parameters
  { name: 'zapFromETH', type: 'function', stateMutability: 'payable', inputs: [{ name: 'esharePath', type: 'bytes' }, { name: 'ragePath', type: 'bytes' }, { name: 'minGgxOut', type: 'uint256' }], outputs: [{ name: 'ggxOut', type: 'uint256' }] },
  { name: 'zapFromEshare', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'eshareAmount', type: 'uint256' }, { name: 'ragePath', type: 'bytes' }, { name: 'minGgxOut', type: 'uint256' }], outputs: [{ name: 'ggxOut', type: 'uint256' }] },
  { name: 'zapFromRage', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'rageAmount', type: 'uint256' }, { name: 'esharePath', type: 'bytes' }, { name: 'minGgxOut', type: 'uint256' }], outputs: [{ name: 'ggxOut', type: 'uint256' }] },
  { name: 'zapFromToken', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'esharePath', type: 'bytes' }, { name: 'ragePath', type: 'bytes' }, { name: 'minGgxOut', type: 'uint256' }], outputs: [{ name: 'ggxOut', type: 'uint256' }] },
  { name: 'zapFromBothTokens', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'eshareAmount', type: 'uint256' }, { name: 'rageAmount', type: 'uint256' }, { name: 'minGgxOut', type: 'uint256' }], outputs: [{ name: 'ggxOut', type: 'uint256' }] },
  { name: 'getCommonPaths', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'ethToEsharePath', type: 'bytes' }, { name: 'ethToRagePath', type: 'bytes' }] },
  // View functions
  { name: 'ggx', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'uniswapV3Router', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'weth', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'usdc', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  // Admin functions
  { name: 'setRouter', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_router', type: 'address' }], outputs: [] },
  { name: 'setUsdc', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: '_usdc', type: 'address' }], outputs: [] },
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

// ============ RATIO CHART COMPONENT ============
type TimeRange = '4h' | '1d' | '1w'

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
  
  // Filter history based on time range
  const filteredHistory = useMemo(() => {
    const now = Date.now()
    const cutoff = timeRange === '4h' ? now - 4 * 60 * 60 * 1000 
                 : timeRange === '1d' ? now - 24 * 60 * 60 * 1000 
                 : now - 7 * 24 * 60 * 60 * 1000
    return history.filter(h => h.time >= cutoff)
  }, [history, timeRange])
  
  const filteredPriceEfficiency = useMemo(() => {
    if (!priceEfficiencyHistory) return []
    const now = Date.now()
    const cutoff = timeRange === '4h' ? now - 4 * 60 * 60 * 1000 
                 : timeRange === '1d' ? now - 24 * 60 * 60 * 1000 
                 : now - 7 * 24 * 60 * 60 * 1000
    return priceEfficiencyHistory.filter(h => h.time >= cutoff)
  }, [priceEfficiencyHistory, timeRange])
  
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || filteredHistory.length < 2) return
    
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    
    const drawChart = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      
      // Guard against zero dimensions
      if (rect.width === 0 || rect.height === 0) return
      
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      
      const width = rect.width
      const height = rect.height
      const padding = { top: 15, right: 50, bottom: 25, left: 45 }
      
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
        
        ctx.fillText(ratioVal.toFixed(3), padding.left - 4, y + 3)
      }

      // Define action zones based on thresholds:
      // Direct mint (ESHARE+RAGE or ETH zap): ~1% difference, so threshold at 1.01
      const DIRECT_MINT_ZONE = 1.01   // Above this: Mint (direct or zap) is better
      const BUY_UNI_ZONE = 0.97       // Below this: Buy on Uniswap is better
      const REDEEM_ZONE = 0.97        // Below this: Redeem is better (symmetric)
      const SELL_UNI_ZONE = 1.03      // Above this: Sell on Uniswap is better (accounts for slippage)

      // Split chart vertically: Left half for ACQUIRE (buy/mint), Right half for EXIT (sell/redeem)
      const midX = padding.left + chartWidth / 2

      // Draw action zones on chart (shaded regions) - LEFT HALF (ACQUIRE)
      if (filteredPriceEfficiency.length > 0) {
        // --- LEFT HALF: ACQUIRE DECISIONS ---
        // Green zone (BUY UNI) - below BUY_UNI_ZONE
        if (minRatio < BUY_UNI_ZONE) {
          const zoneTopY = padding.top + chartHeight - ((BUY_UNI_ZONE - minRatio) / ratioRange) * chartHeight
          const bottomY = padding.top + chartHeight
          const gradient = ctx.createLinearGradient(0, zoneTopY, 0, bottomY)
          gradient.addColorStop(0, 'rgba(16, 185, 129, 0.3)')
          gradient.addColorStop(1, 'rgba(16, 185, 129, 0.05)')
          ctx.fillStyle = gradient
          ctx.fillRect(padding.left, zoneTopY, chartWidth / 2, bottomY - zoneTopY)
        }

        // Cyan zone (MINT) - above DIRECT_MINT_ZONE
        if (maxRatio > DIRECT_MINT_ZONE) {
          const zoneTopY = padding.top + chartHeight - ((DIRECT_MINT_ZONE - minRatio) / ratioRange) * chartHeight
          const topY = padding.top
          const gradient = ctx.createLinearGradient(0, topY, 0, zoneTopY)
          gradient.addColorStop(0, 'rgba(6, 182, 212, 0.25)')
          gradient.addColorStop(1, 'rgba(6, 182, 212, 0.05)')
          ctx.fillStyle = gradient
          ctx.fillRect(padding.left, topY, chartWidth / 2, zoneTopY - topY)
        }

        // --- RIGHT HALF: EXIT DECISIONS ---
        // Purple zone (REDEEM) - below REDEEM_ZONE
        if (minRatio < REDEEM_ZONE) {
          const zoneTopY = padding.top + chartHeight - ((REDEEM_ZONE - minRatio) / ratioRange) * chartHeight
          const bottomY = padding.top + chartHeight
          const gradient = ctx.createLinearGradient(0, zoneTopY, 0, bottomY)
          gradient.addColorStop(0, 'rgba(168, 85, 247, 0.3)')
          gradient.addColorStop(1, 'rgba(168, 85, 247, 0.05)')
          ctx.fillStyle = gradient
          ctx.fillRect(midX, zoneTopY, chartWidth / 2, bottomY - zoneTopY)
        }

        // Orange zone (SELL UNI) - above SELL_UNI_ZONE
        if (maxRatio > SELL_UNI_ZONE) {
          const zoneBottomY = padding.top + chartHeight - ((SELL_UNI_ZONE - minRatio) / ratioRange) * chartHeight
          const topY = padding.top
          const gradient = ctx.createLinearGradient(0, topY, 0, zoneBottomY)
          gradient.addColorStop(0, 'rgba(249, 115, 22, 0.05)')
          gradient.addColorStop(1, 'rgba(249, 115, 22, 0.25)')
          ctx.fillStyle = gradient
          ctx.fillRect(midX, topY, chartWidth / 2, zoneBottomY - topY)
        }
      }

      // Draw vertical divider line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(midX, padding.top)
      ctx.lineTo(midX, height - padding.bottom)
      ctx.stroke()
      ctx.setLineDash([])

      // Draw section labels at bottom in the colored zones (under 0.97 area)
      const bottomY = padding.top + chartHeight - 2
      ctx.fillStyle = 'rgba(16, 185, 129, 0.7)'
      ctx.textAlign = 'center'
      ctx.font = 'bold 8px sans-serif'
      ctx.fillText('ACQUIRE', padding.left + chartWidth * 0.25, bottomY)
      ctx.fillStyle = 'rgba(168, 85, 247, 0.7)'
      ctx.fillText('EXIT', padding.left + chartWidth * 0.75, bottomY)
      
      // Draw parity line at 1.0 (dashed)
      if (filteredPriceEfficiency.length > 0 && minRatio < 1 && maxRatio > 1) {
        const parityY = padding.top + chartHeight - ((1 - minRatio) / ratioRange) * chartHeight
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(padding.left, parityY)
        ctx.lineTo(width - padding.right, parityY)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Draw threshold lines for action zones
      if (filteredPriceEfficiency.length > 0) {
        // Mint threshold (1.01) - cyan
        if (minRatio < DIRECT_MINT_ZONE && maxRatio > DIRECT_MINT_ZONE) {
          const directMintY = padding.top + chartHeight - ((DIRECT_MINT_ZONE - minRatio) / ratioRange) * chartHeight
          ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)'
          ctx.setLineDash([5, 3])
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(padding.left, directMintY)
          ctx.lineTo(width - padding.right, directMintY)
          ctx.stroke()
          ctx.setLineDash([])

          ctx.fillStyle = '#06B6D4'
          ctx.textAlign = 'left'
          ctx.font = '8px sans-serif'
          ctx.fillText('1.01', width - padding.right + 4, directMintY + 3)
        }

        // Sell Uni threshold (1.03) - HIGHLIGHTED PIVOT POINT - orange/yellow
        if (minRatio < SELL_UNI_ZONE && maxRatio > SELL_UNI_ZONE) {
          const sellUniY = padding.top + chartHeight - ((SELL_UNI_ZONE - minRatio) / ratioRange) * chartHeight
          // Draw thicker, more visible line
          ctx.strokeStyle = '#F97316'
          ctx.setLineDash([8, 4])
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(padding.left, sellUniY)
          ctx.lineTo(width - padding.right, sellUniY)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.lineWidth = 1

          // Label on right side
          ctx.fillStyle = '#F97316'
          ctx.textAlign = 'left'
          ctx.font = 'bold 10px sans-serif'
          ctx.fillText('1.03', width - padding.right + 4, sellUniY + 4)

          // Label in RIGHT half (EXIT area) - just after center line
          ctx.textAlign = 'left'
          ctx.font = 'bold 9px sans-serif'
          const sellLabel = '↗ SELL UNI'
          const sellTextWidth = ctx.measureText(sellLabel).width
          ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
          ctx.fillRect(midX + 5, sellUniY - 8, sellTextWidth + 6, 14)
          ctx.fillStyle = '#F97316'
          ctx.fillText(sellLabel, midX + 8, sellUniY + 2)
        }

        // Buy Uni/Redeem threshold (0.97) - HIGHLIGHTED PIVOT POINT - green
        if (minRatio < BUY_UNI_ZONE && maxRatio > BUY_UNI_ZONE) {
          const buyUniY = padding.top + chartHeight - ((BUY_UNI_ZONE - minRatio) / ratioRange) * chartHeight
          // Draw thicker, more visible line
          ctx.strokeStyle = '#10B981'
          ctx.setLineDash([8, 4])
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(padding.left, buyUniY)
          ctx.lineTo(width - padding.right, buyUniY)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.lineWidth = 1

          // Label on right side
          ctx.fillStyle = '#10B981'
          ctx.textAlign = 'left'
          ctx.font = 'bold 10px sans-serif'
          ctx.fillText('0.97', width - padding.right + 4, buyUniY + 4)

          // Label in LEFT half (ACQUIRE area) - moved left away from center
          ctx.textAlign = 'left'
          ctx.font = 'bold 9px sans-serif'
          const buyLabel = '↘ BUY UNI'
          const buyTextWidth = ctx.measureText(buyLabel).width
          ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
          ctx.fillRect(midX - buyTextWidth - 15, buyUniY - 8, buyTextWidth + 6, 14)
          ctx.fillStyle = '#10B981'
          ctx.fillText(buyLabel, midX - buyTextWidth - 12, buyUniY + 2)
        }
      }

      // Draw X-axis time labels
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
      
      // Helper function to draw a line
      const drawLine = (data: { time: number; ratio: number }[], color: string, fillColor: string) => {
        if (data.length < 2) return
        
        // Draw gradient fill
        const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom)
        gradient.addColorStop(0, fillColor)
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
        
        ctx.beginPath()
        ctx.moveTo(padding.left, height - padding.bottom)
        
        data.forEach((point, i) => {
          const x = padding.left + chartWidth * (i / (data.length - 1))
          const y = padding.top + chartHeight - ((point.ratio - minRatio) / ratioRange) * chartHeight
          ctx.lineTo(x, y)
        })
        
        ctx.lineTo(padding.left + chartWidth, height - padding.bottom)
        ctx.closePath()
        ctx.fillStyle = gradient
        ctx.fill()
        
        // Draw line
        ctx.beginPath()
        ctx.strokeStyle = color
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
        
        // Draw end point with larger size for pulsing effect
        const lastPoint = data[data.length - 1]
        const lastX = padding.left + chartWidth
        const lastY = padding.top + chartHeight - ((lastPoint.ratio - minRatio) / ratioRange) * chartHeight
        
        // Store position for overlay
        if (color === '#10B981') {
          setDotPosition({ x: lastX, y: lastY })
        }
        
        // Draw larger circle base
        ctx.beginPath()
        ctx.arc(lastX, lastY, 5, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()
        
        // Draw inner bright dot
        ctx.beginPath()
        ctx.arc(lastX, lastY, 3, 0, 2 * Math.PI)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
      }
      
      // Draw price efficiency line - shows Uniswap vs Mint advantage
      if (filteredPriceEfficiency.length >= 2) {
        drawLine(filteredPriceEfficiency, '#10B981', 'rgba(16, 185, 129, 0.2)')
      }
    }
    
    drawChart()
    
    // Handle resize
    const handleResize = () => drawChart()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
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
      {/* Pulsing dot overlay with value */}
      {dotPosition && currentRatio !== null && currentRatio !== undefined && (
        <div 
          className="absolute pointer-events-none flex items-center"
          style={{ 
            left: dotPosition.x, 
            top: dotPosition.y,
            transform: 'translateY(-50%)'
          }}
        >
          <div className="relative -ml-1.5">
            <div className="w-3 h-3 rounded-full bg-[#10B981] animate-ping absolute" />
            <div className="w-3 h-3 rounded-full bg-[#10B981] relative" />
          </div>
          <span className="text-[11px] font-bold text-[#10B981] ml-2 bg-black/60 px-1.5 py-0.5 rounded">
            {currentRatio.toFixed(3)}
          </span>
        </div>
      )}
    </div>
  )
}

// ============ MAIN COMPONENT ============
export default function Dashboard() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  
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
  const [showAdmin, setShowAdmin] = useState(false)
  const [adminTab, setAdminTab] = useState<'ggx' | 'zap' | 'rescue'>('ggx')
  
  // Admin inputs
  const [newRatio, setNewRatio] = useState('')
  const [newMintBackingTax, setNewMintBackingTax] = useState('')
  const [newRedeemBackingTax, setNewRedeemBackingTax] = useState('')
  const [rescueToken, setRescueToken] = useState('')
  const [rescueAmount, setRescueAmount] = useState('')
  
  // Ratio history
  const [ratioHistory, setRatioHistory] = useState<{ time: number; ratio: number }[]>([])
  const [priceEfficiencyHistory, setPriceEfficiencyHistory] = useState<{ time: number; ratio: number }[]>([])
  const [timeRange, setTimeRange] = useState<TimeRange>('4h')
  
  // Burnt amounts from events (indexer) - using mathematical calculation from backing added
  // Since burn tax (1%) = backing tax (2%) / 2, we can derive burns from totalBackingAdded
  const [burntAmounts, setBurntAmounts] = useState<{ eshare: bigint; rage: bigint }>({ eshare: 0n, rage: 0n })
  
  // ============ CONTRACT READS ============
  const { data: ggxBal } = useReadContract({ address: CONTRACTS.GGX, abi: ERC20_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, query: { enabled: !!address } })
  const { data: eshareBal } = useReadContract({ address: CONTRACTS.ESHARE, abi: ERC20_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, query: { enabled: !!address } })
  const { data: rageBal } = useReadContract({ address: CONTRACTS.RAGE, abi: ERC20_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, query: { enabled: !!address } })
  const { data: ethBal } = useBalance({ address })
  
  const { data: ggxSupply } = useReadContract({ address: CONTRACTS.GGX, abi: ERC20_ABI, functionName: 'totalSupply' })
  
  // GGX contract data
  const { data: backingRatio } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'getBackingRatio' })
  const { data: backingBalances } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'getBackingBalances' })
  const { data: ggxPerPair } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'ggxPerPair' })
  // Mint output for ESHARE+RAGE (uses eshareInput)
  const { data: mintOutputEshare } = useReadContract({ 
    address: CONTRACTS.GGX, 
    abi: GGX_ABI, 
    functionName: 'getMintOutput', 
    args: eshareInput && parseFloat(eshareInput) > 0 ? [parseUnits(eshareInput, 18)] : undefined, 
    query: { enabled: !!eshareInput && parseFloat(eshareInput) > 0 && inputToken === 'ESHARE_RAGE' } 
  })
  
  // Mint output for direct token mint (uses inputAmount for ETH zaps - estimated)
  // Note: For ETH zaps, we can't get exact output since swaps happen first
  // We show an estimate based on backing ratio
  const { data: redeemOutput } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'getRedeemOutput', args: inputAmount && inputToken === 'GGX' ? [parseUnits(inputAmount, 18)] : undefined, query: { enabled: !!inputAmount && inputToken === 'GGX' } })
  
  // LP Price Feeds - RAGE (V3 Pool)
  const { data: rageSlot0 } = useReadContract({ address: CONTRACTS.RAGE_LP, abi: PAIR_ABI, functionName: 'slot0', query: { refetchInterval: 30000 } })
  const { data: rageLiquidity } = useReadContract({ address: CONTRACTS.RAGE_LP, abi: PAIR_ABI, functionName: 'liquidity' })
  const { data: rageT0 } = useReadContract({ address: CONTRACTS.RAGE_LP, abi: PAIR_ABI, functionName: 'token0' })
  const { data: rageT1 } = useReadContract({ address: CONTRACTS.RAGE_LP, abi: PAIR_ABI, functionName: 'token1' })
  
  // LP Price Feeds - ESHARE (V3 Pool)
  const { data: eshareSlot0 } = useReadContract({ address: CONTRACTS.ESHARE_LP, abi: PAIR_ABI, functionName: 'slot0', query: { refetchInterval: 30000 } })
  const { data: eshareLiquidity } = useReadContract({ address: CONTRACTS.ESHARE_LP, abi: PAIR_ABI, functionName: 'liquidity' })
  const { data: eshareT0 } = useReadContract({ address: CONTRACTS.ESHARE_LP, abi: PAIR_ABI, functionName: 'token0' })
  const { data: eshareT1 } = useReadContract({ address: CONTRACTS.ESHARE_LP, abi: PAIR_ABI, functionName: 'token1' })
  
  // LP Price Feeds - GGX (V3 Pool)
  const { data: ggxSlot0 } = useReadContract({ address: CONTRACTS.GGX_LP, abi: PAIR_ABI, functionName: 'slot0', query: { refetchInterval: 15000 } })
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
      refetchInterval: 15000 
    }
  })
  const { data: ggxPoolGgxBal } = useReadContract({ 
    address: CONTRACTS.GGX, 
    abi: ERC20_ABI, 
    functionName: 'balanceOf', 
    args: [CONTRACTS.GGX_LP],
    query: { 
      enabled: true,
      refetchInterval: 15000 
    }
  })

  // WETH/USDC pool for ETH price in USD
  const { data: wethUsdcSlot0 } = useReadContract({ address: CONTRACTS.WETH_USDC_LP, abi: PAIR_ABI, functionName: 'slot0', query: { refetchInterval: 30000 } })
  const { data: wethUsdcT0 } = useReadContract({ address: CONTRACTS.WETH_USDC_LP, abi: PAIR_ABI, functionName: 'token0' })

  // WETH/USDC pool balances for price calculation (more reliable than sqrtPriceX96)
  const { data: wethUsdcPoolWethBal } = useReadContract({
    address: CONTRACTS.WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [CONTRACTS.WETH_USDC_LP],
    query: { refetchInterval: 30000 }
  })
  const { data: wethUsdcPoolUsdcBal } = useReadContract({
    address: CONTRACTS.USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [CONTRACTS.WETH_USDC_LP],
    query: { refetchInterval: 30000 }
  })

  // Admin reads - Asymmetric taxes
  const { data: isPaused } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'paused' })
  const { data: mintBackingTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'mintBackingTaxBps' })
  const { data: redeemBackingTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'redeemBackingTaxBps' })
  const { data: totalMintTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalMintTaxBps' })
  const { data: totalRedeemTaxBps } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalRedeemTaxBps' })
  
  // Read total backing added (for burn calculation)
  // Burn taxes are hardcoded at 1% each, so burns ≈ backingAdded / 5 (for mint) since backing is 5%
  const { data: totalEshareBackingAdded } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalEshareBackingAdded' })
  const { data: totalRageBackingAdded } = useReadContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'totalRageBackingAdded' })
  
  // Calculate burnt amounts: burn tax is 1% each, so burns = total tokens through contract * 1%
  // Since backing is 5% on mint, burns ≈ backingAdded / 5 (rough approximation)
  // Also include legacy burns from old contracts: 0.2544 ESHARE + 0.2544 RAGE
  const OLD_BURNT_ESHARE = parseUnits('0.2544', 18) // From old contracts
  const OLD_BURNT_RAGE = parseUnits('0.2544', 18)   // From old contracts
  
  useEffect(() => {
    if (totalEshareBackingAdded && totalRageBackingAdded) {
      // More accurate: for every 100 tokens minted, 5 goes to backing, 1 gets burned
      // So burn ratio = 1/5 of backing = 20%
      setBurntAmounts({
        eshare: OLD_BURNT_ESHARE + (totalEshareBackingAdded / 5n),
        rage: OLD_BURNT_RAGE + (totalRageBackingAdded / 5n)
      })
    } else {
      // Even if no new burns, still show the old burnt amounts
      setBurntAmounts({
        eshare: OLD_BURNT_ESHARE,
        rage: OLD_BURNT_RAGE
      })
    }
  }, [totalEshareBackingAdded, totalRageBackingAdded])
  
  const { data: zapRouter } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'uniswapV3Router' })
  const { data: zapWeth } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'weth' })
  const { data: zapGgx } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'ggx' })
  const { data: zapUsdc } = useReadContract({ address: CONTRACTS.GGXZap, abi: ZAP_ABI, functionName: 'usdc' })
  
  // Zap estimates
  // Note: V3 Zap doesn't have estimate functions - would need V3 Quoter
  // For now, we show estimated output as "~" since it requires complex calculation
  
  // Allowances
  const { data: eshareAllowGGX } = useReadContract({ address: CONTRACTS.ESHARE, abi: ERC20_ABI, functionName: 'allowance', args: address ? [address, CONTRACTS.GGX] : undefined, query: { enabled: !!address, refetchInterval: 5000 } })
  const { data: rageAllowGGX } = useReadContract({ address: CONTRACTS.RAGE, abi: ERC20_ABI, functionName: 'allowance', args: address ? [address, CONTRACTS.GGX] : undefined, query: { enabled: !!address, refetchInterval: 5000 } })
  const { data: eshareAllowZap } = useReadContract({ address: CONTRACTS.ESHARE, abi: ERC20_ABI, functionName: 'allowance', args: address ? [address, CONTRACTS.GGXZap] : undefined, query: { enabled: !!address, refetchInterval: 5000 } })
  const { data: rageAllowZap } = useReadContract({ address: CONTRACTS.RAGE, abi: ERC20_ABI, functionName: 'allowance', args: address ? [address, CONTRACTS.GGXZap] : undefined, query: { enabled: !!address, refetchInterval: 5000 } })
  
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
      // Force refetch all queries immediately
      queryClient.invalidateQueries()
      // Refetch after short delays to catch block updates
      setTimeout(() => queryClient.invalidateQueries(), 1000)
      setTimeout(() => queryClient.invalidateQueries(), 3000)
      setTimeout(() => queryClient.invalidateQueries(), 5000)
    }
  }, [isConfirmed, txHash, queryClient])
  
  // Auto-refresh every 30 seconds for price data
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
  
  // Check if approval is needed
  const needsApproval = useMemo(() => {
    if (inputToken === 'ETH' || inputToken === 'GGX') return false
    if (inputToken === 'ESHARE_RAGE') {
      const eshareWei = eshareInput ? parseUnits(eshareInput, 18) : 0n
      const rageWei = rageInput ? parseUnits(rageInput, 18) : 0n
      const needsEshare = eshareWei > 0n && (!eshareAllowGGX || eshareAllowGGX < eshareWei)
      const needsRage = rageWei > 0n && (!rageAllowGGX || rageAllowGGX < rageWei)
      if (needsEshare) return 'ESHARE'
      if (needsRage) return 'RAGE'
      return false
    }
    return false
  }, [inputToken, eshareInput, rageInput, eshareAllowGGX, rageAllowGGX])
  
  // Action button text
  const actionButtonText = useMemo(() => {
    if (isLoading) return 'Confirming...'
    if (inputToken === 'GGX') {
      if (!inputAmount || parseFloat(inputAmount) === 0) return 'Enter GGX Amount'
      return 'Redeem GGX'
    }
    if (inputToken === 'ETH') {
      if (!inputAmount || parseFloat(inputAmount) === 0) return 'Enter ETH Amount'
      return 'Mint GGX'
    }
    if (inputToken === 'ESHARE_RAGE') {
      const hasEshare = eshareInput && parseFloat(eshareInput) > 0
      const hasRage = rageInput && parseFloat(rageInput) > 0
      if (!hasEshare && !hasRage) return 'Enter Amounts'
      if (needsApproval) return `Approve ${needsApproval}`
      return 'Mint GGX'
    }
    return 'Enter Amount'
  }, [inputAmount, inputToken, isLoading, needsApproval, eshareInput, rageInput])
  
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
    // Primary: Calculate from pool balances (most reliable)
    // Fallback: Calculate from sqrtPriceX96
    let ggxPrice = 0
    let ggxPair = ''
    let ggxLpExists = false
    
    // Method 1: Calculate from pool balances (most reliable for V3)
    if (ggxPoolWethBal && ggxPoolGgxBal && ggxPoolWethBal > 0n && ggxPoolGgxBal > 0n) {
      const wethInPool = parseFloat(formatUnits(ggxPoolWethBal, 18))
      const ggxInPool = parseFloat(formatUnits(ggxPoolGgxBal, 18))
      if (ggxInPool > 0 && wethInPool > 0) {
        ggxPrice = wethInPool / ggxInPool  // ETH per GGX
        ggxLpExists = true
        ggxPair = 'ETH'
      }
    }
    
    // Method 2: Fallback to sqrtPriceX96 from slot0
    if (ggxPrice === 0) {
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
  
  // Track ratio history for the chart
  useEffect(() => {
    // Track backing ratio (floor value)
    const ratioToTrack = actualBackingRatio?.total || currentRatio
    const now = Date.now()
    
    if (ratioToTrack > 0) {
      setRatioHistory(prev => {
        const newHistory = [...prev, { time: now, ratio: ratioToTrack }]
        return newHistory.slice(-200) // Keep more data for week view
      })
    }
    
    // Track price efficiency: Uniswap price / backing value
    if (priceEfficiencyRatio !== null && priceEfficiencyRatio > 0) {
      setPriceEfficiencyHistory(prev => {
        const newHistory = [...prev, { time: now, ratio: priceEfficiencyRatio }]
        return newHistory.slice(-200)
      })
    }
  }, [actualBackingRatio, currentRatio, priceEfficiencyRatio])
  
  // Estimated GGX output for ETH zap
  // Based on actual Uniswap price adjusted for zap efficiency
  const estimatedGgxFromEth = useMemo(() => {
    if (!inputAmount || prices.ggxPrice <= 0) return null
    const ethAmount = parseFloat(inputAmount)
    if (isNaN(ethAmount) || ethAmount <= 0) return null

    // Start with what you'd get on Uniswap
    const uniOutput = ethAmount / prices.ggxPrice

    // Zap is now very efficient - only ~1% difference from direct mint
    const ZAP_EFFICIENCY = 0.99

    // If ratio > 1, minting should give more than Uniswap
    if (priceEfficiencyRatio && priceEfficiencyRatio > 1) {
      const mintAdvantage = priceEfficiencyRatio * ZAP_EFFICIENCY
      return uniOutput * mintAdvantage * 0.93 // 7% mint tax
    } else {
      // If ratio <= 1, just use Uniswap-like output minus small zap costs
      return uniOutput * ZAP_EFFICIENCY * 0.93
    }
  }, [inputAmount, prices.ggxPrice, priceEfficiencyRatio])
  
  // ============ HANDLERS ============
  const handleApprove = (token: `0x${string}`, spender: `0x${string}`, amount: string) => {
    if (!amount) return
    writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, parseUnits(amount, 18)] })
  }
  
  // Main action handler - determines action based on inputToken
  const handleAction = () => {
    const minOut = 0n
    
    if (inputToken === 'GGX') {
      // Redeem GGX
      if (!inputAmount) return
      const amountWei = parseUnits(inputAmount, 18)
      writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'redeem', args: [amountWei] })
    } else if (inputToken === 'ETH') {
      // Zap from ETH (uses Zapper)
      if (!inputAmount) return
      const amountWei = parseUnits(inputAmount, 18)
      writeContract({ 
        address: CONTRACTS.GGXZap, 
        abi: ZAP_ABI, 
        functionName: 'zapFromETH', 
        args: [V3_PATHS.ETH_TO_ESHARE, V3_PATHS.ETH_TO_RAGE, minOut], 
        value: amountWei 
      })
    } else if (inputToken === 'ESHARE_RAGE') {
      // Direct mint with both ESHARE and RAGE (GGX contract, NOT Zapper)
      // Use ESHARE amount - contract takes proportional RAGE based on backing ratio
      if (!eshareInput || parseFloat(eshareInput) === 0) return
      const eshareWei = parseUnits(eshareInput, 18)
      writeContract({ 
        address: CONTRACTS.GGX, 
        abi: GGX_ABI, 
        functionName: 'mint', 
        args: [eshareWei] 
      })
    }
  }
  
  // Handle approval
  const handleApproveAction = () => {
    if (needsApproval === 'ESHARE') {
      // For ESHARE+RAGE mint, approve to GGX contract (not Zapper)
      const maxAmount = eshareBal ? formatUnits(eshareBal, 18) : eshareInput
      handleApprove(CONTRACTS.ESHARE, CONTRACTS.GGX, maxAmount)
    } else if (needsApproval === 'RAGE') {
      // For ESHARE+RAGE mint, approve to GGX contract (not Zapper)
      const maxAmount = rageBal ? formatUnits(rageBal, 18) : rageInput
      handleApprove(CONTRACTS.RAGE, CONTRACTS.GGX, maxAmount)
    }
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
  
  // Asymmetric tax handlers
  const handleSetMintBackingTax = () => {
    if (!newMintBackingTax) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'setMintBackingTaxBps', args: [BigInt(newMintBackingTax)] })
  }
  
  const handleSetRedeemBackingTax = () => {
    if (!newRedeemBackingTax) return
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'setRedeemBackingTaxBps', args: [BigInt(newRedeemBackingTax)] })
  }
  
  const handleSetBothTaxes = () => {
    if (!newMintBackingTax || !newRedeemBackingTax) return
    writeContract({ 
      address: CONTRACTS.GGX, 
      abi: GGX_ABI, 
      functionName: 'setBothBackingTaxes', 
      args: [BigInt(newMintBackingTax), BigInt(newRedeemBackingTax)] 
    })
  }
  
  const handleEmergencyWithdraw = () => {
    writeContract({ address: CONTRACTS.GGX, abi: GGX_ABI, functionName: 'emergencyWithdrawBacking', args: [] })
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
  
  const handleRescueETH = () => {
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
    <div className="min-h-screen bg-[#0A0A0B] text-white overflow-x-hidden">
      {/* Background Effects */}
      <div className="fixed inset-0 bg-mesh pointer-events-none" />
      <div className="fixed top-[-30%] right-[-20%] w-[800px] h-[800px] bg-[#FF6B35]/15 rounded-full blur-[150px] pointer-events-none" />
      <div className="fixed bottom-[-30%] left-[-20%] w-[600px] h-[600px] bg-[#3B82F6]/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="noise-overlay" />
      
      <div className="relative z-10 min-h-screen flex flex-col">
        {/* Header */}
        <header className="glass-strong border-b border-white/5 px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#FF6B35] to-[#E55A2B] flex items-center justify-center font-bold text-lg shadow-lg shadow-[#FF6B35]/20">G</div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">GGX Protocol</h1>
              </div>
              <span className="hidden sm:flex items-center gap-1 px-2 py-1 text-[10px] bg-[#3B82F6]/10 text-[#3B82F6] rounded-full border border-[#3B82F6]/20">
                <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6] animate-pulse" />
                Base
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              {isConnected ? (
                <>
                  <div className="flex items-center gap-2 px-3 py-2 bg-white/5 rounded-xl border border-white/10">
                    <div className="w-2 h-2 rounded-full bg-[#10B981]" />
                    <span className="text-sm font-mono">{address?.slice(0, 6)}...{address?.slice(-4)}</span>
                  </div>
                  {isAdmin && (
                    <button 
                      onClick={() => setShowAdmin(!showAdmin)}
                      className={`p-2 rounded-xl border transition-all ${showAdmin ? 'bg-[#F59E0B]/20 border-[#F59E0B]/30 text-[#F59E0B]' : 'bg-white/5 border-white/10 text-gray-400 hover:text-white'}`}
                    >
                      <Settings size={18} />
                    </button>
                  )}
                  <button 
                    onClick={handleRefresh}
                    className="p-2 bg-white/5 hover:bg-white/10 rounded-xl border border-white/10 transition-all"
                    title="Refresh data"
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button onClick={() => disconnect()} className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-xl border border-white/10 transition-all">Disconnect</button>
                </>
              ) : (
                <button onClick={() => connect({ connector: connectors[0] })} disabled={isConnecting} className="px-5 py-2.5 text-sm btn-primary rounded-xl font-medium disabled:opacity-50 flex items-center gap-2">
                  <Wallet size={16} /> Connect Wallet
                </button>
              )}
            </div>
          </div>
        </header>
        
        {/* Main Content */}
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-3">
          {!isConnected ? (
            <div className="flex flex-col items-center justify-center h-[calc(100vh-200px)] animate-fade-in-up">
              <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-[#FF6B35] to-[#E55A2B] flex items-center justify-center text-4xl font-bold shadow-2xl shadow-[#FF6B35]/30 animate-pulse-glow">G</div>
              <h2 className="text-3xl font-bold mt-6 mb-2"><span className="gradient-text-animated">GGX Protocol</span></h2>
              <p className="text-gray-400 text-lg mb-6">Backed by ESHARE + RAGE • Floor Only Goes Up</p>
              <div className="grid grid-cols-3 gap-4 text-center">
                {[{ label: '1:1 Backed', desc: 'ESHARE + RAGE' }, { label: '4% Tax', desc: 'Floor increases' }, { label: 'Zap Mint', desc: 'One-click GGX' }].map(({ label, desc }) => (
                  <div key={label} className="p-3 rounded-xl bg-white/5 border border-white/5">
                    <p className="font-semibold text-sm">{label}</p>
                    <p className="text-xs text-gray-500">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Main Grid */}
              <div className="grid grid-cols-12 gap-3" style={{ height: showAdmin ? 'calc(100vh - 340px)' : 'calc(100vh - 140px)' }}>
                {/* Left Column */}
                <div className="col-span-12 lg:col-span-5 flex flex-col gap-3">
                  {/* Top Row - 3 columns - larger */}
                  <div className="grid grid-cols-3 gap-2" style={{ minHeight: '130px' }}>
                    {/* Backing Ratio */}
                    <div className="stat-card rounded-xl bg-gradient-to-br from-[#FF6B35]/20 to-[#FF6B35]/5 border border-white/5 p-3">
                      <p className="text-xs text-gray-400 uppercase tracking-wider">Backing Ratio</p>
                      <p className="text-2xl font-bold font-mono gradient-text">
                        {ggxBackingValueUsd > 0 && prices.ggxPrice > 0 
                          ? (ggxBackingValueUsd / (prices.ggxPrice * prices.ethPriceUsd)).toFixed(4)
                          : formatRatio(backingRatio?.[0] && backingRatio?.[1] ? (backingRatio[0] + backingRatio[1]) : undefined)}
                      </p>
                      <p className="text-[10px] text-[#10B981] flex items-center gap-1">
                        <TrendingUp size={10} /> {formatRatio(backingRatio?.[0])} ES + {formatRatio(backingRatio?.[1])} RA
                      </p>
                      {ggxBackingValueUsd > 0 && (
                        <p className="text-[10px] text-gray-400">≈ ${formatPrice(ggxBackingValueUsd)}/GGX</p>
                      )}
                      {/* Protocol TVL */}
                      {backingBalances && prices.ethPriceUsd > 0 && (
                        <div className="mt-1 pt-1 border-t border-white/10">
                          <p className="text-[10px] text-gray-400">Protocol TVL</p>
                          <p className="text-sm font-semibold text-[#FFD700]">
                            ${formatPrice((
                              // ESHARE backing value (priced in ETH, convert to USD)
                              parseFloat(formatUnits(backingBalances[0], 18)) * prices.esharePrice * prices.ethPriceUsd +
                              // RAGE backing value (already in USDC/USD terms)
                              parseFloat(formatUnits(backingBalances[1], 18)) * prices.ragePrice +
                              // ETH in GGX-ETH V3 pool
                              (ggxPoolWethBal ? parseFloat(formatUnits(ggxPoolWethBal, 18)) : 0) * prices.ethPriceUsd
                            ))}
                          </p>
                        </div>
                      )}
                    </div>
                    
                    {/* GGX Supply */}
                    <div className="stat-card rounded-xl bg-gradient-to-br from-[#3B82F6]/20 to-[#3B82F6]/5 border border-white/5 p-3">
                      <div className="flex justify-between items-start">
                        <p className="text-xs text-gray-400 uppercase tracking-wider">GGX Supply</p>
                        {isPaused && <span className="text-[9px] text-[#EF4444] font-semibold">PAUSED</span>}
                      </div>
                      <p className="text-2xl font-bold font-mono">{formatNum(ggxSupply)}</p>
                      <div className="mt-1 pt-1 border-t border-white/10">
                        <p className="text-[10px] text-gray-400">GGX Price</p>
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
                      <a 
                        href={`https://app.uniswap.org/swap?inputCurrency=ETH&outputCurrency=${CONTRACTS.GGX}&chain=base`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 pt-1 border-t border-white/10 flex items-center justify-between text-[10px] transition-colors"
                      >
                        <span className="text-[#FFD700] hover:text-[#FFA500] flex items-center gap-0.5">
                          Swap <ArrowUpRight size={10} />
                        </span>
                      </a>
                    </div>
                    
                    {/* Combined ESHARE & RAGE Backing */}
                    <div className="relative group">
                      <div className="absolute inset-0 bg-gradient-to-br from-[#8B5CF6]/30 to-[#EF4444]/30 rounded-xl opacity-30 blur-lg" />
                      <div className="relative stat-card rounded-xl bg-gradient-to-br from-white/10 to-white/5 border border-white/5 p-3 h-full">
                        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Protocol Backing</p>
                        
                        {/* ESHARE Row */}
                        <div className="flex items-center justify-between mb-1 pb-1 border-b border-white/5">
                          <div className="flex items-center gap-1">
                            <div className="w-5 h-5 rounded bg-gradient-to-br from-[#8B5CF6] to-[#EC4899] flex items-center justify-center text-[8px] font-bold text-black">ES</div>
                            <span className="text-xs font-semibold text-[#8B5CF6]">ESHARE</span>
                          </div>
                          <span className="text-base font-semibold">{backingBalances ? formatNum(backingBalances[0]) : '—'}</span>
                        </div>
                        
                        {/* RAGE Row */}
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-1">
                            <div className="w-5 h-5 rounded bg-gradient-to-br from-[#EF4444] to-[#F97316] flex items-center justify-center text-[8px] font-bold text-black">RA</div>
                            <span className="text-xs font-semibold text-[#EF4444]">RAGE</span>
                          </div>
                          <span className="text-base font-semibold">{backingBalances ? formatNum(backingBalances[1]) : '—'}</span>
                        </div>
                        
                        {/* Burnt Section */}
                        <div className="mt-2 pt-2 border-t border-white/10">
                          <p className="text-[10px] text-gray-500 text-center mb-1">🔥 Burnt by taxes</p>
                          <div className="flex justify-center gap-4 text-xs">
                            <div className="flex items-center gap-1">
                              <div className="w-4 h-4 rounded bg-gradient-to-br from-[#8B5CF6] to-[#EC4899] flex items-center justify-center text-[6px] font-bold text-black">ES</div>
                              <span className="text-[#8B5CF6] font-semibold">{burntAmounts.eshare > 0n ? formatNum(burntAmounts.eshare) : '—'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <div className="w-4 h-4 rounded bg-gradient-to-br from-[#EF4444] to-[#F97316] flex items-center justify-center text-[6px] font-bold text-black">RA</div>
                              <span className="text-[#EF4444] font-semibold">{burntAmounts.rage > 0n ? formatNum(burntAmounts.rage) : '—'}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Ratio Chart with Time Range Buttons - grows to match mint/redeem box */}
                  <div className="flex-1 card rounded-xl p-3 flex flex-col">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <h3 className="text-xs font-semibold flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-[#10B981]"></span>
                          Price Efficiency (Uni vs Mint)
                        </h3>
                        {priceEfficiencyRatio !== null && (
                          <p className={`text-sm font-bold ml-3.5 ${priceEfficiencyRatio < 1 ? 'text-[#10B981] animate-pulse' : 'text-[#F97316]'}`}>
                            Uni/Mint: {priceEfficiencyRatio.toFixed(3)}
                          </p>
                        )}
                      </div>
                      {/* Time Range Buttons */}
                      <div className="flex gap-1">
                        {(['4h', '1d', '1w'] as TimeRange[]).map((range) => (
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
                    <div className="flex-1 min-h-[150px]">
                      <RatioChart history={ratioHistory} priceEfficiencyHistory={priceEfficiencyHistory} timeRange={timeRange} currentRatio={priceEfficiencyRatio} />
                    </div>
                    {/* Legend explanation */}
                    <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-center gap-4 text-[9px] text-gray-500 flex-wrap">
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-[#10B981]/40"></span> &lt;0.97 = BUY UNI</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-[#06B6D4]/40"></span> 1.01+ = MINT</span>
                    </div>
                  </div>
                </div>

                {/* Right Column - Unified Action Box */}
                <div className="col-span-12 lg:col-span-7 flex flex-col gap-3">
                  <div className="flex-1 card rounded-xl p-4 overflow-auto">
                    <div className="space-y-3">
                      {/* Header */}
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">Mint / Redeem</h3>
                        {/* Action Recommendation */}
                        {priceEfficiencyRatio !== null ? (
                          inputToken === 'GGX' ? (
                            // EXIT mode recommendations
                            <span className={"text-[10px] px-2 py-1 rounded-full font-semibold " + (priceEfficiencyRatio >= 1.03 ? "bg-[#F97316]/20 text-[#F97316] border border-[#F97316]/30" : "bg-[#A855F7]/20 text-[#A855F7] border border-[#A855F7]/30")}>
                              {priceEfficiencyRatio >= 1.03 ? "SELL UNI" : "REDEEM"}
                            </span>
                          ) : (
                            // ACQUIRE mode recommendations
                            <span className={
                              priceEfficiencyRatio >= 1.01
                                ? "text-[10px] px-2 py-1 rounded-full font-semibold bg-[#06B6D4]/20 text-[#06B6D4] border border-[#06B6D4]/30"
                                : "text-[10px] px-2 py-1 rounded-full font-semibold bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/30"
                            }>
                              {priceEfficiencyRatio >= 1.01 ? "MINT" : "BUY UNI"}
                            </span>
                          )
                        ) : (
                          <span className={"text-[10px] px-2 py-0.5 rounded-full " + (inputToken === "GGX" ? "bg-[#A855F7]/20 text-[#A855F7]" : "bg-[#10B981]/20 text-[#10B981]")}>
                            {inputToken === "GGX" ? "Redeem" : "Mint"}
                          </span>
                        )}
                      </div>
                      
                      {/* Token Selector Buttons */}
                      <div className="flex gap-2">
                        <button 
                          onClick={() => { setInputToken('ETH'); setInputAmount(''); setEshareInput(''); setRageInput(''); }}
                          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1 ${
                            inputToken === 'ETH' 
                              ? 'bg-[#FF6B35] text-white' 
                              : 'bg-white/5 text-gray-400 hover:text-white border border-white/10'
                          }`}
                        >
                          <Zap size={12} /> ETH
                        </button>
                        <button 
                          onClick={() => { setInputToken('ESHARE_RAGE'); setInputAmount(''); setEshareInput(''); setRageInput(''); }}
                          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                            inputToken === 'ESHARE_RAGE' 
                              ? 'bg-[#8B5CF6] text-white' 
                              : 'bg-white/5 text-gray-400 hover:text-white border border-white/10'
                          }`}
                        >
                          ESHARE + RAGE
                        </button>
                        <button 
                          onClick={() => { setInputToken('GGX'); setInputAmount(''); setEshareInput(''); setRageInput(''); }}
                          className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
                            inputToken === 'GGX' 
                              ? 'bg-[#3B82F6] text-white' 
                              : 'bg-white/5 text-gray-400 hover:text-white border border-white/10'
                          }`}
                        >
                          GGX
                        </button>
                      </div>
                      
                      {/* Input Section */}
                      <div className="mt-16">
                      {inputToken === 'ESHARE_RAGE' ? (
                        // Dual input for ESHARE + RAGE with auto-sync based on backing ratio
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <div className="flex-1 bg-[#8B5CF6]/10 rounded-lg p-2 border border-[#8B5CF6]/20">
                              <div className="flex justify-between items-center mb-1">
                                <span className="text-[10px] text-[#8B5CF6] font-medium">ESHARE</span>
                                <button 
                                  onClick={() => {
                                    if (eshareBal) {
                                      // Round down to 6 decimal places to avoid precision issues
                                      const rawBalance = parseFloat(formatUnits(eshareBal, 18))
                                      const roundedDown = Math.floor(rawBalance * 1000000) / 1000000
                                      setEshareInput(roundedDown.toString())
                                      // Auto-populate RAGE based on backing ratio
                                      if (backingRatio && backingRatio[0] && backingRatio[1]) {
                                        const esharePerGGX = parseFloat(formatUnits(backingRatio[0], 18))
                                        const ragePerGGX = parseFloat(formatUnits(backingRatio[1], 18))
                                        if (esharePerGGX > 0) {
                                          const ratio = ragePerGGX / esharePerGGX
                                          const rageAmount = roundedDown * ratio
                                          // Also round down the RAGE amount
                                          const rageRounded = Math.floor(rageAmount * 1000000) / 1000000
                                          setRageInput(rageRounded.toString())
                                        }
                                      }
                                    }
                                  }}
                                  className="text-[9px] text-[#8B5CF6] hover:opacity-80"
                                >
                                  MAX
                                </button>
                              </div>
                              <input 
                                type="number" 
                                value={eshareInput} 
                                onChange={(e) => {
                                  const val = e.target.value
                                  setEshareInput(val)
                                  // Auto-populate RAGE based on backing ratio
                                  if (backingRatio && backingRatio[0] && backingRatio[1]) {
                                    const esharePerGGX = parseFloat(formatUnits(backingRatio[0], 18))
                                    const ragePerGGX = parseFloat(formatUnits(backingRatio[1], 18))
                                    const numVal = parseFloat(val)
                                    if (esharePerGGX > 0 && !isNaN(numVal) && numVal > 0) {
                                      const ratio = ragePerGGX / esharePerGGX
                                      const rageAmount = numVal * ratio
                                      // Round down to avoid simulation errors
                                      const rageRounded = Math.floor(rageAmount * 1000000) / 1000000
                                      setRageInput(rageRounded.toString())
                                    }
                                  }
                                }} 
                                placeholder="0.00" 
                                className="w-full bg-transparent text-base font-mono focus:outline-none" 
                              />
                            </div>
                            <div className="flex-1 bg-[#EF4444]/10 rounded-lg p-2 border border-[#EF4444]/20">
                              <div className="flex justify-between items-center mb-1">
                                <span className="text-[10px] text-[#EF4444] font-medium">RAGE</span>
                                <button 
                                  onClick={() => {
                                    if (rageBal) {
                                      // Round down to 6 decimal places to avoid precision issues
                                      const rawBalance = parseFloat(formatUnits(rageBal, 18))
                                      const roundedDown = Math.floor(rawBalance * 1000000) / 1000000
                                      setRageInput(roundedDown.toString())
                                      // Auto-populate ESHARE based on backing ratio
                                      if (backingRatio && backingRatio[0] && backingRatio[1]) {
                                        const esharePerGGX = parseFloat(formatUnits(backingRatio[0], 18))
                                        const ragePerGGX = parseFloat(formatUnits(backingRatio[1], 18))
                                        if (ragePerGGX > 0) {
                                          const ratio = esharePerGGX / ragePerGGX
                                          const eshareAmount = roundedDown * ratio
                                          // Also round down the ESHARE amount
                                          const eshareRounded = Math.floor(eshareAmount * 1000000) / 1000000
                                          setEshareInput(eshareRounded.toString())
                                        }
                                      }
                                    }
                                  }}
                                  className="text-[9px] text-[#EF4444] hover:opacity-80"
                                >
                                  MAX
                                </button>
                              </div>
                              <input 
                                type="number" 
                                value={rageInput} 
                                onChange={(e) => {
                                  const val = e.target.value
                                  setRageInput(val)
                                  // Auto-populate ESHARE based on backing ratio
                                  if (backingRatio && backingRatio[0] && backingRatio[1]) {
                                    const esharePerGGX = parseFloat(formatUnits(backingRatio[0], 18))
                                    const ragePerGGX = parseFloat(formatUnits(backingRatio[1], 18))
                                    const numVal = parseFloat(val)
                                    if (ragePerGGX > 0 && !isNaN(numVal) && numVal > 0) {
                                      const ratio = esharePerGGX / ragePerGGX
                                      const eshareAmount = numVal * ratio
                                      // Round down to avoid simulation errors
                                      const eshareRounded = Math.floor(eshareAmount * 1000000) / 1000000
                                      setEshareInput(eshareRounded.toString())
                                    }
                                  }
                                }} 
                                placeholder="0.00" 
                                className="w-full bg-transparent text-base font-mono focus:outline-none" 
                              />
                            </div>
                          </div>
                          <p className="text-[10px] text-gray-500 text-center">
                            Inputs auto-sync based on backing ratio ({formatRatio(backingRatio?.[0])} ESHARE : {formatRatio(backingRatio?.[1])} RAGE)
                          </p>
                        </div>
                      ) : (
                        // Single input for ETH or GGX
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <div className="bg-white/10 rounded-lg px-3 py-2.5 text-sm font-medium flex items-center gap-2">
                              {inputToken === 'ETH' && <span className="text-[#FF6B35]">ETH</span>}
                              {inputToken === 'GGX' && <span className="text-[#3B82F6]">GGX</span>}
                            </div>
                            
                            <div className="flex-1 relative bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                              <input 
                                type="number" 
                                value={inputAmount} 
                                onChange={(e) => setInputAmount(e.target.value)} 
                                placeholder="0.00" 
                                className="w-full bg-transparent text-base font-mono focus:outline-none" 
                              />
                              <button 
                                onClick={() => {
                                  // For GGX redeem, round down to avoid failed transactions
                                  if (inputToken === 'GGX' && ggxBal) {
                                    const rawBalance = parseFloat(formatUnits(ggxBal, 18))
                                    // Round down to 6 decimal places to avoid precision issues
                                    const roundedDown = Math.floor(rawBalance * 1000000) / 1000000
                                    setInputAmount(roundedDown.toString())
                                  } else {
                                    setInputAmount(selectedBalance.toString())
                                  }
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#FF6B35] hover:text-[#FF8A5C] font-medium"
                              >
                                MAX
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                      </div>

                      {/* Output Preview - Consistent spacing */}
                      <div className="mt-4">
                      {inputToken === 'GGX' ? (
                        // Redeem output
                        redeemOutput ? (
                          <div className="bg-white/5 rounded-lg p-3 space-y-2">
                            <p className="text-xs text-gray-400">You Receive</p>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="bg-[#8B5CF6]/10 rounded-lg p-2 border border-[#8B5CF6]/20">
                                <p className="text-[10px] text-gray-400">ESHARE</p>
                                <p className="text-sm font-semibold text-[#8B5CF6]">{formatNum(redeemOutput[0])}</p>
                              </div>
                              <div className="bg-[#EF4444]/10 rounded-lg p-2 border border-[#EF4444]/20">
                                <p className="text-[10px] text-gray-400">RAGE</p>
                                <p className="text-sm font-semibold text-[#EF4444]">{formatNum(redeemOutput[1])}</p>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="bg-white/5 rounded-lg px-3 py-3">
                            <p className="text-xs text-gray-400">You Receive</p>
                            <p className="text-sm font-semibold text-[#10B981]">—</p>
                          </div>
                        )
                      ) : (
                        // Mint output
                        <div className="bg-white/5 rounded-lg px-3 py-3">
                          <p className="text-xs text-gray-400">You Receive (est.)</p>
                          <p className="text-sm font-semibold text-[#10B981]">
                            {inputToken === 'ESHARE_RAGE' && mintOutputEshare && `~ ${formatNum(mintOutputEshare)} GGX`}
                            {inputToken === 'ESHARE_RAGE' && !mintOutputEshare && '~ GGX'}
                            {inputToken === 'ETH' && estimatedGgxFromEth && `~ ${estimatedGgxFromEth.toFixed(4)} GGX`}
                            {inputToken === 'ETH' && !estimatedGgxFromEth && '~ GGX'}
                          </p>
                        </div>
                      )}
                      </div>
                      
                      {/* V3 Route Info for ETH - removed as requested */}
                      
                      {/* All Balances */}
                      <div className="grid grid-cols-4 gap-1 text-xs">
                        <div className="bg-white/5 rounded-lg p-2 text-center">
                          <p className="text-[10px] text-gray-400">ETH</p>
                          <p className="font-mono text-xs">{ethBal ? parseFloat(formatUnits(ethBal.value, ethBal.decimals)).toFixed(6) : '0.000000'}</p>
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 text-center">
                          <p className="text-[10px] text-[#8B5CF6]">ESHARE</p>
                          <p className="font-mono text-xs">{formatNum(eshareBal)}</p>
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 text-center">
                          <p className="text-[10px] text-[#EF4444]">RAGE</p>
                          <p className="font-mono text-xs">{formatNum(rageBal)}</p>
                        </div>
                        <div className="bg-white/5 rounded-lg p-2 text-center">
                          <p className="text-[10px] text-[#FF6B35]">GGX</p>
                          <p className="font-mono text-xs">{formatNum(ggxBal)}</p>
                        </div>
                      </div>
                      
                      {/* Action Button */}
                      <button 
                        onClick={needsApproval ? handleApproveAction : handleAction} 
                        disabled={
                          isLoading || 
                          (inputToken === 'GGX' && (!inputAmount || parseFloat(inputAmount) === 0)) ||
                          (inputToken === 'ETH' && (!inputAmount || parseFloat(inputAmount) === 0)) ||
                          (inputToken === 'ESHARE_RAGE' && 
                            (!eshareInput || parseFloat(eshareInput) === 0) && 
                            (!rageInput || parseFloat(rageInput) === 0))
                        } 
                        className={`w-full py-3 rounded-lg text-sm font-semibold transition-all disabled:opacity-50 ${
                          needsApproval 
                            ? 'bg-[#8B5CF6] hover:bg-[#8B5CF6]/80' 
                            : inputToken === 'GGX'
                              ? 'bg-[#3B82F6] hover:bg-[#3B82F6]/80'
                              : 'btn-primary'
                        }`}
                      >
                        {actionButtonText}
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between text-[10px] text-gray-500 px-1">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#10B981]" />7% Mint Tax</span>
                      <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6]" />3% Redeem Tax</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <a href="#" className="flex items-center gap-1 hover:text-white transition-colors"><MessageCircle size={10} /> Telegram</a>
                      <a href="#" className="flex items-center gap-1 hover:text-white transition-colors"><FileText size={10} /> Docs</a>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Admin Console */}
              {isAdmin && showAdmin && (
                <div className="border border-[#F59E0B]/20 rounded-xl bg-gradient-to-br from-[#F59E0B]/5 to-transparent overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2 bg-[#F59E0B]/10 border-b border-[#F59E0B]/20">
                    <div className="flex items-center gap-2">
                      <Shield size={14} className="text-[#F59E0B]" />
                      <span className="text-sm font-semibold text-[#F59E0B]">Admin Console</span>
                    </div>
                    <span className="text-[10px] text-[#F59E0B]/60">Owner: {address?.slice(0, 6)}...{address?.slice(-4)}</span>
                  </div>
                  
                  <div className="p-3">
                    <div className="flex gap-1 mb-3">
                      {(['ggx', 'zap', 'rescue'] as const).map((t) => (
                        <button key={t} onClick={() => setAdminTab(t)} className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${adminTab === t ? 'bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/30' : 'text-gray-500 hover:text-white bg-white/5'}`}>
                          {t === 'ggx' ? 'GGX Controls' : t === 'zap' ? 'Zap Controls' : 'Emergency'}
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
                          <p className="text-[9px] text-gray-500">Status: {isPaused ? '🔴 Paused' : '🟢 Active'}</p>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-gray-400 uppercase">GGX Per Pair</p>
                          <input type="number" value={newRatio} onChange={(e) => setNewRatio(e.target.value)} placeholder={ggxPerPair ? formatRatio(ggxPerPair) : '1.0'} className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleSetRatio} disabled={!newRatio || isLoading} className="w-full py-1 text-[10px] bg-[#F59E0B]/20 text-[#F59E0B] rounded border border-[#F59E0B]/30 disabled:opacity-50">Update</button>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-[#10B981] uppercase">Mint Backing Tax (BPS)</p>
                          <input type="number" value={newMintBackingTax} onChange={(e) => setNewMintBackingTax(e.target.value)} placeholder={mintBackingTaxBps?.toString() || '500'} className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleSetMintBackingTax} disabled={!newMintBackingTax || isLoading} className="w-full py-1 text-[10px] bg-[#10B981]/20 text-[#10B981] rounded border border-[#10B981]/30 disabled:opacity-50">Set</button>
                          <p className="text-[9px] text-gray-500">Current: {mintBackingTaxBps?.toString() || '500'} (min 100, max 1000)</p>
                        </div>
                        
                        <div className="bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-[#EF4444] uppercase">Redeem Backing Tax (BPS)</p>
                          <input type="number" value={newRedeemBackingTax} onChange={(e) => setNewRedeemBackingTax(e.target.value)} placeholder={redeemBackingTaxBps?.toString() || '100'} className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={handleSetRedeemBackingTax} disabled={!newRedeemBackingTax || isLoading} className="w-full py-1 text-[10px] bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50">Set</button>
                          <p className="text-[9px] text-gray-500">Current: {redeemBackingTaxBps?.toString() || '100'} (min 0, max 1000)</p>
                        </div>
                        
                        <div className="col-span-2 bg-white/5 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-gray-400 uppercase">Set Both Backing Taxes</p>
                          <div className="flex gap-2">
                            <input type="number" value={newMintBackingTax} onChange={(e) => setNewMintBackingTax(e.target.value)} placeholder="Mint BPS" className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                            <input type="number" value={newRedeemBackingTax} onChange={(e) => setNewRedeemBackingTax(e.target.value)} placeholder="Redeem BPS" className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          </div>
                          <button onClick={handleSetBothTaxes} disabled={isLoading} className="w-full py-1 text-[10px] bg-[#F59E0B]/20 text-[#F59E0B] rounded border border-[#F59E0B]/30 disabled:opacity-50">Apply Both Taxes</button>
                        </div>
                        
                        <div className="col-span-2 bg-[#EF4444]/10 border border-[#EF4444]/20 rounded-lg p-2 space-y-2">
                          <p className="text-[10px] text-[#EF4444] uppercase font-semibold">⚠️ Emergency Withdraw</p>
                          <p className="text-[9px] text-gray-400">Withdraw ALL backing tokens to owner. Use with caution!</p>
                          <button onClick={handleEmergencyWithdraw} disabled={isLoading} className="w-full py-1.5 text-[10px] bg-[#EF4444]/30 text-[#EF4444] rounded border border-[#EF4444]/40 disabled:opacity-50">Emergency Withdraw All Backing</button>
                        </div>
                        
                        <div className="col-span-2 bg-white/5 rounded-lg p-2 space-y-1">
                          <p className="text-[10px] text-gray-400 uppercase">Current Tax Summary</p>
                          <div className="grid grid-cols-2 gap-1 text-[9px]">
                            <div className="bg-[#10B981]/10 rounded p-1">
                              <span className="text-[#10B981]">Mint:</span> {totalMintTaxBps?.toString() || '700'} BPS (7%)
                            </div>
                            <div className="bg-[#EF4444]/10 rounded p-1">
                              <span className="text-[#EF4444]">Redeem:</span> {totalRedeemTaxBps?.toString() || '300'} BPS (3%)
                            </div>
                          </div>
                          <p className="text-[9px] text-gray-500">Burn taxes are hardcoded at 1% each</p>
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
                          <p className="text-[10px] text-gray-400 uppercase">GGX Address</p>
                          <p className="text-[10px] font-mono text-white break-all">{zapGgx ? `${zapGgx.slice(0, 6)}...${zapGgx.slice(-4)}` : '—'}</p>
                          <p className="text-[9px] text-gray-500 mt-1">Expected: {CONTRACTS.GGX.slice(0, 6)}...{CONTRACTS.GGX.slice(-4)}</p>
                          {zapGgx && zapGgx.toLowerCase() !== CONTRACTS.GGX.toLowerCase() && (
                            <p className="text-[9px] text-[#EF4444]">⚠️ Mismatch!</p>
                          )}
                        </div>
                        <div className="col-span-2 lg:col-span-4 bg-[#10B981]/10 border border-[#10B981]/20 rounded-lg p-3">
                          <p className="text-xs text-[#10B981] font-medium">✅ V3 Zap Active</p>
                          <p className="text-[10px] text-gray-400 mt-1">Multi-hop routing enabled via V3 pools:</p>
                          <ul className="text-[10px] text-gray-400 mt-1 list-disc list-inside space-y-0.5">
                            <li>ETH → ESHARE: Direct via WETH/ESHARE pool ({POOL_FEES.WETH_ESHARE/10000}% fee)</li>
                            <li>ETH → RAGE: WETH → USDC → RAGE ({POOL_FEES.WETH_USDC/10000}% + {POOL_FEES.USDC_RAGE/10000}% fees)</li>
                          </ul>
                        </div>
                      </div>
                    )}
                    
                    {adminTab === 'rescue' && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="bg-[#EF4444]/5 border border-[#EF4444]/20 rounded-lg p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <AlertTriangle size={14} className="text-[#EF4444]" />
                            <p className="text-xs font-semibold text-[#EF4444]">Rescue Token from GGX</p>
                          </div>
                          <input type="text" value={rescueToken} onChange={(e) => setRescueToken(e.target.value)} placeholder="Token Address" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <input type="number" value={rescueAmount} onChange={(e) => setRescueAmount(e.target.value)} placeholder="Amount (wei)" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <button onClick={() => handleRescueToken('ggx')} disabled={!rescueToken || !rescueAmount || isLoading} className="w-full py-2 text-xs bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50 flex items-center justify-center gap-1"><Trash2 size={12} /> Rescue</button>
                          <p className="text-[10px] text-gray-500">Cannot rescue ESHARE or RAGE (backing tokens)</p>
                        </div>
                        
                        <div className="bg-[#EF4444]/5 border border-[#EF4444]/20 rounded-lg p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <AlertTriangle size={14} className="text-[#EF4444]" />
                            <p className="text-xs font-semibold text-[#EF4444]">Rescue from GGXZap</p>
                          </div>
                          <input type="text" value={rescueToken} onChange={(e) => setRescueToken(e.target.value)} placeholder="Token Address (or leave empty for ETH)" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <input type="number" value={rescueAmount} onChange={(e) => setRescueAmount(e.target.value)} placeholder="Amount (wei)" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs" />
                          <div className="flex gap-1">
                            <button onClick={() => handleRescueToken('zap')} disabled={!rescueToken || !rescueAmount || isLoading} className="flex-1 py-2 text-xs bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50 flex items-center justify-center gap-1"><Trash2 size={12} /> Token</button>
                            <button onClick={handleRescueETH} disabled={isLoading} className="flex-1 py-2 text-xs bg-[#EF4444]/20 text-[#EF4444] rounded border border-[#EF4444]/30 disabled:opacity-50 flex items-center justify-center gap-1"><DollarSign size={12} /> ETH</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
