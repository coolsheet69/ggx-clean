# GGX Protocol Dashboard

Frontend dashboard for GGX Protocol on Base Mainnet.

## Stack

- Next.js 16 / React 19
- Tailwind CSS v4
- wagmi + viem (Base Mainnet, wallet connect)
- shadcn/ui components
- Recharts (data viz)

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Deploy

Recommended: **Vercel** (zero-config for Next.js)

1. Push this repo to GitHub
2. Import into Vercel
3. Deploy — no environment variables required for basic operation

## Contract Addresses (Base Mainnet)

| Contract   | Address |
|------------|---------|
| GGX Token  | `0x483e1E0c3faA7b901d3FFa7a201efD1328309f9d` |
| GGXU Token | `0xedB6A71e10A2Cc3D8bC3f992a1fb8F1e7da0D490` |
| Boardroom  | `0x3Cdf4434aef68E2790f7b130E6CE6053Bcc61FBE` |
| Farm       | `0xcEBcA374c60877AE2131bDA5E5b34AC280d0381b` |

> LP token addresses in `src/app/config.ts` are placeholders — update after creating pools on Uniswap.

## Notes

- `src/lib/db.ts` removed — Prisma was scaffolded but unused
- RPC defaults to public Base endpoint; swap in a private RPC via `src/lib/wagmi.ts` for production load
